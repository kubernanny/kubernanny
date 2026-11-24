import { t } from '../i18n/text';
import { Issue, ObjectMeta } from './types';

export interface LonghornVolume {
  metadata: ObjectMeta;
  spec?: { numberOfReplicas?: number };
  status?: {
    state?: string;
    robustness?: string;
    kubernetesStatus?: { namespace?: string; pvcName?: string; workloadsStatus?: { podName: string }[] };
  };
}

/**
 * `robustness` is Longhorn's own verdict: degraded = fewer healthy replicas
 * than asked for (still serving, rebuilding), faulted = no healthy replica
 * left. A detached volume reports `unknown`, which is normal.
 */
export function evaluateLonghorn(volumes: LonghornVolume[]): Issue[] {
  const issues: Issue[] = [];
  for (const v of volumes) {
    const robustness = v.status?.robustness;
    if (robustness !== 'degraded' && robustness !== 'faulted') {
      continue;
    }
    const k8s = v.status?.kubernetesStatus;
    const label = k8s?.pvcName ? `${k8s.namespace}/${k8s.pvcName}` : v.metadata.name;
    const users = k8s?.workloadsStatus?.map((w) => w.podName).join(', ');
    issues.push({
      id: `longhorn/${v.metadata.name}`,
      check: 'longhorn',
      severity: robustness === 'faulted' ? 'critical' : 'warning',
      title: t('longhorn.volume.title', { volume: label, robustness }),
      cause: robustness === 'faulted' ? t('longhorn.volume.faulted', { users: users || undefined }) : t('longhorn.volume.degraded', { replicas: String(v.spec?.numberOfReplicas ?? '?') }),
      actions: [],
    });
  }
  return issues;
}
