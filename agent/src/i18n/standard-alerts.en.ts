import type { standardAlertsDe } from './standard-alerts.de';

/** Texts of the standard alerts (`modules/core/standard-alerts`), spread into the English catalog. No em or en dashes. */
const dec = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 1 });

type Catalog = { [K in keyof typeof standardAlertsDe]: (typeof standardAlertsDe)[K] extends string ? string : (typeof standardAlertsDe)[K] };

export const standardAlertsEn: Catalog = {
  'module.standardAlerts.name': 'Standard alerts',
  'module.standardAlerts.description':
    'The generally valid alerts of the community rule sets (etcd, nodes, Kubernetes, CoreDNS, Prometheus), built in: no Prometheus rules of your own needed.',
  'std.alsoAlertmanager': (p) => `${p.cause} Alertmanager fires this too (${p.alerts}).`,

  'std.etcdPeerRtt.title': (p) => `etcd ${p.from} → ${p.to}: network round trip ${dec(p.ms)} ms`,
  'std.etcdPeerRtt.cause': (p) =>
    `The 99th percentile of the round trip from etcd on ${p.from} to ${p.to} has been above ${dec(p.threshold)} ms for 10 minutes (at least ${dec(p.ms)} ms). ` +
    'etcd members send each other a heartbeat every 100 ms and elect a new leader after 1 s without one. Slow links hold up every write and lead to leader changes and API server timeouts. ' +
    'Common causes: members in different sites or behind a VPN, Wi-Fi or a congested link, a saturated network card, an overloaded node (CPU steal, swap). ' +
    'Check the ping between the two nodes and put the etcd nodes on the same fast, wired network.',
  'std.etcdFsync.title': (p) => `etcd on ${p.node}: slow disk (fsync ${dec(p.ms)} ms)`,
  'std.etcdFsync.cause': (p) =>
    `The 99th percentile of the WAL fsync has been at least ${dec(p.ms)} ms for 10 minutes; healthy is below 10 ms. etcd confirms a write only after the fsync, and from 1 s on heartbeats get lost and leader elections start. ` +
    'Usually etcd sits on a slow or shared disk (SD card, HDD, network storage, Longhorn on the same drive). etcd belongs on an SSD of its own.',
  'std.etcdCommit.title': (p) => `etcd on ${p.node}: slow commits (${dec(p.ms)} ms)`,
  'std.etcdCommit.cause': (p) =>
    `The 99th percentile of backend commits has been at least ${dec(p.ms)} ms for 10 minutes (limit 250 ms). The disk under etcd is too slow or overloaded; etcd belongs on an SSD of its own.`,
  'std.etcdNoLeader.title': (p) => `etcd on ${p.node} has no leader`,
  'std.etcdNoLeader.cause':
    'This member has seen no leader for a minute and cannot serve requests. Usually it is cut off from the others, or its clock, disk or CPU is stuck. Check the logs of the etcd pod and its connection to the other members.',
  'std.etcdLeaderChanges.title': (p) => `etcd changes its leader often (${p.n} in 15 min)`,
  'std.etcdLeaderChanges.cause':
    'Every change briefly stops writes. Frequent changes come from slow disks (fsync), network trouble between the members or overloaded nodes.',
  'std.etcdDbQuota.title': (p) => `etcd database on ${p.node} is ${dec(p.pct)} % full`,
  'std.etcdDbQuota.cause':
    'At its quota etcd raises the NOSPACE alarm and refuses every write: the cluster stands still. Compact and defragment etcd, then disarm the alarm, or raise the quota (--quota-backend-bytes).',
  'std.etcdDbGrowth.title': (p) => `etcd database on ${p.node} grows too fast`,
  'std.etcdDbGrowth.cause':
    'At the pace of the last 4 hours the database reaches its quota within 4 hours; then etcd refuses every write. Usually a controller or operator writes objects in a loop; look at the events and the largest resource types.',
  'std.etcdFragmentation.title': (p) => `etcd database on ${p.node} is ${dec(p.pct)} % empty`,
  'std.etcdFragmentation.cause':
    'More than half of the file is freed space. That does no harm, but costs disk and makes snapshots longer. A defragmentation (etcdctl defrag, one member at a time) gives it back.',

  'std.filesystem.title': (p) => `${p.node}: ${p.mount} only ${dec(p.free)} % free`,
  'std.filesystem.fillingCause': (p) =>
    `At the pace of the last 6 hours the filesystem is full within ${p.hours} hours. Clean up what writes there (logs, images, volumes) or grow the disk.`,
  'std.filesystem.fullCause': 'Almost full: programs that write there will fail soon. Clean up or grow the disk.',
  'std.inodes.title': (p) => `${p.node}: ${p.mount} only ${dec(p.free)} % inodes free`,
  'std.inodes.cause':
    'Without free inodes no file can be created, however much space is left. Usually many small files: old container images, logs, caches. Clean up, for example with crictl rmi --prune.',
  'std.conntrack.title': (p) => `${p.node}: connection tracking table ${dec(p.pct)} % full`,
  'std.conntrack.cause':
    'When the conntrack table is full, the kernel drops new connections (nf_conntrack: table full in the kernel log). The cause is a great many short connections; raise net.netfilter.nf_conntrack_max or find what opens them.',
  'std.networkErrors.receiveTitle': (p) => `${p.node}: ${dec(p.pct)} % receive errors on ${p.device}`,
  'std.networkErrors.transmitTitle': (p) => `${p.node}: ${dec(p.pct)} % transmit errors on ${p.device}`,
  'std.networkErrors.cause':
    'For an hour more than one packet in a hundred has been faulty. Usually hardware: cable, plug, switch port or the network card, less often a driver. ip -s link on the node shows the counters.',
  'std.fileDescriptors.title': (p) => `${p.node}: ${dec(p.pct)} % of file handles in use`,
  'std.fileDescriptors.cause': 'At the limit processes can open no more files or sockets. Find what holds them or raise fs.file-max.',
  'std.raidDegraded.title': (p) => `${p.node}: RAID ${p.device} runs without ${p.n} disk(s)`,
  'std.raidDegraded.cause':
    'The array runs without redundancy: one more failed disk and the data is gone. Replace the failed disk and let the array rebuild (cat /proc/mdstat).',
  'std.raidDiskFailed.title': (p) => `${p.node}: disk in RAID ${p.device} failed`,
  'std.raidDiskFailed.cause': 'mdadm has marked a disk as failed. Replace it before the next one goes (cat /proc/mdstat, mdadm --detail).',

  'std.nodeFlapping.title': (p) => `Node ${p.node} keeps switching between ready and not ready`,
  'std.nodeFlapping.cause':
    'Its Ready state changed more than twice in every 15-minute span lately. Pods get evicted and moved around each time. Usually the node has network dropouts, or the kubelet stalls (memory, disk, container runtime).',
  'std.pvInodes.title': (p) => `Volume ${p.pvc}: only ${dec(p.free)} % inodes free`,
  'std.pvInodes.fullCause': 'Without free inodes the application can create no more files, however much space is left.',
  'std.pvInodes.fillingCause': 'At the pace of the last 6 hours the inodes run out within 4 days; then no file can be created. Clean up old files or grow the volume.',
  'std.pvErrors.title': (p) => `PersistentVolume ${p.pv}: ${p.phase}`,
  'std.pvErrors.failedCause':
    'Releasing the volume after its claim was deleted failed; its storage may still be in use. kubectl describe pv tells why; then remove the volume in the storage system by hand.',
  'std.pvErrors.pendingCause': 'The volume is not available for binding. kubectl describe pv shows what it waits for.',
  'std.quotaExceeded.title': (p) => `Quota ${p.quota}: ${p.resource} at ${p.pct} %`,
  'std.quotaExceeded.cause': 'The namespace uses more than its ResourceQuota allows: new pods and objects are refused. Raise the quota or use less.',
  'std.clientCertificate.title': (p) => `Client certificate presented to ${p.node} expires in ${p.days} days`,
  'std.clientCertificate.cause':
    'A client signs in with a certificate that expires soon; after that it is refused. The metric does not say which: usually a kubelet, a controller or a kubeconfig. RKE2 and k3s renew their certificates on restart when they expire within 90 days.',
  'std.kubeletCertificate.clientTitle': (p) => `Kubelet on ${p.node}: client certificate expires in ${p.days} days`,
  'std.kubeletCertificate.serverTitle': (p) => `Kubelet on ${p.node}: server certificate expires in ${p.days} days`,
  'std.kubeletCertificate.cause':
    'The kubelet renews its certificates itself; getting this close means renewal fails (pending CSRs: kubectl get csr). Without a valid certificate the node loses its connection to the API server.',
  'std.apiErrors.title': (p) => `API server: ${dec(p.pct)} % of requests fail`,
  'std.apiErrors.cause':
    'The API server answers so many requests with 5xx that the 1 % error budget burns fast. Often an unreachable aggregated API (metrics-server), an overloaded etcd or a broken webhook is to blame. The API server logs show which requests fail.',
  'std.dnsErrors.title': (p) => `DNS: ${dec(p.pct)} % of answers are SERVFAIL`,
  'std.dnsErrors.cause':
    'For 10 minutes CoreDNS has failed to resolve part of the names. Usually it cannot reach its upstream resolvers (forward in the Corefile) or a plugin fails. The logs of the CoreDNS pods name the affected names.',
  'std.dnsLatency.title': (p) => `DNS answers slowly (${p.zone}: ${dec(p.seconds)} s)`,
  'std.dnsLatency.cause':
    'The 99th percentile of the answer time has been above 4 s for 10 minutes; most clients give up after 5 s and applications stop seeing names. Usually a slow or unreachable upstream resolver, or CoreDNS at its CPU limit.',
  'std.dnsForwardBroken.title': 'DNS: every upstream resolver counts as down',
  'std.dnsForwardBroken.cause':
    "CoreDNS' health checks reach none of the resolvers in the Corefile. External names then resolve only by chance. Check the nodes' network and firewall to the outside (port 53) and the resolvers themselves.",
  'std.prometheusConfig.title': 'Prometheus cannot load its configuration',
  'std.prometheusConfig.cause':
    'The last reload failed; Prometheus keeps running on the previous configuration, and changes (new scrape targets, rules) do not apply. The Prometheus log names the error.',
  'std.prometheusRuleFailures.title': (p) => `Prometheus rules fail (${p.group})`,
  'std.prometheusRuleFailures.cause':
    'The rules of this group, their alerts included, have not been evaluated for 15 minutes. Usually a broken query or duplicate series; the log and the Rules page in Prometheus show the error.',
  'std.prometheusAlertmanager.title': 'Prometheus reaches no Alertmanager',
  'std.prometheusAlertmanager.cause':
    "Prometheus has found no Alertmanager: alerts fire but reach nobody. Check Prometheus' alerting configuration and the Alertmanager service.",
  'std.prometheusCompactions.title': 'Prometheus cannot compact its data',
  'std.prometheusCompactions.cause':
    'Compaction has been failing for hours. The data then grows unchecked until the disk is full. Usually the volume is full or a block is damaged; the Prometheus log names it.',

  'std.overcommit.cpuTitle': (p) => `CPU requests: the cluster cannot lose its largest node (${p.pct} %)`,
  'std.overcommit.memoryTitle': (p) => `Memory requests: the cluster cannot lose its largest node (${p.pct} %)`,
  'std.overcommit.cause': (p) =>
    `Pods request ${p.pct} % of what the other nodes offer without the largest one. When it fails or reboots, not all of its pods find room elsewhere and they stay Pending. Lower requests nobody needs, or add a node.`,
  'std.tooManyPods.title': (p) => `${p.node}: ${p.n} of ${p.max} pods`,
  'std.tooManyPods.cause': "The node is close to its pod limit (the kubelet's maxPods); more pods go to other nodes or stay Pending.",
  'std.versionMismatch.title': (p) => `Different Kubernetes versions in the cluster (${p.versions})`,
  'std.versionMismatch.cause': 'Normal during an upgrade. If it stays, an upgrade got stuck: bring every node to the same version.',

  'std.reason.missing': 'metric missing',
  'std.reason.failed': 'query failed',
  'std.reason.noPrometheus': 'needs Prometheus',
  'std.reason.notApplicable': 'no Alertmanager',
  'std.area.etcd': 'etcd',
  'std.area.nodes': 'Nodes',
  'std.area.kubernetes': 'Kubernetes',
  'std.area.dns': 'DNS',
  'std.area.prometheus': 'Prometheus',
  'std.rule.fires': (p) => `fires (${p.n})`,
  'std.rule.ok': 'fine',
  'std.stat.etcdPeerRtt': 'etcd round trip p99',
  'std.stat.cpuWithoutLargest': 'CPU requests without largest node',
  'std.stat.memoryWithoutLargest': 'RAM requests without largest node',
  'std.stat.rules': 'Rules checked',
  'std.needsPrometheus': 'needs Prometheus',
  'std.detail.peers': 'etcd round trips between members',
  'std.detail.from': 'From',
  'std.detail.to': 'To',
  'std.detail.rules': 'Rules',
  'std.summary.ok': (p) => `${p.n} rules checked, none fires`,
  'std.summary.noPrometheus': 'Without Prometheus only requests, pods per node and versions are checked',
};
