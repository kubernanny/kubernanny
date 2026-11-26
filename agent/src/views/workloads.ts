/** The Workloads tab: every Deployment, StatefulSet and DaemonSet with its pods, images, restarts and resource use. */
import { podOwner, podReady } from '../checks/pods.check';
import { allWorkloads, Detected, imagesOf, readiness } from '../discovery/discovery';
import { FullPod, Inventory, parseQuantity } from '../inventory/inventory';
import { Health } from './health';
import { addResources, holdsResources, NO_RESOURCES, podResources } from './resources';

export interface WorkloadView {
  kind: string;
  namespace: string;
  name: string;
  ready: number;
  desired: number;
  health: Health;
  component?: string;
  images: string[];
  restarts: number;
  createdAt?: string;
  cpuMilli: number | null;
  memBytes: number | null;
  /** Requests and limits of the pods that hold resources; a limit is null when no container sets one. */
  resources: {
    cpuRequestMilli: number;
    cpuLimitMilli: number | null;
    memRequest: number;
    memLimit: number | null;
    cpuUnlimited: number;
    memUnlimited: number;
  };
  /** The most recent restart of any of its containers, with why it ended. */
  lastRestart?: Termination & { pod: string; container: string };
  pods: {
    name: string;
    node?: string;
    phase?: string;
    ready: boolean;
    restarts: number;
    containers: ContainerView[];
  }[];
}

/** How a container's previous run ended (`lastState.terminated`). */
export interface Termination {
  reason?: string;
  exitCode?: number;
  signal?: number;
  finishedAt?: string;
  /** The container's memory limit, set when the run was OOMKilled, so the app can name it. */
  memLimit?: number;
}

export interface ContainerView {
  name: string;
  ready: boolean;
  restarts: number;
  /** Why it waits right now (CrashLoopBackOff, ImagePullBackOff). */
  waiting?: string;
  lastTermination?: Termination;
}

interface ContainerStatusFull {
  name: string;
  ready: boolean;
  restartCount: number;
  state?: { waiting?: { reason?: string } };
  lastState?: { terminated?: { reason?: string; exitCode?: number; signal?: number; finishedAt?: string } };
}

/** The containers of a pod with the end of their last run; the memory limit next to an OOMKilled one. */
export function containerViews(pod: FullPod): ContainerView[] {
  const statuses = (pod.status?.containerStatuses ?? []) as ContainerStatusFull[];
  return statuses.map((c) => {
    const term = c.lastState?.terminated;
    const limit = pod.spec?.containers?.find((s) => s.name === c.name)?.resources?.limits?.memory;
    const lastTermination: Termination | undefined = term
      ? {
          ...(term.reason ? { reason: term.reason } : {}),
          ...(term.exitCode !== undefined ? { exitCode: term.exitCode } : {}),
          ...(term.signal !== undefined ? { signal: term.signal } : {}),
          ...(term.finishedAt ? { finishedAt: term.finishedAt } : {}),
          ...(term.reason === 'OOMKilled' && limit ? { memLimit: parseQuantity(limit) } : {}),
        }
      : undefined;
    return {
      name: c.name,
      ready: c.ready,
      restarts: c.restartCount,
      ...(c.state?.waiting?.reason ? { waiting: c.state.waiting.reason } : {}),
      ...(lastTermination ? { lastTermination } : {}),
    };
  });
}

export function buildWorkloads(inv: Inventory, detected: Detected[]): WorkloadView[] {
  const componentOf = new Map<string, string>();
  for (const d of detected) {
    for (const w of d.workloads) {
      componentOf.set(`${w.namespace}/${w.kind}/${w.name}`, d.entry.name);
    }
  }
  const podsByOwner = new Map<string, typeof inv.pods>();
  for (const p of inv.pods) {
    const o = podOwner(p);
    const key = `${p.metadata.namespace}/${o.kind}/${o.name}`;
    podsByOwner.set(key, [...(podsByOwner.get(key) ?? []), p]);
  }
  return allWorkloads(inv)
    .map(({ kind, w }) => {
      const ns = w.metadata.namespace ?? 'default';
      const key = `${ns}/${kind}/${w.metadata.name}`;
      const { ready, desired } = readiness(kind, w);
      const pods = podsByOwner.get(key) ?? [];
      let cpu: number | null = inv.podUsage ? 0 : null;
      let mem: number | null = inv.podUsage ? 0 : null;
      for (const p of pods) {
        const u = inv.podUsage?.get(`${p.metadata.namespace}/${p.metadata.name}`);
        if (u && cpu !== null && mem !== null) {
          cpu += u.cpuMilli;
          mem += u.memBytes;
        }
      }
      const restarts = pods.reduce(
        (s, p) => s + (p.status?.containerStatuses ?? []).reduce((x, c) => x + c.restartCount, 0),
        0,
      );
      const res = pods.filter(holdsResources).map(podResources).reduce(addResources, NO_RESOURCES);
      const podViews = pods.map((p) => ({
        name: p.metadata.name,
        node: p.spec?.nodeName,
        phase: p.status?.phase,
        ready: podReady(p),
        restarts: (p.status?.containerStatuses ?? []).reduce((x, c) => x + c.restartCount, 0),
        containers: containerViews(p),
      }));
      let lastRestart: WorkloadView['lastRestart'];
      for (const p of podViews) {
        for (const c of p.containers) {
          const at = c.lastTermination?.finishedAt;
          if (c.restarts > 0 && at && (!lastRestart?.finishedAt || at > lastRestart.finishedAt)) {
            lastRestart = { ...c.lastTermination, pod: p.name, container: c.name };
          }
        }
      }
      const health: Health = desired > 0 && ready === 0 ? 'critical' : ready < desired ? 'warning' : 'ok';
      return {
        kind,
        namespace: ns,
        name: w.metadata.name,
        ready,
        desired,
        health,
        component: componentOf.get(key),
        images: [...new Set(imagesOf(w))],
        restarts,
        createdAt: w.metadata.creationTimestamp,
        cpuMilli: cpu,
        memBytes: mem,
        resources: {
          cpuRequestMilli: res.cpuRequestMilli,
          cpuLimitMilli: res.cpuLimitMilli > 0 ? res.cpuLimitMilli : null,
          memRequest: res.memRequest,
          memLimit: res.memLimit > 0 ? res.memLimit : null,
          cpuUnlimited: res.cpuUnlimited,
          memUnlimited: res.memUnlimited,
        },
        ...(lastRestart ? { lastRestart } : {}),
        pods: podViews,
      };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}
