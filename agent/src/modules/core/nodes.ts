import { evaluateNodes } from '../../checks/nodes.check';
import { ageText, condition, Issue } from '../../checks/types';
import { raw, t } from '../../i18n/text';
import { buildNodes } from '../../views/nodes';
import { listSection, sections } from '../details';
import { cpuMilli, Inventory, parseQuantity } from '../../inventory/inventory';
import { bytes, pct } from '../format';
import { CoreCheck } from '../module';
import { DetailMeta, DetailRow, DetailSection, ModuleContext, ModuleResult, Stat } from '../types';

/** Memory and disk of each node. Memory from metrics-server, disk from node-exporter via Prometheus. */
export function evaluateNodeUsage(inv: Inventory, disk: Map<string, number> | undefined): Issue[] {
  const issues: Issue[] = [];
  for (const node of inv.nodes) {
    const name = node.metadata.name;
    const usage = inv.nodeUsage?.get(name);
    const memAlloc = parseQuantity(node.status?.allocatable?.memory);
    if (usage && memAlloc > 0) {
      const share = usage.memBytes / memAlloc;
      if (share >= 0.9) {
        issues.push({
          id: `nodes/${name}/memory`,
          check: 'nodes',
          severity: share >= 0.97 ? 'critical' : 'warning',
          title: t('nodes.memory.title', { node: name, pct: Math.round(share * 100) }),
          cause: t('nodes.memory.cause', { used: bytes(usage.memBytes), total: bytes(memAlloc) }),
          actions: [],
        });
      }
    }
    const d = disk?.get(name);
    if (d !== undefined && d >= 0.85) {
      issues.push({
        id: `nodes/${name}/disk`,
        check: 'nodes',
        severity: d >= 0.95 ? 'critical' : 'warning',
        title: t('nodes.disk.title', { node: name, pct: Math.round(d * 100) }),
        cause: t('nodes.disk.cause'),
        actions: [],
      });
    }
  }
  return issues;
}

function nodesStats(inv: Inventory): Stat[] {
  const ready = inv.nodes.filter((n) => condition(n.status?.conditions, 'Ready')?.status === 'True').length;
  let cpuAlloc = 0;
  let memAlloc = 0;
  let cpuUsed = 0;
  let memUsed = 0;
  for (const n of inv.nodes) {
    cpuAlloc += cpuMilli(n.status?.allocatable?.cpu);
    memAlloc += parseQuantity(n.status?.allocatable?.memory);
    const u = inv.nodeUsage?.get(n.metadata.name);
    cpuUsed += u?.cpuMilli ?? 0;
    memUsed += u?.memBytes ?? 0;
  }
  const stats: Stat[] = [{ label: t('stat.ready'), value: `${ready}/${inv.nodes.length}`, tone: ready === inv.nodes.length ? 'ok' : 'critical' }];
  // Three or four figures: use when metrics-server answers, the capacity otherwise (the Nodes tab shows both per node).
  if (inv.nodeUsage) {
    stats.push({ label: t('stat.cpu'), value: `${pct(cpuUsed, cpuAlloc)} %` }, { label: t('stat.ram'), value: `${pct(memUsed, memAlloc)} %` });
  } else {
    stats.push({ label: t('nodes.stat.cores'), value: String(Math.round(cpuAlloc / 1000)) }, { label: t('nodes.stat.memory'), value: bytes(memAlloc) });
  }
  return stats;
}

export class NodesCheck extends CoreCheck {
  readonly id = 'nodes';
  readonly name = t('module.nodes.name');
  readonly icon = 'hardware-chip-outline';
  readonly description = t('module.nodes.description');
  readonly reads = [];

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    if (ctx.prom) {
      ctx.data.nodeDisk = await nodeDiskUsage(ctx).catch(() => undefined);
    }
    const issues = [...evaluateNodes(ctx.inv.nodes), ...evaluateNodeUsage(ctx.inv, ctx.data.nodeDisk)];
    const notReady = issues.filter((i) => i.id.endsWith('/not-ready')).length;
    return {
      issues,
      stats: nodesStats(ctx.inv),
      details: nodeDetails(ctx),
      summary: notReady > 0 ? t('nodes.summary.notReady', { n: notReady }) : t('nodes.summary.ready', { n: ctx.inv.nodes.length }),
    };
  }
}

/** Root filesystem use per node; node-exporter's instance label is mapped to the node by its InternalIP or name. */
async function nodeDiskUsage(ctx: ModuleContext): Promise<Map<string, number>> {
  const samples = await ctx.prom!.query(
    '1 - max by (instance) (node_filesystem_avail_bytes{mountpoint="/",fstype!~"tmpfs|overlay"} / node_filesystem_size_bytes{mountpoint="/",fstype!~"tmpfs|overlay"})',
  );
  const byAddress = new Map<string, string>();
  for (const n of ctx.inv.nodes) {
    byAddress.set(n.metadata.name, n.metadata.name);
    for (const a of n.status?.addresses ?? []) {
      byAddress.set(a.address, n.metadata.name);
    }
  }
  const result = new Map<string, number>();
  for (const s of samples) {
    const host = (s.metric.instance ?? '').replace(/:\d+$/, '');
    const node = byAddress.get(host) ?? byAddress.get(s.metric.nodename ?? '');
    if (node) {
      result.set(node, s.value);
    }
  }
  return result;
}

/** One row per node: state, kubelet, conditions with since when, use and pods. */
function nodeDetails(ctx: ModuleContext): DetailSection[] {
  const rows = buildNodes(ctx.inv, ctx.data).map((n): DetailRow => {
    const meta: DetailMeta[] = n.conditions
      .filter((c) => c.type !== 'Ready')
      .map((c) => {
        const since = Date.parse(c.since ?? '');
        return { text: Number.isFinite(since) ? t('detail.node.conditionSince', { type: c.type, age: ageText(Math.max(0, ctx.now.getTime() - since)) }) : raw(c.type), tone: 'warning' as const };
      });
    if (n.cpu.usedMilli !== null && n.memory.used !== null) {
      meta.push({ text: t('detail.node.use', { cpu: pct(n.cpu.usedMilli, n.cpu.allocatableMilli), mem: pct(n.memory.used, n.memory.allocatable) }) });
    }
    meta.push({ text: t('detail.node.pods', { n: n.pods.count, capacity: n.pods.capacity }) });
    if (n.disk !== null) {
      meta.push({ text: t('detail.node.disk', { pct: Math.round(n.disk * 100) }), ...(n.disk >= 0.85 ? { tone: 'warning' as const } : {}) });
    }
    return {
      name: n.name,
      sub: raw([n.roles.join(', ') || 'worker', n.kubelet].filter(Boolean).join(', ')),
      value: !n.ready ? t('detail.notReady') : n.rebooting ? t('detail.kured.rebooting') : n.cordoned ? t('detail.node.cordoned') : t('detail.ready'),
      tone: !n.ready ? (n.rebooting || n.cordoned ? 'warning' : 'critical') : n.conditions.some((c) => c.type !== 'Ready') ? 'warning' : n.cordoned || n.rebooting ? 'muted' : 'ok',
      meta,
    };
  });
  return sections(listSection(t('detail.node.title'), rows));
}
