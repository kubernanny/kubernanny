import { rawOr, t } from '../i18n/text';
import { Condition, Issue, IssueAction, ObjectMeta, ageText, condition } from './types';

export interface CnpgCluster {
  metadata: ObjectMeta;
  spec?: { instances?: number; backup?: { barmanObjectStore?: { destinationPath?: string } } | null; plugins?: { name: string }[] };
  status?: {
    phase?: string;
    instances?: number;
    readyInstances?: number;
    currentPrimary?: string;
    lastSuccessfulBackup?: string;
    lastFailedBackup?: string;
    conditions?: Condition[];
  };
}

export interface CnpgOptions {
  /** A daily ScheduledBackup plus slack. */
  backupMaxAgeHours: number;
}

const HEALTHY_PHASE = 'Cluster in healthy state';

export function hasBackup(cluster: CnpgCluster): boolean {
  return Boolean(cluster.spec?.backup) || Boolean(cluster.spec?.plugins?.some((p) => p.name.includes('barman')));
}

export function evaluateCnpg(clusters: CnpgCluster[], now: Date, opts: CnpgOptions): Issue[] {
  const issues: Issue[] = [];
  for (const c of clusters) {
    const ns = c.metadata.namespace ?? 'default';
    const name = c.metadata.name;
    const base = `cnpg/${ns}/${name}`;
    const backupAction: IssueAction = { type: 'cnpg-backup', namespace: ns, cluster: name };
    const primaryLogs: IssueAction[] = c.status?.currentPrimary
      ? [{ type: 'logs', namespace: ns, pod: c.status.currentPrimary, container: 'postgres' }]
      : [];

    const wanted = c.spec?.instances ?? c.status?.instances ?? 1;
    const ready = c.status?.readyInstances ?? 0;
    if (ready === 0) {
      issues.push({
        id: `${base}/instances`,
        check: 'cnpg',
        severity: 'critical',
        title: t('cnpg.noInstance.title', { cluster: `${ns}/${name}` }),
        cause: rawOr(c.status?.phase, t('cnpg.noInstance.cause')),
        actions: primaryLogs,
      });
    } else if (ready < wanted || (c.status?.phase && c.status.phase !== HEALTHY_PHASE)) {
      issues.push({
        id: `${base}/instances`,
        check: 'cnpg',
        severity: 'warning',
        title: t('cnpg.instances.title', { cluster: `${ns}/${name}`, ready, wanted }),
        cause: rawOr(c.status?.phase, t('cnpg.instances.cause')),
        actions: primaryLogs,
      });
    }

    if (!hasBackup(c)) {
      continue;
    }

    // WAL archiving failing is the quiet killer: the primary keeps every
    // segment it cannot upload until its volume is full.
    const archiving = condition(c.status?.conditions, 'ContinuousArchiving');
    if (archiving?.status === 'False') {
      issues.push({
        id: `${base}/archiving`,
        check: 'cnpg',
        severity: 'critical',
        title: t('cnpg.archiving.title', { cluster: `${ns}/${name}` }),
        cause: t('cnpg.archiving.cause', { message: archiving.message ?? archiving.reason }),
        actions: primaryLogs,
      });
    }

    const lastOk = Date.parse(c.status?.lastSuccessfulBackup ?? '');
    const lastFailed = Date.parse(c.status?.lastFailedBackup ?? '');
    const maxAge = opts.backupMaxAgeHours * 3_600_000;
    if (!Number.isFinite(lastOk)) {
      issues.push({
        id: `${base}/backup`,
        check: 'cnpg',
        severity: 'warning',
        title: t('cnpg.noBackup.title', { cluster: `${ns}/${name}` }),
        cause: t('cnpg.noBackup.cause'),
        actions: [backupAction],
      });
    } else if (now.getTime() - lastOk > maxAge) {
      const age = now.getTime() - lastOk;
      const failedSince = Number.isFinite(lastFailed) && lastFailed > lastOk;
      issues.push({
        id: `${base}/backup`,
        check: 'cnpg',
        severity: age > 2 * maxAge ? 'critical' : 'warning',
        title: t('cnpg.oldBackup.title', { cluster: `${ns}/${name}`, age: ageText(age) }),
        cause: failedSince
          ? t('cnpg.oldBackup.failing', { at: c.status?.lastFailedBackup?.slice(0, 16).replace('T', ' ') ?? '' })
          : t('cnpg.oldBackup.expected', { hours: opts.backupMaxAgeHours }),
        actions: [backupAction],
      });
    }
  }
  return issues;
}
