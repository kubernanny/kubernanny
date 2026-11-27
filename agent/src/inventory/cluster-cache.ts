import { Keyed, WatchApi, WatchCache, WatchEventType } from '../kube/watch-cache';
import { Logger } from '../logger';
import {
  eventTime,
  stripCronJob,
  stripEvent,
  stripJob,
  stripNode,
  stripPlain,
  stripPod,
  stripService,
  stripWorkload,
} from './strip';

/** The inventory kinds kept by watches. */
export const WATCHED_KINDS = [
  'nodes',
  'pods',
  'namespaces',
  'deployments',
  'statefulsets',
  'daemonsets',
  'jobs',
  'cronjobs',
  'services',
  'ingresses',
  'pvcs',
  'storageClasses',
  'events',
] as const;
export type WatchedKind = (typeof WATCHED_KINDS)[number];

/** Warning events kept: the newest this many, none older than EVENT_MAX_AGE_MS (Kubernetes itself keeps them an hour by default). */
export const EVENT_MAX_ITEMS = 2000;
export const EVENT_MAX_AGE_MS = 6 * 3600_000;

const SPECS: Record<WatchedKind, { path: string; strip(o: unknown): Keyed }> = {
  nodes: { path: '/api/v1/nodes', strip: stripNode as unknown as (o: unknown) => Keyed },
  pods: { path: '/api/v1/pods', strip: stripPod as unknown as (o: unknown) => Keyed },
  namespaces: { path: '/api/v1/namespaces', strip: stripPlain as unknown as (o: unknown) => Keyed },
  deployments: { path: '/apis/apps/v1/deployments', strip: stripWorkload as unknown as (o: unknown) => Keyed },
  statefulsets: { path: '/apis/apps/v1/statefulsets', strip: stripWorkload as unknown as (o: unknown) => Keyed },
  daemonsets: { path: '/apis/apps/v1/daemonsets', strip: stripWorkload as unknown as (o: unknown) => Keyed },
  jobs: { path: '/apis/batch/v1/jobs', strip: stripJob as unknown as (o: unknown) => Keyed },
  cronjobs: { path: '/apis/batch/v1/cronjobs', strip: stripCronJob as unknown as (o: unknown) => Keyed },
  services: { path: '/api/v1/services', strip: stripService as unknown as (o: unknown) => Keyed },
  ingresses: { path: '/apis/networking.k8s.io/v1/ingresses', strip: stripPlain as unknown as (o: unknown) => Keyed },
  pvcs: { path: '/api/v1/persistentvolumeclaims', strip: stripPlain as unknown as (o: unknown) => Keyed },
  storageClasses: {
    path: '/apis/storage.k8s.io/v1/storageclasses',
    strip: stripPlain as unknown as (o: unknown) => Keyed,
  },
  events: {
    path: '/api/v1/events?fieldSelector=type%3DWarning',
    strip: stripEvent as unknown as (o: unknown) => Keyed,
  },
};

type AnyObj = Keyed & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BAD_WAITING = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'CreateContainerConfigError',
  'CreateContainerError',
  'InvalidImageName',
  'RunContainerError',
]);

/** What about a pod the checks judge: ready, phase, why a container waits or died. */
function podSignature(p: AnyObj | undefined): string {
  if (!p) {
    return '';
  }
  const statuses = [...(p.status?.containerStatuses ?? []), ...(p.status?.initContainerStatuses ?? [])] as AnyObj[];
  const reasons = statuses.map((c) => {
    const waiting = c.state?.waiting?.reason;
    const terminated = c.lastState?.terminated?.reason === 'OOMKilled' ? 'OOMKilled' : '';
    return `${c.ready ? 1 : 0}${BAD_WAITING.has(waiting) ? waiting : ''}${terminated}`;
  });
  const ready = (p.status?.conditions as AnyObj[] | undefined)?.find((c) => c.type === 'Ready')?.status;
  return `${p.status?.phase}|${ready}|${reasons.join(',')}`;
}

function nodeSignature(n: AnyObj | undefined): string {
  if (!n) {
    return '';
  }
  const conditions = ((n.status?.conditions ?? []) as AnyObj[]).map((c) => `${c.type}=${c.status}`).sort();
  return `${n.spec?.unschedulable ? 'cordoned' : ''}|${conditions.join(',')}`;
}

function workloadSignature(w: AnyObj | undefined): string {
  if (!w) {
    return '';
  }
  const s = w.status ?? {};
  const desired = w.spec?.replicas ?? s.desiredNumberScheduled ?? 0;
  const ready = s.readyReplicas ?? s.numberReady ?? 0;
  // Whether it is short of replicas, and whether it has none: what turns an issue on or off.
  return `${ready >= desired}|${ready === 0}`;
}

/**
 * Whether a change can open or close an issue, so it is worth a run before
 * the next interval: a pod going into CrashLoopBackOff, a node going
 * NotReady, a workload losing (or regaining) its replicas, a volume or job
 * failing. Ordinary churn (a pod restarting its timer, status heartbeats,
 * new events) is not.
 */
