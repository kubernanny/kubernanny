import { CnpgCluster, evaluateCnpg } from '../../checks/cnpg.check';
import { ageText } from '../../checks/types';
import { t } from '../../i18n/text';
import { cnpgDetails, CnpgScheduledBackup } from '../details';
import { Integration } from '../module';
import { ModuleContext, ModuleResult, Stat } from '../types';

export class CnpgIntegration extends Integration {
  readonly id = 'cnpg';
  override readonly actions = ['cnpg-backup', 'logs'] as const;
  readonly reads = [
    {
      group: 'postgresql.cnpg.io',
      resource: 'clusters',
      why: 'instances, failover state and last backup per database cluster',
    },
    {
      group: 'postgresql.cnpg.io',
      resource: 'scheduledbackups',
      why: 'schedule and last and next run of every scheduled backup, for the sheet',
    },
  ];
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const [clusters, scheduled] = await Promise.all([
      ctx.kube.list<CnpgCluster>('/apis/postgresql.cnpg.io/v1/clusters').then((l) => l ?? []),
      ctx.kube.list<CnpgScheduledBackup>('/apis/postgresql.cnpg.io/v1/scheduledbackups').catch(() => null),
    ]);
    ctx.data.cnpgClusters = clusters;
    const issues = evaluateCnpg(clusters, ctx.now, { backupMaxAgeHours: ctx.config.backupMaxAgeHours });
    const instances = clusters.reduce((s, c) => s + (c.spec?.instances ?? 0), 0);
    const ready = clusters.reduce((s, c) => s + (c.status?.readyInstances ?? 0), 0);
    const backups = clusters.map((c) => Date.parse(c.status?.lastSuccessfulBackup ?? '')).filter(Number.isFinite);
    const oldest = backups.length ? Math.min(...backups) : null;
    const stats: Stat[] = [
      { label: t('cnpg.stat.clusters'), value: String(clusters.length) },
      {
        label: t('cnpg.stat.instancesReady'),
        value: `${ready}/${instances}`,
        tone: ready === instances ? 'ok' : 'warning',
      },
    ];
    if (oldest !== null) {
      stats.push({
        label: t('cnpg.stat.oldestBackup'),
        value: t('common.ago', { age: ageText(ctx.now.getTime() - oldest) }),
        tone: ctx.now.getTime() - oldest > ctx.config.backupMaxAgeHours * 3_600_000 ? 'warning' : 'ok',
      });
    }
    const details = cnpgDetails(clusters, ctx.now, ctx.config.backupMaxAgeHours, scheduled ?? []);
    return {
      issues,
      stats,
      details,
      summary: issues.length === 0 ? t('cnpg.summary.ok', { n: clusters.length }) : issues[0].title,
    };
  }
}
