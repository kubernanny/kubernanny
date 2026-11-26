/** The Nodes tab: roles, readiness, kubelet and OS, CPU and memory (allocatable, requested, used), disk, pods, conditions, taints. */
import { condition } from '../checks/types';
import { cpuMilli, Inventory, parseQuantity } from '../inventory/inventory';
import { RunData } from '../modules/types';
import { addResources, holdsResources, NO_RESOURCES, podResources, Resources } from './resources';

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
  /** Requests and limits summed over the pods on the node (limits only where set). */
  cpu: { allocatableMilli: number; requestedMilli: number; limitMilli: number; usedMilli: number | null };
  memory: { allocatable: number; requested: number; limit: number; used: number | null };
  /** Root filesystem use 0..1 from node-exporter, if Prometheus is there. */
  disk: number | null;
  pods: { count: number; capacity: number };
  /** Pods on the node with a container that sets no CPU / no memory limit: they can take what the node has. */
  podsWithoutLimit: { cpu: number; memory: number };
  /** Conditions that are not as they should be, with since when (lastTransitionTime). */
  conditions: { type: string; status: string; message?: string; since?: string }[];
  taints: string[];
}

const ROLE_PREFIX = 'node-role.kubernetes.io/';

export function buildNodes(inv: Inventory, data: RunData): NodeView[] {
  const requested = new Map<string, { res: Resources; count: number; noCpuLimit: number; noMemLimit: number }>();
  for (const pod of inv.pods) {
    if (!holdsResources(pod)) {
      continue;
    }
    const node = pod.spec!.nodeName!;
    const r = requested.get(node) ?? { res: NO_RESOURCES, count: 0, noCpuLimit: 0, noMemLimit: 0 };
    const own = podResources(pod);
    requested.set(node, {
      res: addResources(r.res, own),
      count: r.count + 1,
      noCpuLimit: r.noCpuLimit + (own.cpuUnlimited > 0 ? 1 : 0),
      noMemLimit: r.noMemLimit + (own.memUnlimited > 0 ? 1 : 0),
    });
  }
  return inv.nodes
    .map((n) => {
      const name = n.metadata.name;
      const r = requested.get(name) ?? { res: NO_RESOURCES, count: 0, noCpuLimit: 0, noMemLimit: 0 };
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
        cpu: {
          allocatableMilli: cpuMilli(n.status?.allocatable?.cpu),
          requestedMilli: r.res.cpuRequestMilli,
          limitMilli: r.res.cpuLimitMilli,
          usedMilli: usage?.cpuMilli ?? null,
        },
        memory: {
          allocatable: parseQuantity(n.status?.allocatable?.memory),
          requested: r.res.memRequest,
          limit: r.res.memLimit,
          used: usage?.memBytes ?? null,
        },
        disk: data.nodeDisk?.get(name) ?? null,
        pods: { count: r.count, capacity: Number(n.status?.allocatable?.pods ?? 0) },
        podsWithoutLimit: { cpu: r.noCpuLimit, memory: r.noMemLimit },
        conditions: (n.status?.conditions ?? [])
          .filter((c) => (c.type === 'Ready' ? c.status !== 'True' : c.status === 'True'))
          .map((c) => ({
            type: c.type,
            status: c.status,
            message: c.message,
            ...(c.lastTransitionTime ? { since: c.lastTransitionTime } : {}),
          })),
        taints: (n.spec?.taints ?? []).map((t) => `${t.key}${t.value ? `=${t.value}` : ''}:${t.effect}`),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
