import { evaluateEtcd } from '../../checks/etcd.check';
import { EtcdSnapshot, evaluateEtcdSnapshots } from '../../checks/maintenance.check';
import { podReady } from '../../checks/pods.check';
import { ageText } from '../../checks/types';
import { t } from '../../i18n/text';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult, Stat } from '../types';

export class EtcdCheck extends CoreCheck {
  readonly id = 'etcd';
  readonly name = t('module.etcd.name');
  readonly icon = 'layers-outline';
  readonly description = t('module.etcd.description');
  readonly reads = [{ group: 'k3s.cattle.io', resource: 'etcdsnapshotfiles', why: 'age of the newest etcd snapshot (k3s, RKE2)' }];
  override readonly actions = ['logs'] as const;

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    const pods = ctx.inv.pods.filter((p) => p.metadata.namespace === 'kube-system' && p.metadata.labels?.component === 'etcd');
    const issues = evaluateEtcd(pods) ?? [];
    // RKE2 and k3s record every etcd snapshot; other distributions have no such CRD (null: skipped).
    const snapshots = pods.length > 0 ? await ctx.kube.list<EtcdSnapshot>('/apis/k3s.cattle.io/v1/etcdsnapshotfiles').catch(() => null) : null;
    if (snapshots) {
      ctx.data.etcdSnapshots = snapshots;
      issues.push(...evaluateEtcdSnapshots(snapshots, ctx.now, ctx.config.backupMaxAgeHours));
    }
    const ready = pods.filter(podReady).length;
    const stats: Stat[] = pods.length > 0 ? [{ label: t('etcd.stat.membersReady'), value: `${ready}/${pods.length}`, tone: ready === pods.length ? 'ok' : 'warning' }] : [];
    if (pods.length > 0 && ctx.prom) {
      const fsync = await ctx.prom
        .scalar('histogram_quantile(0.99, sum by (le) (rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m])))')
        .catch(() => null);
      if (fsync !== null) {
        stats.push({ label: t('etcd.stat.walFsync'), value: `${(fsync * 1000).toFixed(1)} ms`, tone: fsync > 0.01 ? 'warning' : 'ok' });
      }
      const leaderChanges = await ctx.prom.scalar('max(increase(etcd_server_leader_changes_seen_total[1h]))').catch(() => null);
      if (leaderChanges !== null) {
        stats.push({ label: t('etcd.stat.leaderChanges'), value: String(Math.round(leaderChanges)), tone: leaderChanges > 3 ? 'warning' : 'ok' });
      }
    }
    if (snapshots && snapshots.length > 0) {
      const newest = Math.max(...snapshots.map((s) => Date.parse(s.status?.creationTime ?? s.metadata.creationTimestamp ?? '')).filter(Number.isFinite));
      stats.push({ label: t('etcd.stat.snapshots'), value: String(snapshots.length) }, { label: t('etcd.stat.lastSnapshot'), value: t('common.ago', { age: ageText(ctx.now.getTime() - newest) }) });
    }
    return {
      issues,
      stats,
      summary: pods.length === 0 ? t('etcd.summary.none') : issues.length === 0 ? t('etcd.summary.ok', { n: pods.length }) : issues[0].title,
    };
  }
}
