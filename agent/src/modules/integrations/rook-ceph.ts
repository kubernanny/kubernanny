import { Issue, IssueSeverity } from '../../checks/types';
import { raw, rawOr, t } from '../../i18n/text';
import { bytes } from '../format';
import { Integration } from '../module';
import { ModuleContext, ModuleResult, Stat } from '../types';

/** The part of a CephCluster (ceph.rook.io/v1) the check reads. Rook copies `ceph status` into `status.ceph` about once a minute. */
export interface CephCluster {
  metadata: { name: string; namespace?: string };
  status?: {
    phase?: string;
    message?: string;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
    ceph?: {
      health?: string;
      lastChecked?: string;
      details?: Record<string, { message?: string; severity?: string }>;
      capacity?: { bytesAvailable?: number; bytesTotal?: number; bytesUsed?: number };
    };
  };
}

/**
 * Raw capacity used, cluster-wide. Ceph's own defaults are nearfull 85 %,
 * backfillfull 90 % and full 95 % (mon_osd_nearfull_ratio,
 * mon_osd_backfillfull_ratio, mon_osd_full_ratio), but they apply per OSD,
 * and OSDs never fill evenly: when the cluster average reaches 75 % the
 * fullest OSD is often near 85 % already, and at an average of 85 % some OSD
 * is close to the point where Ceph stops writes. Ceph's own OSD_NEARFULL /
 * OSD_FULL health checks still come through `status.ceph.health`.
 */
const CEPH_USED_WARNING = 0.75;
const CEPH_USED_CRITICAL = 0.85;
/** Rook refreshes `status.ceph` every 60 s; this much older and the operator has stopped looking. */
const CEPH_STALE_MS = 15 * 60_000;
const MAX_DETAILS = 3;

/** Health, capacity and the operator's view of every CephCluster. */
export function evaluateRookCeph(clusters: CephCluster[], now: Date): Issue[] {
  const issues: Issue[] = [];
  for (const c of clusters) {
    const name = c.metadata.name;
    const base = `rook-ceph/${c.metadata.namespace ?? '-'}/${name}`;
    const ceph = c.status?.ceph;
    if (ceph?.health === 'HEALTH_WARN' || ceph?.health === 'HEALTH_ERR') {
      // HEALTH_ERR checks first: they are why the cluster is in error.
      const details = Object.entries(ceph.details ?? {}).sort(
        ([, a], [, b]) => Number(b.severity === 'HEALTH_ERR') - Number(a.severity === 'HEALTH_ERR'),
      );
      const messages = details.slice(0, MAX_DETAILS).map(([check, d]) => raw(`${check}: ${d.message ?? ''}`.trim()));
      issues.push({
        id: `${base}/health`,
        check: 'rook-ceph',
        severity: ceph.health === 'HEALTH_ERR' ? 'critical' : 'warning',
        title: t(ceph.health === 'HEALTH_ERR' ? 'rookCeph.health.errTitle' : 'rookCeph.health.warnTitle', { name }),
        cause: messages.length
          ? t('rookCeph.health.cause', { details: messages, more: Math.max(0, details.length - MAX_DETAILS) })
          : t('rookCeph.health.noDetails'),
        actions: [],
      });
    }
    const total = ceph?.capacity?.bytesTotal ?? 0;
    const used = ceph?.capacity?.bytesUsed ?? 0;
    if (total > 0 && used / total >= CEPH_USED_WARNING) {
      const severity: IssueSeverity = used / total >= CEPH_USED_CRITICAL ? 'critical' : 'warning';
      issues.push({
        id: `${base}/capacity`,
        check: 'rook-ceph',
        severity,
        title: t('rookCeph.capacity.title', { name, pct: Math.round((used / total) * 100) }),
        cause: t('rookCeph.capacity.cause', { free: bytes(ceph?.capacity?.bytesAvailable ?? total - used) }),
        actions: [],
      });
    }
    const failure = c.status?.conditions?.find((x) => x.type === 'Failure' && x.status === 'True');
    if (c.status?.phase === 'Failure' || failure) {
      issues.push({
        id: `${base}/operator`,
        check: 'rook-ceph',
        severity: 'warning',
        title: t('rookCeph.operator.title', { name }),
        cause: rawOr(failure?.message ?? c.status?.message, t('rookCeph.operator.cause')),
        actions: [],
      });
    } else {
      const checked = Date.parse(ceph?.lastChecked ?? '');
      if (Number.isFinite(checked) && now.getTime() - checked > CEPH_STALE_MS) {
        issues.push({
          id: `${base}/operator`,
          check: 'rook-ceph',
          severity: 'warning',
          title: t('rookCeph.stale.title', { name }),
          cause: t('rookCeph.stale.cause'),
          actions: [],
        });
      }
    }
  }
  return issues;
}

export class RookCephIntegration extends Integration {
  readonly id = 'rook-ceph';
  readonly reads = [
    {
      group: 'ceph.rook.io',
      resource: 'cephclusters',
      why: 'Ceph health, its warnings and raw capacity per CephCluster',
    },
  ];

  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const clusters = (await ctx.kube.list<CephCluster>('/apis/ceph.rook.io/v1/cephclusters')) ?? [];
    const issues = evaluateRookCeph(clusters, ctx.now);
    const stats: Stat[] = [{ label: t('rookCeph.stat.clusters'), value: String(clusters.length) }];
    for (const c of clusters) {
      const health = c.status?.ceph?.health ?? '?';
      stats.push({
        label: raw(`${c.metadata.namespace ?? '-'}/${c.metadata.name}`),
        value: health,
        tone: health === 'HEALTH_OK' ? 'ok' : health === 'HEALTH_ERR' ? 'critical' : 'warning',
      });
      const cap = c.status?.ceph?.capacity;
      if (cap?.bytesTotal) {
        const share = (cap.bytesUsed ?? 0) / cap.bytesTotal;
        stats.push({
          label: t('rookCeph.stat.used'),
          value: t('common.ofTotal', { part: bytes(cap.bytesUsed ?? 0), total: bytes(cap.bytesTotal) }),
          tone: share >= CEPH_USED_CRITICAL ? 'critical' : share >= CEPH_USED_WARNING ? 'warning' : 'ok',
        });
      }
    }
    return { issues, stats, summary: issues[0]?.title ?? t('rookCeph.summary.ok', { n: clusters.length }) };
  }
}
