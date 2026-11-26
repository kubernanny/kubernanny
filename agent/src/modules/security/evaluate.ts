import { podOwner } from '../../checks/pods.check';
import { Issue, IssueSeverity, ObjectMeta } from '../../checks/types';
import { imageVersion } from '../../discovery/discovery';
import { raw, t, Text } from '../../i18n/text';
import {
  ACCEPT_ANNOTATION,
  ACCEPTABLE_KEYS,
  AcceptKey,
  AcceptSource,
  mergeAccept,
  MergedAccept,
} from './accept-annotation';

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
  const host = [
    spec.hostNetwork && 'hostNetwork',
    spec.hostPID && 'hostPID',
    spec.hostIPC && 'hostIPC',
    (spec.volumes ?? []).some((v) => v.hostPath) && 'hostPath',
  ].filter((x): x is string => Boolean(x));
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
  const mutable = containers
    .map((c) => c.image)
    .find((image) => !image.includes('@') && (imageVersion(image) === undefined || imageVersion(image) === 'latest'));
  if (mutable) {
    out.push({ type: 'mutable-image', detail: mutable.split('/').pop() });
  }
  return out;
}

/**
 * A CronJob's pod template as a pod, so the CronJob counts on every run of
 * the check, not only in the seconds one of its Jobs happens to be running
 * (a CronJob every 5 minutes otherwise showed up and vanished again, and
 * seventy CronJobs from one template showed as one). Suspended CronJobs
 * start no pods and are left out.
 */
export function cronJobTemplatePods(
  cronjobs: readonly {
    metadata: ObjectMeta;
    spec?: {
      suspend?: boolean;
      jobTemplate?: { spec?: { template?: { metadata?: { annotations?: Record<string, string> }; spec?: unknown } } };
    };
  }[],
): SecurityPod[] {
  return cronjobs
    .filter((c) => c.spec?.suspend !== true && c.spec?.jobTemplate?.spec?.template?.spec)
    .map((c) => ({
      metadata: {
        name: c.metadata.name,
        namespace: c.metadata.namespace,
        ownerReferences: [{ kind: 'CronJob', name: c.metadata.name }],
        ...(c.spec?.jobTemplate?.spec?.template?.metadata?.annotations
          ? { annotations: c.spec.jobTemplate.spec.template.metadata.annotations }
          : {}),
      },
      spec: c.spec!.jobTemplate!.spec!.template!.spec as SecurityPod['spec'],
      status: { phase: 'Pending' },
    }));
}

const ORDER: (AcceptKey | 'privileged' | 'accept-annotation')[] = [
  'privileged',
  'host-access',
  'root',
  'no-memory-limit',
  'mutable-image',
  'cpu-throttled',
  'accept-annotation',
];

export interface SecurityInput {
  pods: SecurityPod[];
  /** "ns/job" -> CronJob name, so a CronJob's pods count once. */
  cronOfJob: Map<string, string>;
  systemNamespaces: ReadonlySet<string>;
  /** "ns/Kind/name" of workloads of HOST_LEVEL_COMPONENTS. */
  hostLevel: ReadonlySet<string>;
  /** "ns/Kind/name" -> the workload's own `kubernanny.io/accept` annotation. */
  workloadAccept?: ReadonlyMap<string, string>;
}

/** A hint someone accepted in the workload's annotation: left out of the issues, listed on the module sheet. */
export interface AcceptedFinding {
  /** The annotation key: `root`, `host-access`, `cpu-throttled`, … */
  key: AcceptKey;
  /** What was found, in words ("may run as root"). */
  finding: Text;
  namespace: string;
  /** Deployment, StatefulSet, DaemonSet, CronJob, or the owner of the pods. */
  kind: string;
  name: string;
  reason: string;
  /** The workload's own annotation, or its pod template's. */
  source: AcceptSource;
}

export interface SecurityOutcome {
  issues: Issue[];
  /** Sorted by namespace, workload and finding. */
  accepted: AcceptedFinding[];
}

interface Group {
  ns: string;
  type: FindingType;
  workloads: Map<string, string | undefined>;
  /** Workloads that name this finding in their annotation without a reason. */
  noReason: Set<string>;
}

/**
 * One issue per finding type and namespace, not per pod: ten replicas or a
 * namespace of twenty charts without limits are one line. Hints only, except
 * privileged containers outside the system namespaces (a warning: that pod is
 * the node). A hint the workload accepts in its `kubernanny.io/accept`
 * annotation, with a reason, is listed apart and counts nowhere; a warning is
 * never accepted.
 */