export function isRelevantChange(
  kind: WatchedKind,
  type: WatchEventType,
  prev: AnyObj | undefined,
  next: AnyObj | undefined,
): boolean {
  switch (kind) {
    case 'pods':
      // A pod appearing healthy or vanishing changes nothing a check reports on its own; its workload does.
      if (type !== 'MODIFIED') {
        return type === 'ADDED' ? podSignature(next).includes('Back') : false;
      }
      return podSignature(prev) !== podSignature(next);
    case 'nodes':
      return type !== 'MODIFIED' || nodeSignature(prev) !== nodeSignature(next);
    case 'deployments':
    case 'statefulsets':
    case 'daemonsets':
      return type === 'MODIFIED' && workloadSignature(prev) !== workloadSignature(next);
    case 'pvcs':
      return type === 'MODIFIED' && prev?.status?.phase !== next?.status?.phase;
    case 'jobs': {
      const failed = (j: AnyObj | undefined) =>
        ((j?.status?.conditions ?? []) as AnyObj[]).some((c) => c.type === 'Failed' && c.status === 'True');
      return failed(prev) !== failed(next);
    }
    default:
      return false;
  }
}

export interface ClusterCacheOptions {
  /** Called on a change worth an early run (debounced by the caller). */
  onRelevantChange?(kind: WatchedKind): void;
  resyncMs?: number;
}

/**
 * The watch caches behind the inventory: one per watched kind, started once
 * and kept until the agent stops. Kinds that are not watched (API discovery,
 * the version, metrics.k8s.io, which cannot be watched, and the Gateway API
 * and Traefik CRDs) are still listed on every run.
 */
/** `namespace/name` of a pod. */
export function podKey(namespace: string | undefined, name: string): string {
  return `${namespace ?? ''}/${name}`;
}

export class ClusterCache {
  private readonly caches = new Map<WatchedKind, WatchCache<Keyed>>();
  /**
   * When each pod began shutting down (its deletionTimestamp, ms), kept as long as warning events
   * are: a pod is gone from the cache seconds later, its last events stay for hours.
   */
  private readonly shutdowns = new Map<string, number>();
  private readonly logger = new Logger('watch');
  private started = false;

  constructor(
    api: WatchApi,
    private readonly options: ClusterCacheOptions = {},
  ) {
    for (const kind of WATCHED_KINDS) {
      const spec = SPECS[kind];
      this.caches.set(
        kind,
        new WatchCache<Keyed>(api, {
          kind,
          path: spec.path,
          strip: spec.strip,
          resyncMs: options.resyncMs,
          onChange: (type, prev, next) => {
            if (kind === 'pods') {
              this.noteShutdown((next ?? prev) as AnyObj | undefined, type === 'DELETED');
            }
            if (isRelevantChange(kind, type, prev as AnyObj, next as AnyObj)) {
              this.options.onRelevantChange?.(kind);
            }
          },
          ...(kind === 'events'
            ? {
                maxItems: EVENT_MAX_ITEMS,
                age: (e: Keyed) => eventTime(e as never),
                keep: (e: Keyed, now: number) => now - eventTime(e as never) <= EVENT_MAX_AGE_MS,
              }
            : {}),
        }),
      );
    }
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.logger.log(`watching ${WATCHED_KINDS.length} kinds`);
    for (const cache of this.caches.values()) {
      cache.start();
    }
  }

  stop(): void {
    this.started = false;
    for (const cache of this.caches.values()) {
      cache.stop();
    }
  }

  /** Resolves once every first list has finished (successfully or not), or after `timeoutMs`. */
  async ready(timeoutMs = 20_000): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all([...this.caches.values()].map((c) => c.ready())),
      new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs))),
    ]);
    clearTimeout(timer);
  }

  get(kind: WatchedKind): WatchCache<Keyed> {
    return this.caches.get(kind)!;
  }

  /** Pods that began shutting down within EVENT_MAX_AGE_MS: `namespace/name` to the time in ms. */
  podShutdowns(now = Date.now()): ReadonlyMap<string, number> {
    for (const [key, at] of this.shutdowns) {
      if (now - at > EVENT_MAX_AGE_MS) {
        this.shutdowns.delete(key);
      }
    }
    return this.shutdowns;
  }

  private noteShutdown(pod: AnyObj | undefined, deleted: boolean): void {
    const name = pod?.metadata?.name;
    if (!name) {
      return;
    }
    const key = podKey(pod.metadata.namespace, name);
    const at = Date.parse((pod.metadata as { deletionTimestamp?: string }).deletionTimestamp ?? '');
    // A pod deleted without a graceful shutdown seen first (grace 0, or missed while the watch
    // reconnected): its deletion is the moment.
    const when = Number.isFinite(at) ? at : deleted ? Date.now() : NaN;
    if (Number.isFinite(when) && !this.shutdowns.has(key)) {
      this.shutdowns.set(key, when);
    }
  }
}
