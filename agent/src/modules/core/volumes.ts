import { ageText, Issue } from '../../checks/types';
import { t } from '../../i18n/text';
import { Inventory, parseQuantity } from '../../inventory/inventory';
import { bytes } from '../format';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult } from '../types';

export function evaluateVolumes(inv: Inventory, usage: Map<string, { used: number; capacity: number }> | undefined): Issue[] {
  const issues: Issue[] = [];
  for (const pvc of inv.pvcs) {
    const ns = pvc.metadata.namespace ?? 'default';
    const key = `${ns}/${pvc.metadata.name}`;
    const phase = pvc.status?.phase;
    const created = Date.parse(pvc.metadata.creationTimestamp ?? '');
    if (phase === 'Lost') {
      issues.push({ id: `volumes/${key}`, check: 'longhorn', severity: 'critical', title: t('volumes.lost.title', { pvc: key }), cause: t('volumes.lost.cause'), actions: [] });
    } else if (phase === 'Pending' && Number.isFinite(created) && inv.at.getTime() - created > 5 * 60_000) {
      issues.push({
        id: `volumes/${key}`,
        check: 'longhorn',
        severity: 'warning',
        title: t('volumes.pending.title', { pvc: key, age: ageText(inv.at.getTime() - created) }),
        cause: t('volumes.pending.cause', { storageClass: pvc.spec?.storageClassName }),
        actions: [],
      });
    }
    const u = usage?.get(key);
    if (u && u.capacity > 0 && u.used / u.capacity >= 0.85) {
      const share = u.used / u.capacity;
      issues.push({
        id: `volumes/${key}/full`,
        check: 'longhorn',
        severity: share >= 0.95 ? 'critical' : 'warning',
        title: t('volumes.full.title', { volume: key, pct: Math.round(share * 100) }),
        cause: t('volumes.full.cause', { used: bytes(u.used), total: bytes(u.capacity) }),
        actions: [],
      });
    }
  }
  return issues;
}

export class VolumesCheck extends CoreCheck {
  readonly id = 'volumes';
  readonly name = t('module.volumes.name');
  readonly icon = 'albums-outline';
  readonly description = t('module.volumes.description');
  readonly reads = [];

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    if (ctx.prom) {
      ctx.data.volumeUsage = await volumeUsage(ctx).catch(() => undefined);
    }
    const issues = evaluateVolumes(ctx.inv, ctx.data.volumeUsage);
    const bound = ctx.inv.pvcs.filter((p) => p.status?.phase === 'Bound').length;
    const total = ctx.inv.pvcs.reduce((sum, p) => sum + parseQuantity(p.status?.capacity?.storage ?? p.spec?.resources?.requests?.storage), 0);
    return {
      issues,
      stats: [
        { label: t('volumes.stat.bound'), value: `${bound}/${ctx.inv.pvcs.length}`, tone: bound === ctx.inv.pvcs.length ? 'ok' : 'warning' },
        { label: t('volumes.stat.reserved'), value: bytes(total) },
        { label: t('volumes.stat.storageClasses'), value: String(ctx.inv.storageClasses.length) },
      ],
      summary: issues.length === 0 ? t('volumes.summary.ok', { n: ctx.inv.pvcs.length }) : t('volumes.summary.problems', { n: issues.length }),
    };
  }
}

async function volumeUsage(ctx: ModuleContext): Promise<Map<string, { used: number; capacity: number }>> {
  const [used, cap] = await Promise.all([
    ctx.prom!.query('max by (namespace, persistentvolumeclaim) (kubelet_volume_stats_used_bytes)'),
    ctx.prom!.query('max by (namespace, persistentvolumeclaim) (kubelet_volume_stats_capacity_bytes)'),
  ]);
  const capacity = new Map(cap.map((s) => [`${s.metric.namespace}/${s.metric.persistentvolumeclaim}`, s.value]));
  return new Map(
    used.map((s) => {
      const key = `${s.metric.namespace}/${s.metric.persistentvolumeclaim}`;
      return [key, { used: s.value, capacity: capacity.get(key) ?? 0 }];
    }),
  );
}
