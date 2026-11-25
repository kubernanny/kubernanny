/**
 * Where one run spent its time, as detail sections for the Kubernanny
 * component's own sheet: reading the cluster, the integrations (all at once),
 * the core checks (after them), and Prometheus (how many queries, their sum
 * and the slowest). Modules run in parallel, so module times overlap and do
 * not add up to the total.
 */
import { raw, t } from '../i18n/text';
import { DetailRow, DetailSection } from '../modules/types';

export interface RunTimingInput {
  inventoryMs: number;
  componentsMs: number;
  coreMs: number;
  totalMs: number;
  moduleMs: Map<string, number>;
  /** Every Prometheus query of the run with its time; null without Prometheus. */
  prometheus: { expr: string; ms: number }[] | null;
}

const ms = (n: number) => t('timing.ms', { n: Math.round(n) });

export function runTiming(r: RunTimingInput): DetailSection[] {
  const phases: DetailRow[] = [
    { name: t('timing.inventory'), value: ms(r.inventoryMs), tone: 'muted' },
    { name: t('timing.components'), value: ms(r.componentsMs), tone: 'muted' },
    { name: t('timing.core'), value: ms(r.coreMs), tone: 'muted' },
  ];
  if (r.prometheus) {
    const total = r.prometheus.reduce((s, q) => s + q.ms, 0);
    const slowest = r.prometheus.reduce((m, q) => Math.max(m, q.ms), 0);
    phases.push({
      name: t('timing.prometheus'),
      sub: t('timing.prometheusSub', { n: r.prometheus.length, sum: ms(total), slowest: ms(slowest) }),
      value: t('timing.queries', { n: r.prometheus.length }),
      tone: 'muted',
    });
  }
  phases.push({ name: t('timing.total'), value: ms(r.totalMs), tone: 'ok' });
  const modules: DetailRow[] = [...r.moduleMs.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, n]) => ({ name: id, value: ms(n), tone: 'muted' }));
  const queries: DetailRow[] = [...(r.prometheus ?? [])]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 4)
    .map((q) => ({ name: raw(q.expr.length > 90 ? `${q.expr.slice(0, 89)}…` : q.expr), value: ms(q.ms), tone: 'muted' }));
  return [
    { title: t('timing.title'), kind: 'list', rows: phases },
    ...(modules.length ? [{ title: t('timing.slowestModules'), kind: 'list' as const, rows: modules }] : []),
    ...(queries.length ? [{ title: t('timing.slowestQueries'), kind: 'list' as const, rows: queries }] : []),
  ];
}
