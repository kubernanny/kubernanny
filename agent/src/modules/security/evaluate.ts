import { podOwner } from '../../checks/pods.check';
import { Issue, IssueSeverity, ObjectMeta } from '../../checks/types';
import { imageVersion } from '../../discovery/discovery';
import { raw, t } from '../../i18n/text';

/** The fields of a pod spec the posture check reads; the inventory holds the full objects. */
export interface SecurityContextLite {
  runAsNonRoot?: boolean;
  runAsUser?: number;
  privileged?: boolean;
}

export interface ContainerLite {
  name: string;
  image: string;
  securityContext?: SecurityContextLite;
  resources?: { limits?: Record<string, string> };
}

export interface SecurityPod {
  metadata: ObjectMeta;
  spec?: {
    hostNetwork?: boolean;
    hostPID?: boolean;
    hostIPC?: boolean;
    securityContext?: SecurityContextLite;
    containers?: ContainerLite[];
    initContainers?: ContainerLite[];
    volumes?: { name: string; hostPath?: { path?: string } }[];
  };
  status?: { phase?: string };
}

export type FindingType = 'privileged' | 'host-access' | 'root' | 'no-memory-limit' | 'mutable-image';

/**
 * Namespaces of Kubernetes, its distributions and node-level infrastructure,
 * whose pods need host access by design and are not the cluster owner's to
 * fix. `SECURITY_SYSTEM_NAMESPACES` adds to these.
 */
export const SYSTEM_NAMESPACES: readonly string[] = [
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'calico-system',
  'tigera-operator',
  'cattle-system',
  'cattle-fleet-system',
  'longhorn-system',
  'metallb-system',
  'rook-ceph',
  'openebs',
  'system-upgrade',
];

/**
 * Recognised components that need privileged containers, host access or root
 * wherever they are installed (a node exporter reads the host's /proc, a CSI
 * driver mounts disks, a CNI configures the node's network). Their pods are
 * left out of those three findings; limits and image tags still count.
 */
export const HOST_LEVEL_COMPONENTS: ReadonlySet<string> = new Set([
  'longhorn',
  'rook-ceph',
  'openebs',
  'nfs-provisioner',
  'local-path',
  'node-exporter',
  'promtail',
  'alloy',
  'kured',
  'system-upgrade-controller',
  'cilium',
  'calico',
  'flannel',
  'metallb',
  'kube-vip',
  'crowdsec',
]);

/** The workload a pod belongs to, as "Kind name" for the issue text and "ns/Kind/name" as key. */
export function workloadOf(pod: SecurityPod, cronOfJob: Map<string, string>): { key: string; label: string } {
  const ns = pod.metadata.namespace ?? 'default';
  const owner = podOwner({ metadata: pod.metadata });
  if (owner.kind !== 'Pod') {
    return { key: `${ns}/${owner.kind}/${owner.name}`, label: owner.name };
  }
  const ref = pod.metadata.ownerReferences?.[0];
  if (ref?.kind === 'Job') {
    const cron = cronOfJob.get(`${ns}/${ref.name}`);
    return cron ? { key: `${ns}/CronJob/${cron}`, label: cron } : { key: `${ns}/Job/${ref.name}`, label: ref.name };
  }
  if (ref) {
    return { key: `${ns}/${ref.kind}/${ref.name}`, label: ref.name };
  }
  return { key: `${ns}/Pod/${pod.metadata.name}`, label: pod.metadata.name };
}

