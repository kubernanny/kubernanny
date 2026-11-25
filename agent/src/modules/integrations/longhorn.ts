import { Integration } from '../module';
import { LonghornVolume, evaluateLonghorn } from '../../checks/longhorn.check';
import { LonghornBackup, LonghornBackupTarget, evaluateLonghornBackups } from '../../checks/maintenance.check';
import { ageText } from '../../checks/types';
import { bytes, pct } from '../format';
import { rawOr, t } from '../../i18n/text';
import { LonghornNode, ModuleContext, ModuleResult, Stat } from '../types';

export class LonghornIntegration extends Integration {
  readonly id = 'longhorn';
  readonly reads = [
    { group: 'longhorn.io', resource: 'volumes', why: 'robustness (degraded, faulted) and size of every volume' },
    { group: 'longhorn.io', resource: 'nodes', why: 'disk space and schedulability per storage node' },
    { group: 'longhorn.io', resource: 'backups', why: 'age of the newest backup per volume' },
    { group: 'longhorn.io', resource: 'backuptargets', why: 'whether the backup target is reachable' },
  ];
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const [volumes, nodes, backups, targets] = await Promise.all([
      ctx.kube.list<LonghornVolume>('/apis/longhorn.io/v1beta2/volumes'),
      ctx.kube.list<LonghornNode>('/apis/longhorn.io/v1beta2/nodes').catch(() => null),
      ctx.kube.list<LonghornBackup>('/apis/longhorn.io/v1beta2/backups').catch(() => null),
      ctx.kube.list<LonghornBackupTarget>('/apis/longhorn.io/v1beta2/backuptargets').catch(() => null),
    ]);
    ctx.data.longhornVolumes = volumes ?? [];
    ctx.data.longhornNodes = nodes ?? [];
    ctx.data.longhornBackups = backups ?? [];
    ctx.data.longhornBackupTargets = targets ?? [];
    const issues = [...evaluateLonghorn(volumes ?? []), ...evaluateLonghornBackups(targets ?? [], backups ?? [], ctx.now, ctx.config.backupMaxAgeHours)];
    let available = 0;
    let maximum = 0;
    let scheduled = 0;
    for (const node of nodes ?? []) {
      for (const disk of Object.values(node.status?.diskStatus ?? {})) {
        available += disk.storageAvailable ?? 0;
        maximum += disk.storageMaximum ?? 0;
        scheduled += disk.storageScheduled ?? 0;
      }
      const ready = node.status?.conditions?.find((c) => c.type === 'Ready');
      if (ready && ready.status !== 'True') {
        issues.push({
          id: `longhorn/node/${node.metadata.name}`,
          check: 'longhorn',
          severity: 'warning',
          title: t('longhorn.node.title', { node: node.metadata.name }),
          cause: rawOr(ready.message, t('longhorn.node.cause')),
          actions: [],
        });
      }
    }
    if (maximum > 0 && available / maximum < 0.15) {
      issues.push({
        id: 'longhorn/capacity',
        check: 'longhorn',
        severity: available / maximum < 0.05 ? 'critical' : 'warning',
        title: t('longhorn.capacity.title', { free: bytes(available) }),
        cause: t('longhorn.capacity.cause', { pct: pct(maximum - available, maximum) }),
        actions: [],
      });
    }
    const all = volumes ?? [];
    const healthy = all.filter((v) => v.status?.robustness === 'healthy').length;
    const attached = all.filter((v) => v.status?.state === 'attached').length;
    const stats: Stat[] = [
      { label: t('longhorn.stat.healthy'), value: `${healthy}/${attached}`, tone: healthy === attached ? 'ok' : 'warning' },
      { label: t('longhorn.stat.total'), value: String(all.length) },
    ];
    if (maximum > 0) {
      stats.push(
        { label: t('longhorn.stat.diskFree'), value: t('common.ofTotal', { part: bytes(available), total: bytes(maximum) }), tone: available / maximum < 0.15 ? 'warning' : 'ok' },
        { label: t('longhorn.stat.scheduled'), value: `${pct(scheduled, maximum)} %` },
      );
    }
    stats.push({ label: t('longhorn.stat.nodes'), value: String(nodes?.length ?? 0) });
    if (backups && backups.length > 0) {
      const completed = backups.filter((b) => b.status?.state === 'Completed').map((b) => Date.parse(b.status?.backupCreatedAt || b.metadata.creationTimestamp || '')).filter(Number.isFinite);
      stats.push({ label: t('stat.backups'), value: String(backups.length) });
      if (completed.length) {
        stats.push({ label: t('stat.lastBackup'), value: t('common.ago', { age: ageText(ctx.now.getTime() - Math.max(...completed)) }) });
      }
    }
    for (const target of targets ?? []) {
      if (target.spec?.backupTargetURL) {
        stats.push({
          label: t('longhorn.stat.backupTarget'),
          value: target.status?.available === false ? t('longhorn.target.unreachable') : t('longhorn.target.reachable'),
          tone: target.status?.available === false ? 'critical' : 'ok',
        });
      }
    }
    return { issues, stats, summary: issues.length === 0 ? t('longhorn.summary.ok', { n: attached }) : issues[0].title };
  }
}
