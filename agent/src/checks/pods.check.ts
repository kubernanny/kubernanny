import { t, Text } from '../i18n/text';
import { ageText, Condition, condition, Issue, IssueAction, ObjectMeta, WorkloadKind } from './types';

interface ContainerStatus {
  name: string;
  ready: boolean;
  restartCount: number;
  state?: {
    waiting?: { reason?: string; message?: string };
    terminated?: { reason?: string };
    running?: { startedAt?: string };
  };
  lastState?: { terminated?: { reason?: string; exitCode?: number; startedAt?: string; finishedAt?: string } };
}

/** A container as the restart offer reads it: its memory limit and the ConfigMaps in its environment. */
export interface PodContainer {
  name: string;
  resources?: { limits?: Record<string, string> };
  env?: { name: string; valueFrom?: { configMapKeyRef?: { name?: string } } }[];
  envFrom?: { configMapRef?: { name?: string } }[];
}

export interface Pod {
  metadata: ObjectMeta & { deletionTimestamp?: string };
  spec?: { nodeName?: string; containers?: PodContainer[]; initContainers?: PodContainer[] };
  status?: {
    phase?: string;
    /** `Evicted` on a pod the kubelet pushed off its node. */
    reason?: string;
    conditions?: Condition[];
    containerStatuses?: ContainerStatus[];
    initContainerStatuses?: ContainerStatus[];
  };
}

export function podReady(pod: Pod): boolean {
  return condition(pod.status?.conditions, 'Ready')?.status === 'True';
}

const BROKEN_REASONS = new Set([
  'CrashLoopBackOff',
  'ImagePullBackOff',
  'ErrImagePull',
  'CreateContainerConfigError',
  'CreateContainerError',
  'InvalidImageName',
  'RunContainerError',
]);

const PENDING_GRACE_MS = 10 * 60_000;

interface Owner {
  kind: WorkloadKind | 'Pod';
  name: string;
}

/** The workload a pod belongs to: a ReplicaSet's name is its Deployment's plus the pod-template-hash. */
export function podOwner(pod: Pod): Owner {
  const ref = pod.metadata.ownerReferences?.[0];
  if (ref?.kind === 'ReplicaSet') {
    const hash = pod.metadata.labels?.['pod-template-hash'];
    if (hash && ref.name.endsWith(`-${hash}`)) {
      return { kind: 'Deployment', name: ref.name.slice(0, -hash.length - 1) };
    }
  }
  if (ref?.kind === 'StatefulSet' || ref?.kind === 'DaemonSet') {
    return { kind: ref.kind, name: ref.name };
  }
  return { kind: 'Pod', name: pod.metadata.name };
}

interface Finding {
  pod: Pod;
  reason: string;
  message: Text;
  container?: string;
  previous: boolean;
  /** The last run ended with OOMKilled: a restart cannot help, the limit has to grow. */
  oom?: { limit?: string };
  /** When the container's last run started (for the ConfigMap comparison). */
  lastStart?: string;
}

function findProblem(pod: Pod, now: Date): Finding | null {
  if (pod.status?.phase === 'Succeeded' || pod.metadata.deletionTimestamp) {
    return null;
  }
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  for (const cs of statuses) {
    const waiting = cs.state?.waiting;
    if (waiting?.reason && BROKEN_REASONS.has(waiting.reason)) {
      const lastExit = cs.lastState?.terminated;
      const spec = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])].find(
        (c) => c.name === cs.name,
      );
      const oom = waiting.reason === 'CrashLoopBackOff' && lastExit?.reason === 'OOMKilled';
      return {
        pod,
        reason: waiting.reason,
        message: oom
          ? spec?.resources?.limits?.memory
            ? t('pods.oom.cause', {
                container: cs.name,
                limit: spec.resources.limits.memory,
                restarts: cs.restartCount,
              })
            : t('pods.oom.noLimit', { container: cs.name, restarts: cs.restartCount })
          : t('pods.broken.cause', {
              message: waiting.message?.replace(/\.?$/, '.'),
              exitReason: lastExit ? (lastExit.reason ?? 'Error') : undefined,
              exitCode: lastExit?.exitCode,
              restarts: cs.restartCount,
            }),
        container: cs.name,
        previous: waiting.reason === 'CrashLoopBackOff' && cs.restartCount > 0,
        ...(oom ? { oom: { limit: spec?.resources?.limits?.memory } } : {}),
        lastStart: lastExit?.startedAt ?? cs.state?.running?.startedAt,
      };
    }
  }
  if (pod.status?.phase === 'Pending') {
    const created = Date.parse(pod.metadata.creationTimestamp ?? '');
    if (Number.isFinite(created) && now.getTime() - created > PENDING_GRACE_MS) {
      const scheduled = condition(pod.status?.conditions, 'PodScheduled');
      return {
        pod,
        reason: 'Pending',
        message: t('pods.pending.cause', { age: ageText(now.getTime() - created), message: scheduled?.message }),
        previous: false,
      };
    }
  }
  return null;
}