/** What one pod shows, each finding with a short detail for the issue text ("hostPath", "nginx:latest"). */
export function podFindings(pod: SecurityPod): { type: FindingType; detail?: string }[] {
  const spec = pod.spec ?? {};
  const containers = [...(spec.containers ?? []), ...(spec.initContainers ?? [])];
  const out: { type: FindingType; detail?: string }[] = [];
  if (containers.some((c) => c.securityContext?.privileged === true)) {
    out.push({ type: 'privileged' });
  }
  const host = [spec.hostNetwork && 'hostNetwork', spec.hostPID && 'hostPID', spec.hostIPC && 'hostIPC', (spec.volumes ?? []).some((v) => v.hostPath) && 'hostPath'].filter((x): x is string => Boolean(x));
  if (host.length > 0) {
    out.push({ type: 'host-access', detail: host.join(', ') });
  }
  // A container setting overrides the pod's; without either, the image decides.
  const root = (spec.containers ?? []).some((c) => {
    const nonRoot = c.securityContext?.runAsNonRoot ?? spec.securityContext?.runAsNonRoot;
    const user = c.securityContext?.runAsUser ?? spec.securityContext?.runAsUser;
    return user === 0 || (user === undefined && nonRoot !== true);
  });
  if (root) {
    out.push({ type: 'root' });
  }
  if ((spec.containers ?? []).some((c) => !c.resources?.limits?.memory)) {
    out.push({ type: 'no-memory-limit' });
  }
  const mutable = containers.map((c) => c.image).find((image) => !image.includes('@') && (imageVersion(image) === undefined || imageVersion(image) === 'latest'));
  if (mutable) {
    out.push({ type: 'mutable-image', detail: mutable.split('/').pop() });
  }
  return out;
}

const ORDER: FindingType[] = ['privileged', 'host-access', 'root', 'no-memory-limit', 'mutable-image'];

export interface SecurityInput {
  pods: SecurityPod[];
  /** "ns/job" -> CronJob name, so a CronJob's pods count once. */
  cronOfJob: Map<string, string>;
  systemNamespaces: ReadonlySet<string>;
  /** "ns/Kind/name" of workloads of HOST_LEVEL_COMPONENTS. */
  hostLevel: ReadonlySet<string>;
}

/**
 * One issue per finding type and namespace, not per pod: ten replicas or a
 * namespace of twenty charts without limits are one line. Hints only, except
 * privileged containers outside the system namespaces (a warning: that pod is
 * the node).
 */
export function evaluateSecurity(input: SecurityInput): Issue[] {
  const byGroup = new Map<string, { ns: string; type: FindingType; workloads: Map<string, string | undefined> }>();
  for (const pod of input.pods) {
    const ns = pod.metadata.namespace ?? 'default';
    if (input.systemNamespaces.has(ns) || pod.status?.phase === 'Succeeded') {
      continue;
    }
    const w = workloadOf(pod, input.cronOfJob);
    for (const f of podFindings(pod)) {
      if (input.hostLevel.has(w.key) && (f.type === 'privileged' || f.type === 'host-access' || f.type === 'root')) {
        continue;
      }
      const key = `${ns}/${f.type}`;
      const group = byGroup.get(key) ?? { ns, type: f.type, workloads: new Map() };
      if (!group.workloads.has(w.label)) {
        group.workloads.set(w.label, f.detail);
      }
      byGroup.set(key, group);
    }
  }
  return [...byGroup.values()]
    .sort((a, b) => a.ns.localeCompare(b.ns) || ORDER.indexOf(a.type) - ORDER.indexOf(b.type))
    .map(({ ns, type, workloads }) => {
      const names = [...workloads].sort(([a], [b]) => a.localeCompare(b)).map(([name, detail]) => (detail ? `${name} (${detail})` : name));
      const affected = names.length > 5 ? t('security.affectedMore', { names: names.slice(0, 5).join(', '), more: names.length - 5 }) : raw(names.join(', '));
      const severity: IssueSeverity = type === 'privileged' ? 'warning' : 'info';
      return {
        id: `security/${ns}/${type}`,
        check: 'security',
        severity,
        title: t(`security.${type}.title`, { ns, n: workloads.size }),
        cause: t('security.cause', { why: t(`security.${type}.why`), affected, fix: t(`security.${type}.fix`) }),
        actions: [],
      };
    });
}
