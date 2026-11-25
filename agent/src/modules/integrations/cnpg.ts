import { Integration } from '../module';
import { CnpgCluster, evaluateCnpg } from '../../checks/cnpg.check';
import { ageText } from '../../checks/types';
import {ModuleContext, ModuleResult, Stat } from '../types';
import { raw, t } from '../../i18n/text';

export class CnpgIntegration extends Integration {
  readonly id = 'cnpg';
  override readonly actions = ['cnpg-backup', 'logs'] as const;
  readonly reads = [{ group: 'postgresql.cnpg.io', resource: 'clusters', why: 'instances, failover state and last backup per database cluster' }];
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const clusters = (await ctx.kube.list<CnpgCluster>('/apis/postgresql.cnpg.io/v1/clusters')) ?? [];
    ctx.data.cnpgClusters = clusters;
    const issues = evaluateCnpg(clusters, ctx.now, { backupMaxAgeHours: ctx.config.backupMaxAgeHours });
    const instances = clusters.reduce((s, c) => s + (c.spec?.instances ?? 0), 0);
    const ready = clusters.reduce((s, c) => s + (c.status?.readyInstances ?? 0), 0);
    const backups = clusters.map((c) => Date.parse(c.status?.lastSuccessfulBackup ?? '')).filter(Number.isFinite);
    const oldest = backups.length ? Math.min(...backups) : null;
    const stats: Stat[] = [
      { label: t('cnpg.stat.clusters'), value: String(clusters.length) },
      { label: t('cnpg.stat.instancesReady'), value: `${ready}/${instances}`, tone: ready === instances ? 'ok' : 'warning' },
    ];
    if (oldest !== null) {
      stats.push({ label: t('cnpg.stat.oldestBackup'), value: t('common.ago', { age: ageText(ctx.now.getTime() - oldest) }), tone: ctx.now.getTime() - oldest > ctx.config.backupMaxAgeHours * 3_600_000 ? 'warning' : 'ok' });
    }
    for (const c of clusters) {
      stats.push({
        label: raw(`${c.metadata.namespace}/${c.metadata.name}`),
        value: `${c.status?.readyInstances ?? 0}/${c.spec?.instances ?? 0} · Primary ${c.status?.currentPrimary ?? '?'}`,
        tone: c.status?.phase === 'Cluster in healthy state' ? 'ok' : 'warning',
      });
    }
    return { issues, stats, summary: issues.length === 0 ? t('cnpg.summary.ok', { n: clusters.length }) : issues[0].title };
  }
}