/** The ConfigMaps a container reads through env and envFrom (volume mounts update by themselves, so they do not count). */
export function envConfigMaps(pod: Pod, container: string | undefined): string[] {
  const c = [...(pod.spec?.initContainers ?? []), ...(pod.spec?.containers ?? [])].find((x) => x.name === container);
  if (!c) {
    return [];
  }
  const names = [
    ...(c.envFrom ?? []).map((e) => e.configMapRef?.name),
    ...(c.env ?? []).map((e) => e.valueFrom?.configMapKeyRef?.name),
  ];
  return [...new Set(names.filter((n): n is string => typeof n === 'string' && n.length > 0))];
}

/** A crash-looping container whose environment comes (partly) from ConfigMaps: what the check reads the metadata of. */
export interface ConfigMapQuestion {
  namespace: string;
  configMaps: string[];
  /** The container's last start; a ConfigMap changed after it was not in that run's environment. */
  since: string;
}

/** For every crash loop worth asking about: the ConfigMaps to read and the time to compare with. Keyed by pod. */
export function configMapQuestions(pods: Pod[], now: Date): Map<string, ConfigMapQuestion> {
  const out = new Map<string, ConfigMapQuestion>();
  for (const pod of pods) {
    const f = findProblem(pod, now);
    if (!f || f.reason !== 'CrashLoopBackOff' || f.oom || !f.lastStart) {
      continue;
    }
    const names = envConfigMaps(pod, f.container);
    if (names.length) {
      const ns = pod.metadata.namespace ?? 'default';
      out.set(`${ns}/${pod.metadata.name}`, { namespace: ns, configMaps: names.slice(0, 5), since: f.lastStart });
    }
  }
  return out;
}

/** One issue per broken workload, not per pod: three crashing replicas are one problem. `changed`: per pod, a ConfigMap of its environment changed after its last start. */
export function evaluatePods(pods: Pod[], now: Date, changed: Map<string, string> = new Map()): Issue[] {
  const byOwner = new Map<string, { owner: Owner; namespace: string; findings: Finding[] }>();
  for (const pod of pods) {
    const finding = findProblem(pod, now);
    if (!finding) {
      continue;
    }
    const owner = podOwner(pod);
    const namespace = pod.metadata.namespace ?? 'default';
    const key = `${namespace}/${owner.kind}/${owner.name}`;
    const entry = byOwner.get(key) ?? { owner, namespace, findings: [] };
    entry.findings.push(finding);
    byOwner.set(key, entry);
  }

  return [...byOwner.entries()].map(([key, { owner, namespace, findings }]) => {
    const first = findings[0];
    const configMap = findings
      .map((f) => changed.get(`${namespace}/${f.pod.metadata.name}`))
      .find((n) => n !== undefined);
    const logs: IssueAction = {
      type: 'logs',
      namespace,
      pod: first.pod.metadata.name,
      container: first.container,
      previous: first.previous,
    };
    const actions: IssueAction[] = [];
    if (owner.kind !== 'Pod' && !first.oom) {
      const restart: IssueAction = { type: 'restart', kind: owner.kind, namespace, name: owner.name };
      if (configMap) {
        // The cause is known and gone: the restart is the fix, the logs come second.
        actions.push({ ...restart, changed: { kind: 'ConfigMap', name: configMap } }, logs);
      } else if (first.reason === 'CrashLoopBackOff') {
        // Without a known cause a restart only crashes again: the logs first.
        actions.push(logs, { ...restart, secondary: true });
      } else {
        actions.push(logs, restart);
      }
    } else {
      actions.push(logs);
    }
    return {
      id: `pods/${key}`,
      check: 'pods' as const,
      severity: first.reason === 'Pending' ? ('warning' as const) : ('critical' as const),
      title: t(first.oom ? 'pods.oom.title' : 'pods.title', {
        workload: `${namespace}/${owner.name}`,
        reason: first.reason,
        pods: findings.length,
      }),
      cause: configMap ? t('pods.configChanged.cause', { name: configMap, cause: first.message }) : first.message,
      actions,
    };
  });
}

