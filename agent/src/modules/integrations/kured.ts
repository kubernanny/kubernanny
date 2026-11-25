import { Detected } from '../../discovery/discovery';
import { Integration } from '../module';
import { Issue, ageText } from '../../checks/types';
import { t } from '../../i18n/text';
import { DetailRow, ModuleContext, ModuleResult, Stat } from '../types';
import { listSection, sections } from '../details';
import { record, str } from '../untrusted';

export class KuredIntegration extends Integration {
  readonly id = 'kured';
  readonly reads = [];
  override readonly untrusted = true;
  protected async inspect(ctx: ModuleContext, det: Detected): Promise<ModuleResult> {
    const ds = ctx.inv.daemonsets.find((d) => d.metadata.name === det.workloads[0]?.name && d.metadata.namespace === det.namespace);
    const lockRaw = ds?.metadata.annotations?.['weave.works/kured-node-lock'];
    let lock: { nodeID?: string; created?: string } | null = null;
    try {
      // Anyone who can annotate the DaemonSet writes this: read it like an untrusted answer.
      const parsed = record(lockRaw ? JSON.parse(lockRaw) : null);
      // kured with --concurrency > 1 writes {"maxOwners": n, "locks": [{nodeID, created}, …]}; take the oldest holder.
      const holders = Array.isArray(parsed.locks) ? parsed.locks.map((l) => record(l)) : [parsed];
      const first = holders.filter((h) => str(h.nodeID, 253)).sort((a, b) => String(a.created).localeCompare(String(b.created)))[0] ?? {};
      lock = { nodeID: str(first.nodeID, 253), created: str(first.created, 64) };
    } catch {
      lock = null;
    }
    const issues: Issue[] = [];
    const stats: Stat[] = [];
    if (lock?.nodeID) {
      ctx.data.kuredLock = lock.nodeID;
      const since = Date.parse(lock.created ?? '');
      stats.push({ label: t('kured.stat.rebooting'), value: lock.nodeID, tone: 'muted' });
      if (Number.isFinite(since) && ctx.now.getTime() - since > 2 * 3_600_000) {
        issues.push({
          id: 'kured/lock',
          check: 'nodes',
          severity: 'warning',
          title: t('kured.lock.title', { age: ageText(ctx.now.getTime() - since) }),
          cause: t('kured.lock.cause', { node: lock.nodeID }),
          actions: [],
        });
      }
    }
    let pendingNodes: string[] = [];
    // null: Prometheus does not scrape kured (no series at all), so nobody knows; not "0 waiting".
    let pendingKnown = false;
    if (ctx.prom) {
      const series = await ctx.prom.query('kured_reboot_required').catch(() => []);
      if (series.length > 0) {
        pendingKnown = true;
        pendingNodes = series.filter((p) => p.value === 1).map((p) => p.metric.node ?? p.metric.instance).filter(Boolean);
        stats.push({ label: t('stat.rebootPending'), value: String(pendingNodes.length), tone: pendingNodes.length ? 'muted' : 'ok' });
      }
    }
    const rows: DetailRow[] = [...new Set([...(lock?.nodeID ? [lock.nodeID] : []), ...pendingNodes])].map((node) => ({
      name: node,
      value: node === lock?.nodeID ? t('detail.kured.rebooting') : t('detail.kured.required'),
      tone: 'muted',
    }));
    return { issues, stats, details: sections(listSection(t('detail.kured.waiting'), rows)), summary: lock?.nodeID
        ? t('kured.summary.rebooting', { node: lock.nodeID })
        : pendingNodes.length
          ? t('kured.summary.waiting', { n: pendingNodes.length })
          : pendingKnown
            ? t('kured.summary.none')
            : t('kured.summary.idle'),
    };
  }
}
