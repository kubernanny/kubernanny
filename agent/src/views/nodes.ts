/** The Nodes tab: roles, readiness, kubelet and OS, CPU and memory (allocatable, requested, used), disk, pods, conditions, taints. */
import { condition } from '../checks/types';
import { cpuMilli, Inventory, parseQuantity } from '../inventory/inventory';
import { RunData } from '../modules/types';

export interface NodeView {
  name: string;
  roles: string[];
  ready: boolean;
  cordoned: boolean;
  rebooting: boolean;
  kubelet?: string;
  os?: string;
  kernel?: string;
  runtime?: string;
  arch?: string;
  internalIp?: string;
  createdAt?: string;
  cpu: { allocatableMilli: number; requestedMilli: number; usedMilli: number | null };
  memory: { allocatable: number; requested: number; used: number | null };
  /** Root filesystem use 0..1 from node-exporter, if Prometheus is there. */
  disk: number | null;
  pods: { count: number; capacity: number };
  conditions: { type: string; status: string; message?: string }[];
  taints: string[];
}

const ROLE_PREFIX = 'node-role.kubernetes.io/';

export function buildNodes(inv: Inventory, data: RunData): NodeView[] {
  const requested = new Map<string, { cpu: number; mem: number; count: number }>();
  for (const pod of inv.pods) {
    const node = pod.spec?.nodeName;
    if (!node || pod.status?.phase === 'Succeeded' || pod.status?.phase === 'Failed') {
      continue;
    }
    const r = requested.get(node) ?? { cpu: 0, mem: 0, count: 0 };
    for (const c of pod.spec?.containers ?? []) {
      r.cpu += cpuMilli(c.resources?.requests?.cpu);
      r.mem += parseQuantity(c.resources?.requests?.memory);
    }
    r.count++;
    requested.set(node, r);
  }
  return inv.nodes
    .map((n) => {
      const name = n.metadata.name;
      const r = requested.get(name) ?? { cpu: 0, mem: 0, count: 0 };
      const usage = inv.nodeUsage?.get(name);
      const info = n.status?.nodeInfo;
      return {
        name,
        roles: Object.keys(n.metadata.labels ?? {})
          .filter((l) => l.startsWith(ROLE_PREFIX))
          .map((l) => l.slice(ROLE_PREFIX.length))
          .sort(),
        ready: condition(n.status?.conditions, 'Ready')?.status === 'True',
        cordoned: n.spec?.unschedulable === true,
        rebooting: data.kuredLock === name,
        kubelet: info?.kubeletVersion,
        os: info?.osImage,
        kernel: info?.kernelVersion,
        runtime: info?.containerRuntimeVersion,
        arch: info?.architecture,
        internalIp: n.status?.addresses?.find((a) => a.type === 'InternalIP')?.address,
        createdAt: n.metadata.creationTimestamp,
        cpu: { allocatableMilli: cpuMilli(n.status?.allocatable?.cpu), requestedMilli: r.cpu, usedMilli: usage?.cpuMilli ?? null },
        memory: { allocatable: parseQuantity(n.status?.allocatable?.memory), requested: r.mem, used: usage?.memBytes ?? null },
        disk: data.nodeDisk?.get(name) ?? null,
        pods: { count: r.count, capacity: Number(n.status?.allocatable?.pods ?? 0) },
        conditions: (n.status?.conditions ?? [])
          .filter((c) => (c.type === 'Ready' ? c.status !== 'True' : c.status === 'True'))
          .map((c) => ({ type: c.type, status: c.status, message: c.message })),
        taints: (n.spec?.taints ?? []).map((t) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
