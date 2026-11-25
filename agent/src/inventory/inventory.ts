import { Condition, ObjectMeta } from '../checks/types';
import type { Node } from '../checks/nodes.check';
import type { Pod } from '../checks/pods.check';
import { KubeClient } from '../kube/kube-client';

export interface PodSpecLite {
  nodeName?: string;
  containers?: { name: string; image: string; resources?: { requests?: Record<string, string>; limits?: Record<string, string> } }[];
  initContainers?: { name: string; image: string }[];
  volumes?: { name: string; persistentVolumeClaim?: { claimName: string } }[];
}

export interface FullPod extends Pod {
  spec?: PodSpecLite;
  status?: Pod['status'] & { podIP?: string; startTime?: string };
}

export interface FullNode extends Node {
  metadata: ObjectMeta;
  spec?: { unschedulable?: boolean; taints?: { key: string; effect: string; value?: string }[] };
  status?: Node['status'] & {
    capacity?: Record<string, string>;
    allocatable?: Record<string, string>;
    addresses?: { type: string; address: string }[];
    nodeInfo?: {
      kubeletVersion?: string;
      osImage?: string;
      kernelVersion?: string;
      containerRuntimeVersion?: string;
      architecture?: string;
    };
  };
}

export interface Workload {
  metadata: ObjectMeta & { generation?: number };
  spec?: {
    replicas?: number;
    selector?: { matchLabels?: Record<string, string> };
    template?: { metadata?: { labels?: Record<string, string> }; spec?: PodSpecLite };
  };
  status?: {
    replicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
    updatedReplicas?: number;
    observedGeneration?: number;
    desiredNumberScheduled?: number;
    numberReady?: number;
    numberUnavailable?: number;
    conditions?: Condition[];
  };
}

export interface Job {
  metadata: ObjectMeta;
  status?: { succeeded?: number; failed?: number; startTime?: string; completionTime?: string; conditions?: Condition[] };
}

export interface CronJob {
  metadata: ObjectMeta;
  spec?: { schedule?: string; suspend?: boolean; jobTemplate?: { spec?: { template?: { metadata?: { labels?: Record<string, string> }; spec?: PodSpecLite } } } };
  status?: { lastScheduleTime?: string; lastSuccessfulTime?: string };
}

export interface Service {
  metadata: ObjectMeta;
  spec?: {
    type?: string;
    selector?: Record<string, string>;
    ports?: { name?: string; port: number; targetPort?: number | string; protocol?: string }[];
    clusterIP?: string;
  };
  status?: { loadBalancer?: { ingress?: { ip?: string; hostname?: string }[] } };
}

export interface Ingress {
  metadata: ObjectMeta;
  spec?: {
    ingressClassName?: string;
    tls?: { hosts?: string[]; secretName?: string }[];
    rules?: {
      host?: string;
      http?: { paths?: { path?: string; backend?: { service?: { name: string; port?: { number?: number; name?: string } } } }[] };
    }[];
  };
}

/** Gateway API HTTPRoute (gateway.networking.k8s.io). */
export interface HttpRoute {
  metadata: ObjectMeta;
  spec?: { hostnames?: string[]; rules?: { backendRefs?: { name: string; namespace?: string; port?: number; kind?: string }[] }[] };
}

/** Traefik's own IngressRoute CRD (traefik.io, formerly traefik.containo.us). */
export interface IngressRoute {
  metadata: ObjectMeta;
  spec?: { entryPoints?: string[]; routes?: { match?: string; services?: { name: string; namespace?: string; port?: number | string; kind?: string }[] }[]; tls?: unknown };
}

export interface Pvc {
  metadata: ObjectMeta;
  spec?: { storageClassName?: string; accessModes?: string[]; volumeName?: string; resources?: { requests?: { storage?: string } } };
  status?: { phase?: string; capacity?: { storage?: string } };
}

export interface StorageClass {
  metadata: ObjectMeta;
  provisioner?: string;
  reclaimPolicy?: string;
  allowVolumeExpansion?: boolean;
}

export interface KubeEvent {
  metadata: ObjectMeta;
  type?: string;
  reason?: string;
  message?: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  firstTimestamp?: string;
  involvedObject?: { kind?: string; name?: string; namespace?: string };
  series?: { count?: number; lastObservedTime?: string };
}

export interface Usage {
  cpuMilli: number;
  memBytes: number;
}

/** Everything one run reads from the API, once. Checks, discovery and the detail views all derive from it. */
export interface Inventory {
  at: Date;
  version: { gitVersion?: string; platform?: string } | null;
  groups: Set<string>;
  namespaces: string[];
  nodes: FullNode[];
  pods: FullPod[];
  deployments: Workload[];
  statefulsets: Workload[];
  daemonsets: Workload[];
  jobs: Job[];
  cronjobs: CronJob[];
  services: Service[];
  ingresses: Ingress[];
  httpRoutes: HttpRoute[];
  ingressRoutes: IngressRoute[];
  pvcs: Pvc[];
  storageClasses: StorageClass[];
  events: KubeEvent[];
  /** null when metrics-server is not installed. */
  nodeUsage: Map<string, Usage> | null;
  podUsage: Map<string, Usage> | null;
}

// ---- quantities ----

