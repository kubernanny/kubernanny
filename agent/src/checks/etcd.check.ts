import { t } from '../i18n/text';
import { Issue } from './types';
import { Pod, podReady } from './pods.check';

/**
 * etcd as RKE2 and kubeadm run it: one static pod per server node in
 * kube-system, label component=etcd. Losing one member of three is a warning,
 * losing quorum is critical (the API then refuses every write).
 */
export function evaluateEtcd(pods: Pod[]): Issue[] | null {
  if (pods.length === 0) {
    return null;
  }
  const total = pods.length;
  const quorum = Math.floor(total / 2) + 1;
  const down = pods.filter((p) => !podReady(p));
  if (down.length === 0) {
    return [];
  }
  const ready = total - down.length;
  const names = down.map((p) => p.spec?.nodeName ?? p.metadata.name).join(', ');
  return [
    {
      id: 'etcd/members',
      check: 'etcd',
      severity: ready < quorum ? 'critical' : 'warning',
      title: ready < quorum ? t('etcd.noQuorum.title', { ready, total }) : t('etcd.memberDown.title', { ready, total }),
      cause: ready < quorum ? t('etcd.noQuorum.cause', { ready, total, quorum, names }) : t('etcd.memberDown.cause', { names, spare: ready - quorum }),
      actions: down.slice(0, 2).map((p) => ({
        type: 'logs' as const,
        namespace: p.metadata.namespace ?? 'kube-system',
        pod: p.metadata.name,
      })),
    },
  ];
}
