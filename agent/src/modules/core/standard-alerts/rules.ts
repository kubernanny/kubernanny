/**
 * The generally valid alerts of the upstream community rule sets, as
 * Prometheus queries Kubernanny runs itself, so they work without anyone
 * writing alerting rules. Sources, as shipped in kube-prometheus-stack:
 * etcd-mixin, kubernetes-mixin, node-exporter mixin, coredns-mixin and the
 * Prometheus mixin. Each rule names the upstream alert(s) it stands for; the
 * full list of what was taken, what other modules already cover and what was
 * left out (and why) is in docs/CHECKS.md, "Standard alerts".
 *
 * How a rule is written:
 * - `query` returns one value per finding, already over the upstream `for`
 *   duration: `min_over_time(<value>[<for>:1m])` for "above" thresholds,
 *   `max_over_time` for "below" ones, so the condition held over the whole
 *   window and a spike does not alarm.
 * - The threshold is applied here (`judge`), not in PromQL, so an empty
 *   answer means the metric is missing, never "fine". Which metrics a rule
 *   needs is checked once per run (`needs`); a rule without them is listed
 *   as not checked, it never raises an issue.
 * - Severity follows Kubernanny's rule, which is sometimes not upstream's:
 *   critical = down or data at risk now; warning = becomes critical if nobody
 *   acts; info (hint) = worth knowing.
 */
import { IssueSeverity } from '../../../checks/types';
import { t, Text } from '../../../i18n/text';
import type { AcceptKey } from '../../security/accept-annotation';

export type Area = 'etcd' | 'nodes' | 'kubernetes' | 'dns' | 'prometheus';

export interface Finding {
  /** The `by` labels of the series. */
  labels: Record<string, string>;
  value: number;
  /** The rule's `extra` values of the same series (same `by` labels), when Prometheus had one. */
  extra: Record<string, number | undefined>;
}

/** The workload a container series belongs to (a pod's owner: Deployment, StatefulSet, CNPG Cluster, …). */
export interface WorkloadRef {
  /** "ns/Kind/name", the key of the workload's `kubernanny.io/accept` annotation. */
  key: string;
  namespace: string;
  kind: string;
  name: string;
  /** The pod template's `kubernanny.io/accept`, as it arrives on the pod. */
  podAccept?: string;
  /** The CPU limit of the series' `container`, in millicores; absent when it sets none. */
  cpuLimit?: number;
}

/** Turns label values into names people know: a node instead of `10.0.0.5:9100`, an etcd member instead of its hex id. */
export interface Names {
  node(labels: Record<string, string>): string;
  etcdMember(id: string): string;
  /** The workload of `namespace`/`pod`; undefined when the pod is gone (replaced since). */
  workload(labels: Record<string, string>): WorkloadRef | undefined;
}

export interface Described {
  /** The issue id's last part, stable across runs. */
  where: string;
  title: Text;
  cause: Text;
  /** For a rule that can be accepted (`accept`): the workload whose annotation decides. */
  workload?: WorkloadRef;
  /** What was found, in a few words, for the list of accepted hints ("throttled at its CPU limit"). */
  short?: Text;
}

export interface PromRule {
  /** Kubernanny's id: issues are `standard-alerts/<key>/<where>`. */
  key: string;
  area: Area;
  /** The upstream alert names this rule stands for (Alertmanager duplicates are matched by these). */
  alerts: readonly string[];
  /** Metric names that must exist in Prometheus for the rule to be checkable. */
  needs: readonly string[];
  /**
   * What a missing metric usually means for this rule, when that is the cluster's setup and not a
   * gap in monitoring (no software RAID, no ResourceQuotas): the sheet lists the rule as not
   * applying, with this text, instead of "metric missing".
   */
  absent?: Text;
  query: string;
  /** More values per series, joined on `by`. */
  extra?: Record<string, string>;
  /** The labels that tell findings apart (the query aggregates to exactly these). */
  by: readonly string[];
  /** The labels an Alertmanager alert must share to be the same alert (default: `by`). */
  match?: readonly string[];
  /** Only checked when this holds (e.g. an Alertmanager exists). */
  when?: (env: { alertmanager: boolean }) => boolean;
  /**
   * A hint the workload can accept in its `kubernanny.io/accept` annotation under this key
   * (docs/SECURITY-CHECKS.md): `describe` names the workload, and an accepted one is listed apart.
   */
  accept?: AcceptKey;
  /** Several series end in the same issue (the containers of a workload's pods): the highest value speaks for it. */
  worstFirst?: boolean;
  judge(f: Finding): IssueSeverity | null;
  /** null: nothing to report after all (the pod of the series is gone). */
  describe(f: Finding, names: Names, severity: IssueSeverity): Described | null;
}

/** Fires when the value is above the thresholds (strictly, as upstream's `>`). */
function above(levels: { warning?: number; critical?: number; info?: number }): (f: Finding) => IssueSeverity | null {
  return ({ value }) =>
    levels.critical !== undefined && value > levels.critical
      ? 'critical'
      : levels.warning !== undefined && value > levels.warning
        ? 'warning'
        : levels.info !== undefined && value > levels.info
          ? 'info'
          : null;
}