export function evaluateSecurityPosture(input: SecurityInput): SecurityOutcome {
  const byGroup = new Map<string, Group>();
  const accepted = new Map<string, AcceptedFinding>();
  /** Per namespace, per workload: what its annotation names that cannot count. */
  const misread = new Map<string, Map<string, { unknown: Set<string>; refused: Set<string> }>>();
  const acceptOf = new Map<string, MergedAccept>();
  for (const pod of input.pods) {
    const ns = pod.metadata.namespace ?? 'default';
    if (input.systemNamespaces.has(ns) || pod.status?.phase === 'Succeeded') {
      continue;
    }
    const w = workloadOf(pod, input.cronOfJob);
    const accept =
      acceptOf.get(w.key) ??
      mergeAccept(input.workloadAccept?.get(w.key), pod.metadata.annotations?.[ACCEPT_ANNOTATION]);
    acceptOf.set(w.key, accept);
    if (accept.unknown.length || accept.refused.length) {
      const inNs = misread.get(ns) ?? new Map();
      const entry = inNs.get(w.label) ?? { unknown: new Set<string>(), refused: new Set<string>() };
      accept.unknown.forEach((k) => entry.unknown.add(k));
      accept.refused.forEach((k) => entry.refused.add(k));
      inNs.set(w.label, entry);
      misread.set(ns, inNs);
    }
    for (const f of podFindings(pod)) {
      if (input.hostLevel.has(w.key) && (f.type === 'privileged' || f.type === 'host-access' || f.type === 'root')) {
        continue;
      }
      const reason = severityOf(f.type) === 'info' ? accept.accepted.get(f.type) : undefined;
      if (reason !== undefined) {
        const [, kind, name] = w.key.split('/');
        accepted.set(`${w.key}/${f.type}`, {
          key: f.type,
          finding: t(`security.${f.type}.short`),
          namespace: ns,
          kind,
          name: name ?? w.label,
          reason,
          source: accept.source.get(f.type) ?? 'workload',
        });
        continue;
      }
      const key = `${ns}/${f.type}`;
      const group = byGroup.get(key) ?? { ns, type: f.type, workloads: new Map(), noReason: new Set() };
      if (!group.workloads.has(w.label)) {
        group.workloads.set(w.label, f.detail);
      }
      if (accept.missingReason.has(f.type)) {
        group.noReason.add(w.label);
      }
      byGroup.set(key, group);
    }
  }
  const issues: { ns: string; order: number; issue: Issue }[] = [...byGroup.values()].map(
    ({ ns, type, workloads, noReason }) => {
      const names = [...workloads]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, detail]) => (detail ? `${name} (${detail})` : name));
      const affected =
        names.length > 5
          ? t('security.affectedMore', { names: names.slice(0, 5).join(', '), more: names.length - 5 })
          : raw(names.join(', '));
      const cause = t('security.cause', { why: t(`security.${type}.why`), affected, fix: t(`security.${type}.fix`) });
      const missing = [...noReason].sort((a, b) => a.localeCompare(b));
      return {
        ns,
        order: ORDER.indexOf(type),
        issue: {
          id: `security/${ns}/${type}`,
          check: 'security',
          severity: severityOf(type),
          title: t(`security.${type}.title`, { ns, n: workloads.size }),
          // A hint that can be accepted says how, with the snippet for this finding; one that names it
          // without a reason already uses the annotation and gets told what is missing instead.
          cause: missing.length
            ? t('common.sentences', {
                parts: [cause, t('security.accept.noReason', { names: missing.join(', '), key: type })],
              })
            : ACCEPTABLE_KEYS.includes(type)
              ? t('common.sentences', { parts: [cause, t('security.accept.how', { key: type })] })
              : cause,
          actions: [],
        },
      };
    },
  );
  for (const [ns, byWorkload] of misread) {
    const parts = [...byWorkload]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([name, { unknown, refused }]) => [
        ...(unknown.size ? [t('security.accept.unknown', { name, keys: [...unknown].join(', ') })] : []),
        ...(refused.size ? [t('security.accept.refused', { name, keys: [...refused].join(', ') })] : []),
      ]);
    issues.push({
      ns,
      order: ORDER.indexOf('accept-annotation'),
      issue: {
        id: `security/${ns}/accept-annotation`,
        check: 'security',
        severity: 'info',
        title: t('security.accept.title', { ns, n: byWorkload.size }),
        cause: t('common.sentences', {
          parts: [...parts, t('security.accept.keys', { keys: ACCEPTABLE_KEYS.join(', ') })],
        }),
        actions: [],
      },
    });
  }
  return {
    issues: issues.sort((a, b) => a.ns.localeCompare(b.ns) || a.order - b.order).map((x) => x.issue),
    accepted: [...accepted.values()].sort(
      (a, b) =>
        a.namespace.localeCompare(b.namespace) ||
        a.name.localeCompare(b.name) ||
        ORDER.indexOf(a.key) - ORDER.indexOf(b.key),
    ),
  };
}

/** Privileged containers are a warning, everything else a hint. */
function severityOf(type: FindingType): IssueSeverity {
  return type === 'privileged' ? 'warning' : 'info';
}

/** The issues alone. */
export function evaluateSecurity(input: SecurityInput): Issue[] {
  return evaluateSecurityPosture(input).issues;
}
