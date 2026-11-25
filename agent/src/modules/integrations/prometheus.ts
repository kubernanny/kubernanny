import { Integration } from '../module';
import { Issue } from '../../checks/types';
import { t } from '../../i18n/text';
import { ModuleContext, ModuleResult, Stat } from '../types';

export class PrometheusIntegration extends Integration {
  readonly id = 'prometheus';
  readonly reads = [];
  override readonly untrusted = true;
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    if (!ctx.prom) {
      return { issues: [], stats: [], summary: t('integration.noReachableService') };
    }
    const [up, down, series] = await Promise.all([
      ctx.prom.query('count by (job) (up)'),
      ctx.prom.query('up == 0'),
      ctx.prom.scalar('prometheus_tsdb_head_series').catch(() => null),
    ]);
    const total = up.reduce((s, x) => s + x.value, 0);
    const byJob = new Map<string, string[]>();
    for (const d of down) {
      const job = d.metric.job ?? '?';
      byJob.set(job, [...(byJob.get(job) ?? []), d.metric.instance ?? '?']);
    }
    const issues: Issue[] = [...byJob.entries()].map(([job, instances]) => ({
      id: `prometheus/down/${job}`,
      check: 'prometheus',
      severity: 'warning',
      title: t('prometheus.down.title', { job, n: instances.length }),
      cause: t('prometheus.down.cause', { targets: `${instances.slice(0, 3).join(', ')}${instances.length > 3 ? ' …' : ''}` }),
      actions: [],
    }));
    const stats: Stat[] = [
      { label: t('prometheus.stat.reachable'), value: `${total - down.length}/${total}`, tone: down.length === 0 ? 'ok' : 'warning' },
      { label: t('prometheus.stat.jobs'), value: String(up.length) },
    ];
    if (series !== null) {
      stats.push({ label: t('prometheus.stat.series'), value: t('common.number', { n: Math.round(series) }) });
    }
    return { issues, stats, summary: down.length === 0 ? t('prometheus.summary.ok', { n: total }) : t('prometheus.summary.down', { down: down.length, total }) };
  }
}