/** Fires when the value is below the thresholds (strictly, as upstream's `<`). */
function below(levels: { warning?: number; critical?: number }): (f: Finding) => IssueSeverity | null {
  return ({ value }) =>
    levels.critical !== undefined && value < levels.critical
      ? 'critical'
      : levels.warning !== undefined && value < levels.warning
        ? 'warning'
        : null;
}

/** Label values come from Prometheus: bounded before they go into ids and titles. */
export const label = (labels: Record<string, string>, name: string) => (labels[name] ?? '?').slice(0, 120);
const ms = (seconds: number) => Math.round(seconds * 1000 * 10) / 10;
const pct = (ratio: number) => Math.round(ratio * 1000) / 10;
const days = (seconds: number) => Math.max(0, Math.floor(seconds / 86_400));

/** Share of CFS periods a container spends throttled, held for 30 min and over the last hour: the `cpu-throttled` hint. */
export const CPU_THROTTLED_SHARE = 0.25;
/** Throttled share per container: periods in which the kernel stopped it at its CPU quota, over all periods it ran. */
const throttledShare = (fn: 'rate' | 'increase', window: string) => {
  const c = 'container!="",container!="POD"';
  return (
    `sum by (namespace, pod, container) (${fn}(container_cpu_cfs_throttled_periods_total{${c}}[${window}])) / ` +
    `sum by (namespace, pod, container) (${fn}(container_cpu_cfs_periods_total{${c}}[${window}]))`
  );
};

/** `etcd_network_peer_round_trip_time_seconds` p99 above this for 10 min: etcd-mixin's etcdMemberCommunicationSlow. */
export const ETCD_PEER_RTT_WARNING_S = 0.15;
const DAY = 86_400;
const FS = 'fstype!="",mountpoint!=""';
/** The root filesystem is the nodes module's (`nodes/<node>/disk`); the space rules look at every other mount. */
const FS_NOT_ROOT = `${FS},mountpoint!="/"`;
const API = 'verb!~"WATCH|CONNECT"';
const apiErrorShare = (window: string) =>
  `sum(rate(apiserver_request_total{code=~"5..",${API}}[${window}])) / sum(rate(apiserver_request_total{${API}}[${window}]))`;