const BIN: Record<string, number> = { Ki: 2 ** 10, Mi: 2 ** 20, Gi: 2 ** 30, Ti: 2 ** 40, Pi: 2 ** 50, Ei: 2 ** 60 };
const DEC: Record<string, number> = { n: 1e-9, u: 1e-6, m: 1e-3, '': 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

/** Kubernetes quantity ("1536Mi", "250m", "2", "1.5Gi") to a plain number of base units. */
export function parseQuantity(q: string | undefined): number {
  if (!q) {
    return 0;
  }
  const m = /^([0-9.]+)([a-zA-Z]*)$/.exec(q.trim());
  if (!m) {
    return 0;
  }
  const value = Number(m[1]);
  const unit = m[2];
  if (unit in BIN) {
    return value * BIN[unit];
  }
  return value * (DEC[unit] ?? 1);
}

export const cpuMilli = (q: string | undefined) => Math.round(parseQuantity(q) * 1000);

// ---- gathering ----

interface MetricsItem {
  metadata: ObjectMeta;
  usage?: { cpu?: string; memory?: string };
  containers?: { usage?: { cpu?: string; memory?: string } }[];
}

async function optional<T>(p: Promise<T[] | null>): Promise<T[]> {
  try {
    return (await p) ?? [];
  } catch {
    return [];
  }
}

export async function gatherInventory(kube: KubeClient, now: Date): Promise<Inventory> {
  const [groupList, version] = await Promise.all([
    kube.get<{ groups?: { name: string }[] }>('/apis'),
    kube.get<{ gitVersion?: string; platform?: string }>('/version').catch(() => null),
  ]);
  const groups = new Set((groupList.groups ?? []).map((g) => g.name));
  groups.add('');

  // Core lists must work, the rest may be missing or forbidden.
  const [nodes, pods] = await Promise.all([kube.list<FullNode>('/api/v1/nodes'), kube.list<FullPod>('/api/v1/pods')]);
  const [
    namespaces,
    deployments,
    statefulsets,
    daemonsets,
    jobs,
    cronjobs,
    services,
    ingresses,
    httpRoutes,
    ingressRoutes,
    pvcs,
    storageClasses,
    events,
    nodeMetrics,
    podMetrics,
  ] = await Promise.all([
    optional(kube.list<{ metadata: ObjectMeta }>('/api/v1/namespaces')),
    optional(kube.list<Workload>('/apis/apps/v1/deployments')),
    optional(kube.list<Workload>('/apis/apps/v1/statefulsets')),
    optional(kube.list<Workload>('/apis/apps/v1/daemonsets')),
    optional(kube.list<Job>('/apis/batch/v1/jobs')),
    optional(kube.list<CronJob>('/apis/batch/v1/cronjobs')),
    optional(kube.list<Service>('/api/v1/services')),
    optional(kube.list<Ingress>('/apis/networking.k8s.io/v1/ingresses')),
    groups.has('gateway.networking.k8s.io') ? optional(kube.list<HttpRoute>('/apis/gateway.networking.k8s.io/v1/httproutes')) : Promise.resolve([] as HttpRoute[]),
    groups.has('traefik.io')
      ? optional(kube.list<IngressRoute>('/apis/traefik.io/v1alpha1/ingressroutes'))
      : groups.has('traefik.containo.us')
        ? optional(kube.list<IngressRoute>('/apis/traefik.containo.us/v1alpha1/ingressroutes'))
        : Promise.resolve([] as IngressRoute[]),
    optional(kube.list<Pvc>('/api/v1/persistentvolumeclaims')),
    optional(kube.list<StorageClass>('/apis/storage.k8s.io/v1/storageclasses')),
    optional(kube.list<KubeEvent>('/api/v1/events?fieldSelector=type%3DWarning')),
    groups.has('metrics.k8s.io') ? kube.list<MetricsItem>('/apis/metrics.k8s.io/v1beta1/nodes').catch(() => null) : Promise.resolve(null),
    groups.has('metrics.k8s.io') ? kube.list<MetricsItem>('/apis/metrics.k8s.io/v1beta1/pods').catch(() => null) : Promise.resolve(null),
  ]);

  const nodeUsage = nodeMetrics
    ? new Map(nodeMetrics.map((m) => [m.metadata.name, { cpuMilli: cpuMilli(m.usage?.cpu), memBytes: parseQuantity(m.usage?.memory) }]))
    : null;
  const podUsage = podMetrics
    ? new Map(
        podMetrics.map((m) => {
          let cpu = 0;
          let mem = 0;
          for (const c of m.containers ?? []) {
            cpu += cpuMilli(c.usage?.cpu);
            mem += parseQuantity(c.usage?.memory);
          }
          return [`${m.metadata.namespace}/${m.metadata.name}`, { cpuMilli: cpu, memBytes: mem }];
        }),
      )
    : null;

  return {
    at: now,
    version,
    groups,
    namespaces: namespaces.map((n) => n.metadata.name),
    nodes: nodes ?? [],
    pods: pods ?? [],
    deployments,
    statefulsets,
    daemonsets,
    jobs,
    cronjobs,
    services,
    ingresses,
    httpRoutes,
    ingressRoutes,
    pvcs,
    storageClasses,
    events,
    nodeUsage,
    podUsage,
  };
}

export function emptyInventory(now: Date): Inventory {
  return {
    at: now,
    version: null,
    groups: new Set(['']),
    namespaces: [],
    nodes: [],
    pods: [],
    deployments: [],
    statefulsets: [],
    daemonsets: [],
    jobs: [],
    cronjobs: [],
    services: [],
    ingresses: [],
    httpRoutes: [],
    ingressRoutes: [],
    pvcs: [],
    storageClasses: [],
    events: [],
    nodeUsage: null,
    podUsage: null,
  };
}
