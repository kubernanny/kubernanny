/** The Workloads tab: every Deployment, StatefulSet and DaemonSet with its pods, images, restarts and resource use. */
import { podOwner, podReady } from '../checks/pods.check';
import { allWorkloads, Detected, imagesOf, readiness } from '../discovery/discovery';
import { Inventory } from '../inventory/inventory';
import { Health } from './health';

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
  pods: { name: string; node?: string; phase?: string; ready: boolean; restarts: number }[];
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
      const restarts = pods.reduce((s, p) => s + (p.status?.containerStatuses ?? []).reduce((x, c) => x + c.restartCount, 0), 0);
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
        pods: pods.map((p) => ({
          name: p.metadata.name,
          node: p.spec?.nodeName,
          phase: p.status?.phase,
          ready: podReady(p),
          restarts: (p.status?.containerStatuses ?? []).reduce((x, c) => x + c.restartCount, 0),
        })),
      };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}