export const PROM_RULES: readonly PromRule[] = [
  // ---------------- etcd (etcd-mixin) ----------------
  {
    // etcdMemberCommunicationSlow: histogram_quantile(0.99, rate(etcd_network_peer_round_trip_time_seconds_bucket[5m])) > 0.15 for 10m, warning.
    key: 'etcd-peer-rtt',
    area: 'etcd',
    alerts: ['etcdMemberCommunicationSlow'],
    needs: ['etcd_network_peer_round_trip_time_seconds_bucket'],
    query:
      'max by (instance, To) (min_over_time(histogram_quantile(0.99, rate(etcd_network_peer_round_trip_time_seconds_bucket[5m]))[10m:1m]))',
    extra: {
      now: 'max by (instance, To) (histogram_quantile(0.99, rate(etcd_network_peer_round_trip_time_seconds_bucket[5m])))',
    },
    by: ['instance', 'To'],
    judge: above({ warning: ETCD_PEER_RTT_WARNING_S }),
    describe: (f, n) => {
      const from = n.node(f.labels);
      const to = n.etcdMember(label(f.labels, 'To'));
      return {
        where: `${from}/${to}`,
        title: t('std.etcdPeerRtt.title', { from, to, ms: ms(f.extra.now ?? f.value) }),
        cause: t('std.etcdPeerRtt.cause', { from, to, ms: ms(f.value), threshold: ms(ETCD_PEER_RTT_WARNING_S) }),
      };
    },
  },
  {
    // etcdHighFsyncDurations: p99 of etcd_disk_wal_fsync_duration_seconds > 0.5 (warning) / > 1 (critical) for 10m.
    key: 'etcd-fsync',
    area: 'etcd',
    alerts: ['etcdHighFsyncDurations'],
    needs: ['etcd_disk_wal_fsync_duration_seconds_bucket'],
    query:
      'max by (instance) (min_over_time(histogram_quantile(0.99, rate(etcd_disk_wal_fsync_duration_seconds_bucket[5m]))[10m:1m]))',
    by: ['instance'],
    judge: above({ warning: 0.5, critical: 1 }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      return {
        where: node,
        title: t('std.etcdFsync.title', { node, ms: ms(f.value) }),
        cause: t('std.etcdFsync.cause', { ms: ms(f.value) }),
      };
    },
  },
  {
    // etcdHighCommitDurations: p99 of etcd_disk_backend_commit_duration_seconds > 0.25 for 10m, warning.
    key: 'etcd-commit',
    area: 'etcd',
    alerts: ['etcdHighCommitDurations'],
    needs: ['etcd_disk_backend_commit_duration_seconds_bucket'],
    query:
      'max by (instance) (min_over_time(histogram_quantile(0.99, rate(etcd_disk_backend_commit_duration_seconds_bucket[5m]))[10m:1m]))',
    by: ['instance'],
    judge: above({ warning: 0.25 }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      return {
        where: node,
        title: t('std.etcdCommit.title', { node, ms: ms(f.value) }),
        cause: t('std.etcdCommit.cause', { ms: ms(f.value) }),
      };
    },
  },
  {
    // etcdNoLeader: etcd_server_has_leader == 0 for 1m. Upstream critical; here a warning, because one member
    // without a leader still leaves the others serving, and when none has one the API server is down and the
    // agent itself reports the cluster as unreachable.
    key: 'etcd-no-leader',
    area: 'etcd',
    alerts: ['etcdNoLeader'],
    needs: ['etcd_server_has_leader'],
    query: 'min by (instance) (max_over_time(etcd_server_has_leader[1m]))',
    by: ['instance'],
    judge: below({ warning: 1 }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      return { where: node, title: t('std.etcdNoLeader.title', { node }), cause: t('std.etcdNoLeader.cause') };
    },
  },
  {
    // etcdHighNumberOfLeaderChanges: increase(max without (instance, pod) (etcd_server_leader_changes_seen_total)[15m:1m]) >= 4 for 5m, warning.
    key: 'etcd-leader-changes',
    area: 'etcd',
    alerts: ['etcdHighNumberOfLeaderChanges'],
    needs: ['etcd_server_leader_changes_seen_total'],
    query:
      'max(min_over_time(increase((max without (instance, pod) (etcd_server_leader_changes_seen_total))[15m:1m])[5m:1m]))',
    by: [],
    judge: above({ warning: 3.5 }),
    describe: (f) => ({
      where: 'cluster',
      title: t('std.etcdLeaderChanges.title', { n: Math.round(f.value) }),
      cause: t('std.etcdLeaderChanges.cause'),
    }),
  },
  {
    // etcdDatabaseQuotaLowSpace: db size / quota > 95 % for 10m, critical: at the quota etcd raises NOSPACE and refuses every write.
    key: 'etcd-db-quota',
    area: 'etcd',
    alerts: ['etcdDatabaseQuotaLowSpace'],
    needs: ['etcd_mvcc_db_total_size_in_bytes', 'etcd_server_quota_backend_bytes'],
    query:
      'max by (instance) (min_over_time((last_over_time(etcd_mvcc_db_total_size_in_bytes[5m]) / last_over_time(etcd_server_quota_backend_bytes[5m]))[10m:1m]))',
    by: ['instance'],
    judge: above({ critical: 0.95 }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      return {
        where: node,
        title: t('std.etcdDbQuota.title', { node, pct: pct(f.value) }),
        cause: t('std.etcdDbQuota.cause'),
      };
    },
  },
  {
    // etcdExcessiveDatabaseGrowth: predict_linear(etcd_mvcc_db_total_size_in_bytes[4h], 4h) > quota for 10m, warning.
    key: 'etcd-db-growth',
    area: 'etcd',
    alerts: ['etcdExcessiveDatabaseGrowth'],
    needs: ['etcd_mvcc_db_total_size_in_bytes', 'etcd_server_quota_backend_bytes'],
    query:
      'max by (instance) (min_over_time((predict_linear(etcd_mvcc_db_total_size_in_bytes[4h], 14400) / etcd_server_quota_backend_bytes)[10m:1m]))',
    by: ['instance'],
    judge: above({ warning: 1 }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      return { where: node, title: t('std.etcdDbGrowth.title', { node }), cause: t('std.etcdDbGrowth.cause') };
    },
  },
  {
    // etcdDatabaseHighFragmentationRatio: in use / allocated < 0.5 and in use > 100 MiB for 10m. Upstream warning;
    // a hint here: nothing breaks, a defragmentation just gives the space back.
    key: 'etcd-fragmentation',
    area: 'etcd',
    alerts: ['etcdDatabaseHighFragmentationRatio'],
    needs: ['etcd_mvcc_db_total_size_in_use_in_bytes'],
    query:
      'max by (instance) (max_over_time((last_over_time(etcd_mvcc_db_total_size_in_use_in_bytes[5m]) / last_over_time(etcd_mvcc_db_total_size_in_bytes[5m]))[10m:1m]))',
    extra: { inUse: 'max by (instance) (etcd_mvcc_db_total_size_in_use_in_bytes)' },
    by: ['instance'],
    judge: (f) => (f.value < 0.5 && (f.extra.inUse ?? 0) > 104_857_600 ? 'info' : null),
    describe: (f, n) => {
      const node = n.node(f.labels);
      return {
        where: node,
        title: t('std.etcdFragmentation.title', { node, pct: pct(1 - f.value) }),
        cause: t('std.etcdFragmentation.cause'),
      };
    },
  },

  // ---------------- nodes (node-exporter mixin) ----------------
  {
    // NodeFilesystemSpaceFillingUp: < 15 % free and predict_linear(avail[6h], 24h) < 0 for 1h (warning);
    // < 10 % free and full within 4h for 1h (critical). NodeFilesystemAlmostOutOfSpace: < 5 % (warning) /
    // < 3 % (critical) for 30m. Read-only filesystems are skipped, as upstream does.
    key: 'filesystem',
    area: 'nodes',
    alerts: ['NodeFilesystemSpaceFillingUp', 'NodeFilesystemAlmostOutOfSpace'],
    needs: ['node_filesystem_avail_bytes', 'node_filesystem_size_bytes'],
    query: `max by (instance, mountpoint) (max_over_time((node_filesystem_avail_bytes{${FS_NOT_ROOT}} / node_filesystem_size_bytes{${FS_NOT_ROOT}})[1h:5m]))`,
    extra: {
      free30m: `max by (instance, mountpoint) (max_over_time((node_filesystem_avail_bytes{${FS_NOT_ROOT}} / node_filesystem_size_bytes{${FS_NOT_ROOT}})[30m:5m]))`,
      in24h: `max by (instance, mountpoint) (max_over_time(predict_linear(node_filesystem_avail_bytes{${FS_NOT_ROOT}}[6h], ${DAY})[1h:5m]))`,
      in4h: `max by (instance, mountpoint) (max_over_time(predict_linear(node_filesystem_avail_bytes{${FS_NOT_ROOT}}[6h], 14400)[1h:5m]))`,
      readonly: `max by (instance, mountpoint) (node_filesystem_readonly{${FS_NOT_ROOT}})`,
    },
    by: ['instance', 'mountpoint'],
    judge: (f) => {
      const { free30m, in24h, in4h, readonly } = f.extra;
      if (readonly === 1) {
        return null;
      }
      if ((free30m !== undefined && free30m < 0.03) || (f.value < 0.1 && in4h !== undefined && in4h < 0)) {
        return 'critical';
      }
      if ((free30m !== undefined && free30m < 0.05) || (f.value < 0.15 && in24h !== undefined && in24h < 0)) {
        return 'warning';
      }
      return null;
    },
    describe: (f, n, severity) => {
      const node = n.node(f.labels);
      const mount = label(f.labels, 'mountpoint');
      const free = pct(Math.min(f.value, f.extra.free30m ?? f.value));
      const filling = (severity === 'critical' ? f.extra.in4h : f.extra.in24h) ?? 0;
      return {
        where: `${node}${mount}`,
        title: t('std.filesystem.title', { node, mount, free }),
        cause:
          filling < 0
            ? t('std.filesystem.fillingCause', { hours: severity === 'critical' ? 4 : 24 })
            : t('std.filesystem.fullCause'),
      };
    },
  },
  {
    // NodeFilesystemAlmostOutOfFiles: < 5 % inodes free (warning) / < 3 % (critical) for 1h, root filesystem included.
    key: 'inodes',
    area: 'nodes',
    alerts: ['NodeFilesystemAlmostOutOfFiles'],
    needs: ['node_filesystem_files_free', 'node_filesystem_files'],
    query: `max by (instance, mountpoint) (max_over_time((node_filesystem_files_free{${FS}} / node_filesystem_files{${FS}})[1h:5m]))`,
    extra: { readonly: `max by (instance, mountpoint) (node_filesystem_readonly{${FS}})` },
    by: ['instance', 'mountpoint'],
    judge: (f) => (f.extra.readonly === 1 ? null : below({ warning: 0.05, critical: 0.03 })(f)),
    describe: (f, n) => {
      const node = n.node(f.labels);
      const mount = label(f.labels, 'mountpoint');
      return {
        where: `${node}${mount}`,
        title: t('std.inodes.title', { node, mount, free: pct(f.value) }),
        cause: t('std.inodes.cause'),
      };
    },
  },
  {
    // NodeHighNumberConntrackEntriesUsed: node_nf_conntrack_entries / limit > 0.75, no `for`, warning.
    key: 'conntrack',
    area: 'nodes',
    alerts: ['NodeHighNumberConntrackEntriesUsed'],
    needs: ['node_nf_conntrack_entries', 'node_nf_conntrack_entries_limit'],
    query: 'max by (instance) (node_nf_conntrack_entries / node_nf_conntrack_entries_limit)',
    by: ['instance'],
    judge: above({ warning: 0.75 }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      return {
        where: node,
        title: t('std.conntrack.title', { node, pct: pct(f.value) }),
        cause: t('std.conntrack.cause'),
      };
    },
  },
  {
    // NodeNetworkReceiveErrs / NodeNetworkTransmitErrs: errors / packets > 1 % (rate[2m]) for 1h, warning.
    // Filtered in PromQL (`> 0.01`): a node has one interface per pod, and only the failing ones matter.
    key: 'network-errors',
    area: 'nodes',
    alerts: ['NodeNetworkReceiveErrs', 'NodeNetworkTransmitErrs'],
    needs: ['node_network_receive_errs_total', 'node_network_transmit_errs_total'],
    query:
      'max by (instance, device, direction) (' +
      'label_replace(min_over_time((rate(node_network_receive_errs_total[2m]) / rate(node_network_receive_packets_total[2m]))[1h:5m]), "direction", "receive", "", "")' +
      ' or label_replace(min_over_time((rate(node_network_transmit_errs_total[2m]) / rate(node_network_transmit_packets_total[2m]))[1h:5m]), "direction", "transmit", "", "")' +
      ') > 0.01',
    by: ['instance', 'device', 'direction'],
    match: ['instance', 'device'],
    judge: above({ warning: 0.01 }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      const device = label(f.labels, 'device');
      const direction = f.labels.direction === 'transmit' ? 'transmit' : 'receive';
      return {
        where: `${node}/${device}/${direction}`,
        title: t(direction === 'transmit' ? 'std.networkErrors.transmitTitle' : 'std.networkErrors.receiveTitle', {
          node,
          device,
          pct: pct(f.value),
        }),
        cause: t('std.networkErrors.cause'),
      };
    },
  },
  {
    // NodeFileDescriptorLimit: allocated / maximum > 70 % (warning) / > 90 % (critical) for 15m.
    key: 'file-descriptors',
    area: 'nodes',
    alerts: ['NodeFileDescriptorLimit'],
    needs: ['node_filefd_allocated', 'node_filefd_maximum'],
    query: 'max by (instance) (min_over_time((node_filefd_allocated / node_filefd_maximum)[15m:1m]))',
    by: ['instance'],
    judge: above({ warning: 0.7, critical: 0.9 }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      return {
        where: node,
        title: t('std.fileDescriptors.title', { node, pct: pct(f.value) }),
        cause: t('std.fileDescriptors.cause'),
      };
    },
  },
  {
    // NodeRAIDDegraded: node_md_disks_required - node_md_disks{state="active"} > 0 for 15m, critical: one more failed disk loses the array.
    key: 'raid-degraded',
    area: 'nodes',
    alerts: ['NodeRAIDDegraded'],
    needs: ['node_md_disks_required', 'node_md_disks'],
    absent: t('std.absent.raid'),
    query:
      'max by (instance, device) (min_over_time((node_md_disks_required - ignoring (state) node_md_disks{state="active"})[15m:1m]))',
    by: ['instance', 'device'],
    judge: above({ critical: 0 }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      const device = label(f.labels, 'device');
      return {
        where: `${node}/${device}`,
        title: t('std.raidDegraded.title', { node, device, n: Math.round(f.value) }),
        cause: t('std.raidDegraded.cause'),
      };
    },
  },
  {
    // NodeRAIDDiskFailure: node_md_disks{state="failed"} > 0, warning.
    key: 'raid-disk-failed',
    area: 'nodes',
    alerts: ['NodeRAIDDiskFailure'],
    needs: ['node_md_disks'],
    absent: t('std.absent.raid'),
    query: 'max by (instance, device) (node_md_disks{state="failed"})',
    by: ['instance', 'device'],
    judge: above({ warning: 0 }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      const device = label(f.labels, 'device');
      return {
        where: `${node}/${device}`,
        title: t('std.raidDiskFailed.title', { node, device }),
        cause: t('std.raidDiskFailed.cause'),
      };
    },
  },

  // ---------------- Kubernetes (kubernetes-mixin) ----------------
  {
    // KubeNodeReadinessFlapping: changes(Ready)[15m] > 2 for 15m on a schedulable node, warning. Cordoned nodes are dropped by the check.
    key: 'node-flapping',
    area: 'kubernetes',
    alerts: ['KubeNodeReadinessFlapping'],
    needs: ['kube_node_status_condition'],
    query:
      'max by (node) (min_over_time(sum by (node) (changes(kube_node_status_condition{condition="Ready",status="true"}[15m]))[15m:1m]))',
    by: ['node'],
    judge: above({ warning: 2 }),
    describe: (f) => {
      const node = label(f.labels, 'node');
      return {
        where: node,
        title: t('std.nodeFlapping.title', { node, n: Math.round(f.value) }),
        cause: t('std.nodeFlapping.cause'),
      };
    },
  },
  {
    // KubePersistentVolumeInodesFillingUp: < 3 % inodes free (critical, for 1m); < 15 % and predict_linear(free[6h], 4d) < 0 for 1h (warning).
    key: 'pv-inodes',
    area: 'kubernetes',
    alerts: ['KubePersistentVolumeInodesFillingUp'],
    needs: ['kubelet_volume_stats_inodes_free', 'kubelet_volume_stats_inodes'],
    query:
      'max by (namespace, persistentvolumeclaim) (max_over_time((kubelet_volume_stats_inodes_free / kubelet_volume_stats_inodes)[1h:5m]))',
    extra: {
      now: 'max by (namespace, persistentvolumeclaim) (kubelet_volume_stats_inodes_free / kubelet_volume_stats_inodes)',
      in4d: `max by (namespace, persistentvolumeclaim) (max_over_time(predict_linear(kubelet_volume_stats_inodes_free[6h], ${4 * DAY})[1h:5m]))`,
    },
    by: ['namespace', 'persistentvolumeclaim'],
    judge: (f) => {
      if (f.extra.now !== undefined && f.extra.now < 0.03) {
        return 'critical';
      }
      return f.value < 0.15 && f.extra.in4d !== undefined && f.extra.in4d < 0 ? 'warning' : null;
    },
    describe: (f, _n, severity) => {
      const pvc = `${label(f.labels, 'namespace')}/${label(f.labels, 'persistentvolumeclaim')}`;
      return {
        where: pvc,
        title: t('std.pvInodes.title', { pvc, free: pct(f.extra.now ?? f.value) }),
        cause: t(severity === 'critical' ? 'std.pvInodes.fullCause' : 'std.pvInodes.fillingCause'),
      };
    },
  },
  {
    // KubePersistentVolumeErrors: kube_persistentvolume_status_phase{phase=~"Failed|Pending"} > 0 for 5m. Upstream critical; a
    // warning here: a released volume whose reclaim failed or a PV nobody can bind yet takes nothing down by itself
    // (a claim that waits for it is the volumes module's critical or warning).
    key: 'pv-errors',
    area: 'kubernetes',
    alerts: ['KubePersistentVolumeErrors'],
    needs: ['kube_persistentvolume_status_phase'],
    query:
      'max by (persistentvolume, phase) (min_over_time(kube_persistentvolume_status_phase{phase=~"Failed|Pending"}[5m]))',
    by: ['persistentvolume', 'phase'],
    match: ['persistentvolume'],
    judge: above({ warning: 0 }),
    describe: (f) => {
      const pv = label(f.labels, 'persistentvolume');
      const phase = label(f.labels, 'phase');
      return {
        where: pv,
        title: t('std.pvErrors.title', { pv, phase }),
        cause: t(phase === 'Failed' ? 'std.pvErrors.failedCause' : 'std.pvErrors.pendingCause'),
      };
    },
  },
  {
    // KubeQuotaExceeded: used / hard > 1 for 15m, warning.
    key: 'quota-exceeded',
    area: 'kubernetes',
    alerts: ['KubeQuotaExceeded'],
    needs: ['kube_resourcequota'],
    absent: t('std.absent.quota'),
    query:
      'max by (namespace, resourcequota, resource) (min_over_time((max by (namespace, resourcequota, resource) (kube_resourcequota{type="used"})' +
      ' / on (namespace, resourcequota, resource) (max by (namespace, resourcequota, resource) (kube_resourcequota{type="hard"}) > 0))[15m:1m]))',
    by: ['namespace', 'resourcequota', 'resource'],
    judge: above({ warning: 1 }),
    describe: (f) => {
      const quota = `${label(f.labels, 'namespace')}/${label(f.labels, 'resourcequota')}`;
      const resource = label(f.labels, 'resource');
      return {
        where: `${quota}/${resource}`,
        title: t('std.quotaExceeded.title', { quota, resource, pct: Math.round(f.value * 100) }),
        cause: t('std.quotaExceeded.cause'),
      };
    },
  },
  {
    // KubeClientCertificateExpiration: histogram_quantile(0.01, rate(apiserver_client_certificate_expiration_seconds_bucket[5m]))
    // < 7 days (warning) / < 1 day (critical) for 5m: a client authenticates with a certificate that is about to expire.
    key: 'client-certificate',
    area: 'kubernetes',
    alerts: ['KubeClientCertificateExpiration'],
    needs: ['apiserver_client_certificate_expiration_seconds_bucket'],
    query:
      'min by (job, instance) (max_over_time(histogram_quantile(0.01, sum without (namespace, service, endpoint) (rate(apiserver_client_certificate_expiration_seconds_bucket[5m])))[5m:1m]))',
    by: ['job', 'instance'],
    match: ['instance'],
    judge: below({ warning: 7 * DAY, critical: DAY }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      return {
        where: `${node}/${label(f.labels, 'job')}`,
        title: t('std.clientCertificate.title', { node, days: days(f.value) }),
        cause: t('std.clientCertificate.cause'),
      };
    },
  },
  {
    // KubeletClientCertificateExpiration: kubelet_certificate_manager_client_ttl_seconds < 7 days (warning) / < 1 day (critical).
    key: 'kubelet-client-certificate',
    area: 'kubernetes',
    alerts: ['KubeletClientCertificateExpiration'],
    needs: ['kubelet_certificate_manager_client_ttl_seconds'],
    absent: t('std.absent.kubeletCert'),
    query: 'min by (instance) (kubelet_certificate_manager_client_ttl_seconds)',
    by: ['instance'],
    judge: below({ warning: 7 * DAY, critical: DAY }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      return {
        where: node,
        title: t('std.kubeletCertificate.clientTitle', { node, days: days(f.value) }),
        cause: t('std.kubeletCertificate.cause'),
      };
    },
  },
  {
    // KubeletServerCertificateExpiration: kubelet_certificate_manager_server_ttl_seconds < 7 days (warning) / < 1 day (critical).
    key: 'kubelet-server-certificate',
    area: 'kubernetes',
    alerts: ['KubeletServerCertificateExpiration'],
    needs: ['kubelet_certificate_manager_server_ttl_seconds'],
    absent: t('std.absent.kubeletCert'),
    query: 'min by (instance) (kubelet_certificate_manager_server_ttl_seconds)',
    by: ['instance'],
    judge: below({ warning: 7 * DAY, critical: DAY }),
    describe: (f, n) => {
      const node = n.node(f.labels);
      return {
        where: node,
        title: t('std.kubeletCertificate.serverTitle', { node, days: days(f.value) }),
        cause: t('std.kubeletCertificate.cause'),
      };
    },
  },
  {
    // KubeAPIErrorBudgetBurn (multi-window burn rate on a 99 % objective), its error part from the raw counters:
    // critical when 1h and 5m both fail > 14.4 %, warning when 6h and 30m > 6 % or 1d and 2h > 3 %.
    // Upstream also counts slow requests, which needs its recording rules; Kubernanny counts 5xx answers only.
    key: 'api-errors',
    area: 'kubernetes',
    alerts: ['KubeAPIErrorBudgetBurn'],
    needs: ['apiserver_request_total'],
    query: apiErrorShare('1h'),
    extra: {
      m5: apiErrorShare('5m'),
      m30: apiErrorShare('30m'),
      h2: apiErrorShare('2h'),
      h6: apiErrorShare('6h'),
      d1: apiErrorShare('1d'),
    },
    by: [],
    judge: ({ value, extra: e }) => {
      const both = (a: number | undefined, b: number | undefined, limit: number) =>
        a !== undefined && b !== undefined && a > limit && b > limit;
      if (value > 0.144 && (e.m5 ?? 0) > 0.144) {
        return 'critical';
      }
      return both(e.h6, e.m30, 0.06) || both(e.d1, e.h2, 0.03) ? 'warning' : null;
    },
    describe: (f, _n, severity) => {
      const share = severity === 'critical' ? f.value : Math.max(f.extra.h6 ?? 0, f.extra.d1 ?? 0);
      return {
        where: 'cluster',
        title: t('std.apiErrors.title', { pct: pct(share) }),
        cause: t('std.apiErrors.cause'),
      };
    },
  },

  {
    // CPUThrottlingHigh: throttled / all CFS periods > 25 % (5m rate) for 15m, info, per container. Noisy upstream:
    // any container that bursts against its limit for a moment fires. Here the share must hold for 30 minutes
    // and over the whole last hour, one hint per workload (its worst container), and the workload can accept it.
    key: 'cpu-throttled',
    area: 'kubernetes',
    alerts: ['CPUThrottlingHigh'],
    needs: ['container_cpu_cfs_throttled_periods_total', 'container_cpu_cfs_periods_total'],
    query: `max by (namespace, pod, container) (min_over_time((${throttledShare('rate', '5m')})[30m:1m]))`,
    extra: { hour: throttledShare('increase', '1h') },
    by: ['namespace', 'pod', 'container'],
    accept: 'cpu-throttled',
    worstFirst: true,
    judge: ({ value, extra: e }) =>
      value > CPU_THROTTLED_SHARE && (e.hour ?? value) > CPU_THROTTLED_SHARE ? 'info' : null,
    describe: (f, n) => {
      const w = n.workload(f.labels);
      if (!w) {
        return null;
      }
      const what = `${w.namespace}/${w.name}`;
      const share = Math.round((f.extra.hour ?? f.value) * 100);
      const cores = w.cpuLimit === undefined ? undefined : w.cpuLimit / 1000;
      return {
        where: `${w.namespace}/${w.kind}/${w.name}`,
        title: t('std.cpuThrottled.title', { what, pct: share, ...(cores === undefined ? {} : { cores }) }),
        cause: t('std.cpuThrottled.cause', {
          container: label(f.labels, 'container'),
          pct: share,
          threshold: Math.round(CPU_THROTTLED_SHARE * 100),
        }),
        workload: w,
        short: t('std.cpuThrottled.short', { pct: share }),
      };
    },
  },

  // ---------------- DNS (coredns-mixin) ----------------
  {
    // CoreDNSErrorsHigh: SERVFAIL share of all answers > 1 % (warning) / > 3 % (critical) for 10m.
    key: 'dns-errors',
    area: 'dns',
    alerts: ['CoreDNSErrorsHigh'],
    needs: ['coredns_dns_responses_total'],
    query:
      'max by (job) (min_over_time((sum by (job) (rate(coredns_dns_responses_total{rcode="SERVFAIL"}[5m])) / sum by (job) (rate(coredns_dns_responses_total[5m])))[10m:1m]))',
    by: ['job'],
    match: [],
    judge: above({ warning: 0.01, critical: 0.03 }),
    describe: (f) => ({
      where: label(f.labels, 'job'),
      title: t('std.dnsErrors.title', { pct: pct(f.value) }),
      cause: t('std.dnsErrors.cause'),
    }),
  },
  {
    // CoreDNSLatencyHigh: p99 of coredns_dns_request_duration_seconds > 4 s for 10m, critical: most clients give up after 5 s.
    key: 'dns-latency',
    area: 'dns',
    alerts: ['CoreDNSLatencyHigh'],
    needs: ['coredns_dns_request_duration_seconds_bucket'],
    query:
      'max by (server, zone) (min_over_time(histogram_quantile(0.99, sum by (server, zone, le) (rate(coredns_dns_request_duration_seconds_bucket[5m])))[10m:1m]))',
    by: ['server', 'zone'],
    judge: above({ critical: 4 }),
    describe: (f) => {
      const zone = label(f.labels, 'zone');
      return {
        where: `${label(f.labels, 'server')}/${zone}`,
        title: t('std.dnsLatency.title', { zone, seconds: Math.round(f.value * 10) / 10 }),
        cause: t('std.dnsLatency.cause'),
      };
    },
  },
  {
    // CoreDNSForwardHealthcheckBrokenCount: sum(rate(coredns_forward_healthcheck_broken_total[5m])) > 0 for 10m, warning.
    key: 'dns-forward-broken',
    area: 'dns',
    alerts: ['CoreDNSForwardHealthcheckBrokenCount'],
    needs: ['coredns_forward_healthcheck_broken_total'],
    query: 'min_over_time(sum(rate(coredns_forward_healthcheck_broken_total[5m]))[10m:1m])',
    by: [],
    judge: above({ warning: 0 }),
    describe: () => ({
      where: 'cluster',
      title: t('std.dnsForwardBroken.title'),
      cause: t('std.dnsForwardBroken.cause'),
    }),
  },

  // ---------------- Prometheus (prometheus-mixin) ----------------
  {
    // PrometheusBadConfig: max_over_time(prometheus_config_last_reload_successful[5m]) == 0 for 10m. Upstream critical;
    // a warning here: Prometheus keeps running on the last good configuration.
    key: 'prometheus-config',
    area: 'prometheus',
    alerts: ['PrometheusBadConfig'],
    needs: ['prometheus_config_last_reload_successful'],
    query: 'min by (job, instance) (max_over_time(prometheus_config_last_reload_successful[15m]))',
    by: ['job', 'instance'],
    match: ['instance'],
    judge: below({ warning: 1 }),
    describe: (f) => ({
      where: label(f.labels, 'instance'),
      title: t('std.prometheusConfig.title'),
      cause: t('std.prometheusConfig.cause'),
    }),
  },
  {
    // PrometheusRuleFailures: increase(prometheus_rule_evaluation_failures_total[5m]) > 0 for 15m. Upstream critical;
    // a warning here: the rules of that group, alerts included, are not evaluated.
    key: 'prometheus-rule-failures',
    area: 'prometheus',
    alerts: ['PrometheusRuleFailures'],
    needs: ['prometheus_rule_evaluation_failures_total'],
    query: 'max by (rule_group) (min_over_time(increase(prometheus_rule_evaluation_failures_total[5m])[15m:1m])) > 0',
    by: ['rule_group'],
    match: [],
    judge: above({ warning: 0 }),
    describe: (f) => {
      // "<file>;<group>": the group's name is what people wrote.
      const group = label(f.labels, 'rule_group').split(';').pop() ?? '?';
      return {
        where: group,
        title: t('std.prometheusRuleFailures.title', { group }),
        cause: t('std.prometheusRuleFailures.cause'),
      };
    },
  },
  {
    // PrometheusNotConnectedToAlertmanagers: max_over_time(prometheus_notifications_alertmanagers_discovered[5m]) < 1 for 10m, warning.
    // Only where an Alertmanager runs: a Prometheus without one is set up that way on purpose.
    key: 'prometheus-alertmanager',
    area: 'prometheus',
    alerts: ['PrometheusNotConnectedToAlertmanagers'],
    needs: ['prometheus_notifications_alertmanagers_discovered'],
    query: 'min by (job, instance) (max_over_time(prometheus_notifications_alertmanagers_discovered[15m]))',
    by: ['job', 'instance'],
    match: ['instance'],
    when: (env) => env.alertmanager,
    judge: below({ warning: 1 }),
    describe: (f) => ({
      where: label(f.labels, 'instance'),
      title: t('std.prometheusAlertmanager.title'),
      cause: t('std.prometheusAlertmanager.cause'),
    }),
  },
  {
    // PrometheusTSDBCompactionsFailing: increase(prometheus_tsdb_compactions_failed_total[3h]) > 0 for 4h, warning.
    key: 'prometheus-compactions',
    area: 'prometheus',
    alerts: ['PrometheusTSDBCompactionsFailing'],
    needs: ['prometheus_tsdb_compactions_failed_total'],
    query: 'max by (job, instance) (min_over_time(increase(prometheus_tsdb_compactions_failed_total[3h])[4h:15m]))',
    by: ['job', 'instance'],
    match: ['instance'],
    judge: above({ warning: 0 }),
    describe: (f) => ({
      where: label(f.labels, 'instance'),
      title: t('std.prometheusCompactions.title'),
      cause: t('std.prometheusCompactions.cause'),
    }),
  },
];
