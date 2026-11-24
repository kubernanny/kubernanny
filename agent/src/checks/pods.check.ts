import { Text, t } from '../i18n/text';
import { Issue, IssueAction, ObjectMeta, WorkloadKind, ageText, condition, Condition } from './types';

interface ContainerStatus {
  name: string;
  ready: boolean;
  restartCount: number;
  state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string } };
  lastState?: { terminated?: { reason?: string; exitCode?: number } };
}

export interface Pod {
  metadata: ObjectMeta;
  spec?: { nodeName?: string };
  status?: {
    phase?: string;
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
}

function findProblem(pod: Pod, now: Date): Finding | null {
  if (pod.status?.phase === 'Succeeded') {
    return null;
  }
  const statuses = [...(pod.status?.initContainerStatuses ?? []), ...(pod.status?.containerStatuses ?? [])];
  for (const cs of statuses) {
    const waiting = cs.state?.waiting;
    if (waiting?.reason && BROKEN_REASONS.has(waiting.reason)) {
      const lastExit = cs.lastState?.terminated;
      return {
        pod,
        reason: waiting.reason,
        message: t('pods.broken.cause', {
          message: waiting.message?.replace(/\.?$/, '.'),
          exitReason: lastExit ? (lastExit.reason ?? 'Error') : undefined,
          exitCode: lastExit?.exitCode,
          restarts: cs.restartCount,
        }),
        container: cs.name,
        previous: waiting.reason === 'CrashLoopBackOff' && cs.restartCount > 0,
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

/** One issue per broken workload, not per pod: three crashing replicas are one problem. */
export function evaluatePods(pods: Pod[], now: Date): Issue[] {
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
    const actions: IssueAction[] = [
      {
        type: 'logs',
        namespace,
        pod: first.pod.metadata.name,
        container: first.container,
        previous: first.previous,
      },
    ];
    if (owner.kind !== 'Pod') {
      actions.push({ type: 'restart', kind: owner.kind, namespace, name: owner.name });
    }
    return {
      id: `pods/${key}`,
      check: 'pods' as const,
      severity: first.reason === 'Pending' ? ('warning' as const) : ('critical' as const),
      title: t('pods.title', { workload: `${namespace}/${owner.name}`, reason: first.reason, pods: findings.length }),
      cause: first.message,
      actions,
    };
  });
}
