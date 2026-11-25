import { Detected } from '../../discovery/discovery';
import { Integration } from '../module';
import { Issue, ageText } from '../../checks/types';
import { t } from '../../i18n/text';
import { ModuleContext, ModuleResult, Stat } from '../types';
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
      lock = { nodeID: str(parsed.nodeID, 253), created: str(parsed.created, 64) };
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
    if (ctx.prom) {
      const pending = await ctx.prom.query('kured_reboot_required == 1').catch(() => []);
      const nodes = pending.map((p) => p.metric.node ?? p.metric.instance).filter(Boolean);
      stats.push({ label: t('kured.stat.rebootRequired'), value: nodes.length ? nodes.join(', ') : t('common.none'), tone: nodes.length ? 'muted' : 'ok' });
    }
    return { issues, stats, summary: lock?.nodeID ? t('kured.summary.rebooting', { node: lock.nodeID }) : t('kured.summary.waiting') };
  }
}
