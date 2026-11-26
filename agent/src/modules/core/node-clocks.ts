import { Issue } from '../../checks/types';
import { t, Text } from '../../i18n/text';
import { withUnit } from '../format';
import { Inventory } from '../../inventory/inventory';
import { PromSample } from '../service-proxy';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult } from '../types';

/**
 * Clock offset of a node from its time source, in seconds.
 *
 * - warning above 0.5 s: half of the 1 s at which etcd starts logging clock
 *   drift between members, and far beyond the few milliseconds a running
 *   NTP or chrony keeps a server at.
 * - critical above 5 s: the clock is not being corrected and keeps drifting;
 *   certificates and tokens checked against it fail as the gap grows (a
 *   freshly issued certificate is "not yet valid" on a slow node, and the
 *   API server accepts JWT times only within a minute of its own clock).
 */
const CLOCK_WARNING_S = 0.5;
const CLOCK_CRITICAL_S = 5;

export interface NodeClock {
  node: string;
  /** node_timex_offset_seconds (timex collector, on by default), else node_ntp_offset_seconds (ntp collector, off by default). */
  offset?: number;
  /** False when the kernel says the clock is not synchronised and its maximum error has grown to 16 s (kube-prometheus' NodeClockNotSynchronising). */
  synchronised?: boolean;
  /** node_timex_estimated_error_seconds: the time daemon's own estimate of how far off the clock may be. */
  estimatedError?: number;
}

export function evaluateNodeClocks(clocks: NodeClock[]): Issue[] {
  const issues: Issue[] = [];
  for (const c of clocks) {
    const off = Math.abs(c.offset ?? 0);
    if (off > CLOCK_WARNING_S) {
      issues.push({
        id: `node-clocks/${c.node}`,
        check: 'node-clocks',
        severity: off > CLOCK_CRITICAL_S ? 'critical' : 'warning',
        title: t('nodeClocks.skew.title', { node: c.node, seconds: off < 10 ? Math.round(off * 100) / 100 : Math.round(off) }),
        cause: t('nodeClocks.skew.cause'),
        actions: [],
      });
    } else if (c.synchronised === false) {
      issues.push({ id: `node-clocks/${c.node}`, check: 'node-clocks', severity: 'warning', title: t('nodeClocks.unsynced.title', { node: c.node }), cause: t('nodeClocks.unsynced.cause'), actions: [] });
    }
  }
  return issues;
}

/** node-exporter's instance label ("10.0.0.4:9100") or nodename, mapped to the Node by name or address. */
export function nodeOf(inv: Inventory, s: PromSample): string | undefined {
  const host = (s.metric.instance ?? '').replace(/:\d+$/, '');
  for (const n of inv.nodes) {
    const names = [n.metadata.name, ...(n.status?.addresses ?? []).map((a) => a.address)];
    if (names.includes(host) || names.includes(s.metric.nodename ?? '')) {
      return n.metadata.name;
    }
  }
  return undefined;
}

async function readNodeClocks(ctx: ModuleContext): Promise<NodeClock[]> {
  const prom = ctx.prom!;
  const [timex, ntp, status, maxError, estimated] = await Promise.all([
    prom.query('max by (instance) (node_timex_offset_seconds)').catch(() => []),
    prom.query('max by (instance) (node_ntp_offset_seconds)').catch(() => []),
    prom.query('min by (instance) (min_over_time(node_timex_sync_status[5m]))').catch(() => []),
    prom.query('max by (instance) (node_timex_maxerror_seconds)').catch(() => []),
    prom.query('max by (instance) (node_timex_estimated_error_seconds)').catch(() => []),
  ]);
  const clocks = new Map<string, NodeClock>();
  const at = (s: PromSample) => {
    const node = nodeOf(ctx.inv, s);
    return node ? (clocks.get(node) ?? clocks.set(node, { node }).get(node)!) : undefined;
  };
  for (const s of ntp) {
    const c = at(s);
    if (c) {
      c.offset = s.value;
    }
  }
  // timex wins: it is what the kernel itself applies. But chrony (the default
  // on most distributions) disciplines the clock without the kernel PLL and
  // leaves the timex offset at exactly 0: that is "not reported", not "0 ms off".
  for (const s of timex) {
    const c = at(s);
    if (c && s.value !== 0) {
      c.offset = s.value;
    }
  }
  for (const s of estimated) {
    const c = at(s);
    if (c) {
      c.estimatedError = s.value;
    }
  }
  const errors = new Map(maxError.map((s) => [nodeOf(ctx.inv, s), s.value]));
  for (const s of status) {
    const c = at(s);
    if (c) {
      c.synchronised = !(s.value === 0 && (errors.get(c.node) ?? 0) >= 16);
    }
  }
  return [...clocks.values()];
}

export class NodeClocksCheck extends CoreCheck {
  readonly id = 'node-clocks';
  readonly name = t('module.nodeClocks.name');
  readonly icon = 'time-outline';
  readonly description = t('module.nodeClocks.description');
  readonly reads = [];

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    if (!ctx.prom) {
      return { issues: [], stats: [{ label: t('nodeClocks.stat.source'), value: t('nodeClocks.needsPrometheus'), tone: 'muted' }], summary: t('nodeClocks.summary.noPrometheus') };
    }
    const clocks = await readNodeClocks(ctx);
    const issues = evaluateNodeClocks(clocks);
    const measured = clocks.filter((c) => c.offset !== undefined);
    const worst = measured.reduce((m, c) => Math.max(m, Math.abs(c.offset!)), 0);
    const ms = (v: number): string | Text => (v < 0.001 ? '< 1 ms' : v < 1 ? `${Math.round(v * 1000)} ms` : withUnit(v, 's'));
    if (measured.length === 0) {
      // No offset (chrony): the kernel still says whether the clock is synchronised, and the daemon how far off it may be.
      const known = clocks.filter((c) => c.synchronised !== undefined);
      if (known.length === 0) {
        return { issues, stats: [{ label: t('nodeClocks.stat.source'), value: t('nodeClocks.noMetrics'), tone: 'muted' }], summary: issues[0]?.title ?? t('nodeClocks.summary.noMetrics') };
      }
      const synced = known.filter((c) => c.synchronised).length;
      const errors = clocks.map((c) => c.estimatedError).filter((v): v is number => v !== undefined);
      return {
        issues,
        stats: [
          { label: t('nodeClocks.stat.synced'), value: `${synced}/${ctx.inv.nodes.length}`, tone: synced === known.length ? 'ok' : 'warning' },
          ...(errors.length ? [{ label: t('nodeClocks.stat.estimatedError'), value: ms(Math.max(...errors)) }] : []),
        ],
        summary: issues[0]?.title ?? t('nodeClocks.summary.synced', { n: synced }),
      };
    }
    return {
      issues,
      stats: [
        { label: t('nodeClocks.stat.measured'), value: `${measured.length}/${ctx.inv.nodes.length}` },
        { label: t('nodeClocks.stat.worst'), value: ms(worst), tone: worst > CLOCK_CRITICAL_S ? 'critical' : worst > CLOCK_WARNING_S ? 'warning' : 'ok' },
      ],
      summary: issues[0]?.title ?? t('nodeClocks.summary.ok', { n: measured.length }),
    };
  }
}
