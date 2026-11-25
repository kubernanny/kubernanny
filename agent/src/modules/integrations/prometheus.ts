import { Integration } from '../module';
import { Issue } from '../../checks/types';
import { raw, t } from '../../i18n/text';
import { DetailRow, ModuleContext, ModuleResult, Stat } from '../types';
import { listSection, prometheusDetails, sections } from '../details';
import { bytes } from '../format';

export class PrometheusIntegration extends Integration {
  readonly id = 'prometheus';
  readonly reads = [];
  override readonly untrusted = true;
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    if (!ctx.prom) {
      return { issues: [], stats: [], summary: t('integration.noReachableService') };
    }
    const prom = ctx.prom;
    const [up, down, series, blocks, retention, ruleFailures] = await Promise.all([
      prom.query('count by (job) (up)'),
      prom.query('up == 0'),
      prom.scalar('prometheus_tsdb_head_series').catch(() => null),
      prom.scalar('sum(prometheus_tsdb_storage_blocks_bytes)').catch(() => null),
      prom.scalar('max(prometheus_tsdb_retention_limit_seconds)').catch(() => null),
      prom.scalar('sum(increase(prometheus_rule_evaluation_failures_total[1h]))').catch(() => null),
    ]);
    // Why a target is down is only in the targets API; asked only when one is.
    const downTargets = down.length > 0 ? await prom.downTargets().catch(() => []) : [];
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
    if (blocks !== null) {
      stats.push({ label: t('prometheus.stat.tsdb'), value: bytes(blocks) });
    }
    const facts: DetailRow[] = [];
    if (retention !== null && retention > 0) {
      facts.push({ name: t('prometheus.fact.retention'), value: t('prometheus.fact.days', { n: Math.round(retention / 86_400) }), tone: 'muted' });
    }
    if (ruleFailures !== null) {
      facts.push({ name: t('prometheus.fact.ruleFailures'), value: String(Math.round(ruleFailures)), tone: ruleFailures >= 1 ? 'warning' : 'ok' });
    }
    const downRows: DetailRow[] = downTargets.map((x) => ({
      name: x.instance,
      sub: raw(x.job),
      tone: 'warning',
      ...(x.lastError ? { meta: [{ text: raw(x.lastError), tone: 'warning' as const }] } : {}),
    }));
    const details = [
      ...sections(listSection(t('prometheus.detail.down'), downRows)),
      ...prometheusDetails(up.map((u) => ({ job: u.metric.job ?? '?', total: u.value })), byJob),
      ...sections(facts.length ? { title: t('prometheus.detail.storage'), kind: 'list', rows: facts } : null),
    ];
    return { issues, stats, details, summary: down.length === 0 ? t('prometheus.summary.ok', { n: total }) : t('prometheus.summary.down', { down: down.length, total }) };
  }
}