/** How long a pod may hang in Terminating on a lost node before force-deleting it is offered. */
const TERMINATING_GRACE_MS = 10 * 60_000;

/**
 * Pods stuck in Terminating whose node is NotReady or gone: the kubelet that
 * would confirm the end is not there, so the pod object stays, a StatefulSet
 * does not start its replacement and a Longhorn volume stays attached.
 */
export function evaluateStuckTerminating(
  pods: Pod[],
  nodes: { metadata: { name: string }; status?: { conditions?: Condition[] } }[],
  now: Date,
): Issue[] {
  const ready = new Map(
    nodes.map((n) => [n.metadata.name, condition(n.status?.conditions, 'Ready')?.status === 'True']),
  );
  const issues: Issue[] = [];
  for (const pod of pods) {
    const since = Date.parse(pod.metadata.deletionTimestamp ?? '');
    const node = pod.spec?.nodeName;
    if (!Number.isFinite(since) || !node || now.getTime() - since < TERMINATING_GRACE_MS || ready.get(node) === true) {
      continue;
    }
    const ns = pod.metadata.namespace ?? 'default';
    const owner = podOwner(pod);
    issues.push({
      id: `pods/terminating/${ns}/${pod.metadata.name}`,
      check: 'pods',
      severity: 'warning',
      title: t('pods.terminating.title', { pod: `${ns}/${pod.metadata.name}`, age: ageText(now.getTime() - since) }),
      cause: ready.has(node) ? t('pods.terminating.notReady', { node }) : t('pods.terminating.nodeGone', { node }),
      actions: [
        {
          type: 'force-delete-terminating',
          namespace: ns,
          pod: pod.metadata.name,
          node,
          ...(owner.kind === 'StatefulSet' ? { statefulSet: owner.name } : {}),
        },
      ],
    });
  }
  return issues;
}

/** Failed pods (evicted ones included) older than this are offered for cleanup. */
const CLEANUP_AFTER_MS = 60 * 60_000;

/**
 * Finished pods nobody needs: Failed (evicted, OOM-killed for good, an error)
 * and Succeeded ones whose Job is gone. Pods of a Job that still exists are
 * left alone: their logs belong to the Job, and the Job controller counts
 * them. One hint per namespace.
 */
export function evaluateFinishedPods(
  pods: Pod[],
  jobs: { metadata: { name: string; namespace?: string } }[],
  now: Date,
): Issue[] {
  const jobNames = new Set(jobs.map((j) => `${j.metadata.namespace ?? 'default'}/${j.metadata.name}`));
  const byNs = new Map<string, Pod[]>();
  for (const pod of pods) {
    const phase = pod.status?.phase;
    const ns = pod.metadata.namespace ?? 'default';
    if ((phase !== 'Failed' && phase !== 'Succeeded') || pod.metadata.deletionTimestamp) {
      continue;
    }
    const job = pod.metadata.ownerReferences?.find((o) => o.kind === 'Job');
    if (job ? jobNames.has(`${ns}/${job.name}`) : phase === 'Succeeded') {
      continue;
    }
    const created = Date.parse(pod.metadata.creationTimestamp ?? '');
    if (!Number.isFinite(created) || now.getTime() - created < CLEANUP_AFTER_MS) {
      continue;
    }
    byNs.set(ns, [...(byNs.get(ns) ?? []), pod]);
  }
  return [...byNs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([ns, list]) => {
      const names = list.map((p) => p.metadata.name).sort();
      const evicted = list.filter((p) => p.status?.reason === 'Evicted').length;
      return {
        id: `pods/finished/${ns}`,
        check: 'pods',
        severity: 'info' as const,
        title: t('pods.finished.title', { n: names.length, namespace: ns }),
        cause: t('pods.finished.cause', {
          evicted,
          others: names.length - evicted,
          names: names.slice(0, 3).join(', '),
          more: Math.max(0, names.length - 3),
        }),
        // At most 50 per issue: the next run offers the rest.
        actions: [{ type: 'cleanup-pods' as const, namespace: ns, pods: names.slice(0, 50) }],
      };
    });
}
