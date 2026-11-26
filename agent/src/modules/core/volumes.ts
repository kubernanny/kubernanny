import { ageText, Issue, IssueAction } from '../../checks/types';
import { t } from '../../i18n/text';
import { Inventory, Pvc, parseQuantity } from '../../inventory/inventory';
import { bytes } from '../format';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult } from '../types';

const GI = 2 ** 30;

/** The request after growing by a quarter, rounded up to whole Gi and at least 1 Gi more. */
export function grownSize(current: string): string | null {
  const bytesNow = parseQuantity(current);
  if (!(bytesNow > 0)) {
    return null;
  }
  const gi = Math.max(Math.ceil((bytesNow * 1.25) / GI), Math.floor(bytesNow / GI) + 1);
  return `${gi}Gi`;
}

/**
 * Whether a full volume can be grown from the app: only when its StorageClass
 * allows expansion and nothing else owns the claim's size. A CloudNativePG
 * instance volume follows the Cluster's `storage.size` (the operator would
 * resize it back or fight it), so the hint points there instead. A claim made
 * from a StatefulSet's volumeClaimTemplates grows, but the template stays.
 */
function expansion(inv: Inventory, pvc: Pvc): { actions: IssueAction[]; cnpg?: string } {
  const ns = pvc.metadata.namespace ?? 'default';
  const name = pvc.metadata.name;
  const cnpg = pvc.metadata.ownerReferences?.find((o) => o.kind === 'Cluster' && (o.apiVersion ?? '').startsWith('postgresql.cnpg.io/'));
  if (cnpg) {
    return { actions: [], cnpg: cnpg.name };
  }
  const sc = inv.storageClasses.find((c) => c.metadata.name === pvc.spec?.storageClassName);
  const from = pvc.spec?.resources?.requests?.storage;
  const to = from ? grownSize(from) : null;
  if (!sc?.allowVolumeExpansion || pvc.status?.phase !== 'Bound' || !from || !to) {
    return { actions: [] };
  }
  const template = inv.statefulsets.find(
    (s) =>
      s.metadata.namespace === ns &&
      ((s.spec as { volumeClaimTemplates?: { metadata?: { name?: string } }[] } | undefined)?.volumeClaimTemplates ?? []).some((v) => {
        const prefix = `${v.metadata?.name}-${s.metadata.name}-`;
        return v.metadata?.name !== undefined && name.startsWith(prefix) && /^\d+$/.test(name.slice(prefix.length));
      }),
  );
  return { actions: [{ type: 'pvc-expand', namespace: ns, name, from, to, ...(template ? { template: template.metadata.name } : {}) }] };
}

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
      const grow = expansion(inv, pvc);
      issues.push({
        id: `volumes/${key}/full`,
        check: 'longhorn',
        severity: share >= 0.95 ? 'critical' : 'warning',
        title: t('volumes.full.title', { volume: key, pct: Math.round(share * 100) }),
        cause: grow.cnpg ? t('volumes.full.cnpg', { used: bytes(u.used), total: bytes(u.capacity), cluster: grow.cnpg }) : t('volumes.full.cause', { used: bytes(u.used), total: bytes(u.capacity) }),
        actions: grow.actions,
      });
    }
  }
  return issues;
}

export class VolumesCheck extends CoreCheck {
  readonly id = 'volumes';
  override readonly uses = ['pvcs', 'pods'] as const;
  readonly name = t('module.volumes.name');
  readonly icon = 'albums-outline';
  readonly description = t('module.volumes.description');
  readonly reads = [];
  override readonly actions = ['pvc-expand'] as const;

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
