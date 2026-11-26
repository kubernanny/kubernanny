# Checks reference

Every issue Kubernanny can raise, with its id pattern, severity, cause and the actions it offers. Thresholds marked *(config)* are set through environment variables or chart values ([CONFIGURATION.md](CONFIGURATION.md)).

Severity rule: **critical** = down or data at risk now; **warning** = becomes critical if nobody acts; **hint** (`info`) = worth knowing, not a problem. Hints are listed under "Hints", never colour the light, never cost score and are never sent as notifications.

<p><img src="screenshots/06-overview-issues.png" alt="Issues with cause and action" width="260"> <img src="screenshots/16-sheet-argocd.png" alt="The Argo CD sheet" width="260"></p>

*Issues as the app shows them, and a component's detail sheet.*

A module that cannot run (API error, missing RBAC) shows as *not checkable* and keeps the light from being green. So does a module whose input could not be read in this run (say Deployments timed out): it keeps the issues of the last known objects and says which list it could not read, so nothing is reported as resolved because of a failed read. A component that is not installed is skipped silently.

**When checks run**: every `CHECK_INTERVAL_SECONDS` (60), on a pull in the app, and 3 s after a watched change that can open or close an issue (a pod into CrashLoopBackOff or an image pull error, a node condition changing, a workload losing or regaining replicas, a PVC phase, a failed Job), at most every 15 s. The thresholds below measure time since an issue was first seen, not runs, and notifications still wait `NOTIFY_AFTER_SECONDS`, so the earlier runs only make the app current sooner.

## Core checks (on unless switched off)

### Nodes (`nodes`)

| Issue id | Severity | When | Data source |
|---|---|---|---|
| `nodes/<node>/not-ready` | critical | `Ready` condition not `True` | Node status |
| `nodes/<node>/not-ready` | **warning** | same, but the node is cordoned (planned reboot, e.g. kured) | Node spec |
| `nodes/<node>/MemoryPressure`, `DiskPressure`, `PIDPressure` | warning | kubelet reports the condition | Node status |
| `nodes/<node>/memory` | warning ≥ 90 %, critical ≥ 97 % | memory used / allocatable | metrics-server |
| `nodes/<node>/disk` | warning ≥ 85 %, critical ≥ 95 % | root filesystem used | node-exporter via Prometheus |
| `nodes/<node>/cordoned` | warning | a **Ready** node cordoned for more than 30 minutes that kured does not hold the lock for and that no drain is working on (no pod on it is terminating). Offers **uncordon**. | Node spec; since when: the managedFields entry that owns `spec.unschedulable`, else when the agent first saw it |

Stats: nodes ready, cluster CPU and RAM %, cores, memory.

### Node clocks (`node-clocks`)

| Issue id | Severity | When |
|---|---|---|
| `node-clocks/<node>` | warning > 0.5 s, critical > 5 s | offset from `node_timex_offset_seconds` (else `node_ntp_offset_seconds`), via Prometheus |
| `node-clocks/<node>` | warning | `node_timex_sync_status` 0 for 5 min and max error ≥ 16 s |

chrony (the default on most distributions) disciplines the clock without the kernel's PLL and leaves `node_timex_offset_seconds` at exactly 0. A timex offset of exactly 0 therefore counts as "not reported", not as "0 ms off": without any offset the sheet shows how many clocks the kernel calls synchronised and the time daemon's own error estimate (`node_timex_estimated_error_seconds`) instead of a "largest offset". 0.5 s is half of etcd's 1 s peer clock-drift warning. Above 5 s the clock is not being corrected: new certificates are "not yet valid" and JWTs fail beyond the API server's one-minute leeway. Without Prometheus: no issue. Off: `checks.disabled: [node-clocks]`.

### etcd (`etcd`)

Reads the static pods labelled `component=etcd` in `kube-system` (RKE2, kubeadm). Skipped for external etcd or kine (k3s with SQLite).

| Issue id | Severity | When | Actions |
|---|---|---|---|
| `etcd/members` | warning | a member is not ready, quorum still holds | logs of the members |
| `etcd/members` | critical | ready members < ⌊n/2⌋+1: the API refuses writes | logs |

On RKE2 and k3s the module also reads the snapshots the distribution records as `ETCDSnapshotFile` (`k3s.cattle.io`; skipped where the CRD does not exist):

| Issue id | Severity | When |
|---|---|---|
| `etcd/snapshots` | warning | no snapshot recorded at all |
| `etcd/snapshot-failed` | warning | the newest snapshot has an error (node, local or S3, and the message) |
| `etcd/snapshot-age` | warning older than `BACKUP_MAX_AGE_HOURS` (26) *(config)*, critical older than twice that | age of the newest snapshot that is ready to use |

Stats: members ready, WAL fsync p99 (warning tone over 10 ms), leader changes in the last hour (warning tone over 3), from Prometheus; snapshot count and age of the newest.

### API server (`apiserver`)

| Issue id | Severity | When |
|---|---|---|
| `apiserver/certificate` | warning within 30 days, critical within 7 days or expired | expiry of the certificate the API server presents (read with a TLS handshake) |

RKE2 and k3s renew their certificates on restart when they expire within 90 days; a warning here means the servers have not been restarted for a long time. Stats: Kubernetes version, certificate end date.

### Workloads (`pods`)

| Issue id | Severity | When | Actions |
|---|---|---|---|
| `pods/<ns>/<Kind>/<name>` | critical | a container waits with `CrashLoopBackOff`, `ImagePullBackOff`, `ErrImagePull`, `CreateContainerConfigError`, `CreateContainerError`, `InvalidImageName` or `RunContainerError`. One issue per workload, however many pods. | logs (of the previous, crashed run for CrashLoopBackOff), restart of the owner (see below) |
| `pods/<ns>/<Kind>/<name>` | critical, title `…: OOMKilled` | a crash loop whose last run ended with `OOMKilled`. The cause names the container's memory limit and says to raise it (without a limit: the node ran out of memory). | logs only: a restart cannot help |
| `pods/<ns>/<Kind>/<name>` | warning | a pod is `Pending` for more than 10 minutes (scheduler message as cause) | logs, restart |
| `pods/terminating/<ns>/<pod>` | warning | a pod in Terminating for more than 10 minutes whose node is NotReady or no longer exists: no kubelet confirms the end, a StatefulSet does not start its replacement, a Longhorn volume stays attached | force delete (opt-in) |
| `pods/finished/<ns>` | hint | pods older than an hour that finished: `Failed` (evicted ones included) and `Succeeded` ones whose Job is gone. Pods of a Job that still exists are left alone (their logs belong to the Job). | clean up (at most 50 per run) |
| `workloads/<ns>/<Kind>/<name>` | critical | no replica ready, not explained by a pod issue, workload older than 5 minutes | restart |
| `workloads/<ns>/<Kind>/<name>` | warning | some replicas not ready, or `ProgressDeadlineExceeded` | restart |
| `jobs/<ns>/<cronjob>` | warning | the newest finished run of a CronJob failed | logs of its pod, run again (opt-in) |
| `jobs/<ns>/<job>` | warning | a Job without CronJob failed within the last 24 h; hidden once a rerun of it exists (label `kubernanny.io/rerun-of`) | logs, run again (opt-in, only for a Job without any owner) |

The owner of a pod is resolved through its ReplicaSet (`<deployment>-<pod-template-hash>`), StatefulSet or DaemonSet. Pods of finished Jobs (`Succeeded`) are ignored, and so are pods already being deleted.

**Which restart is offered on a crash loop.** A restart replaces the pods; it helps when the cause is gone, not before. So:

- no known cause: the logs of the crashed run come first, the restart second, with a hint ("helps once you have fixed the cause, e.g. changed a Secret or a dependency is back");
- the last run ended with `OOMKilled`: no restart, the cause names the limit;
- a ConfigMap the container reads through `env` (`configMapKeyRef`) or `envFrom` changed after the container's last start: the restart comes first, and the cause says so ("ConfigMap app-config changed after the last start: a restart loads it right away"). The kubelet reads env from ConfigMaps at every container start, so the next attempt after the back-off would pick it up too; the restart does it now. Volume-mounted ConfigMaps update by themselves and are not counted. The agent reads only the metadata of those ConfigMaps (`PartialObjectMetadata`, never their data, at most 20 per run) and takes the newest managedFields time as the change time. That needs `get` on ConfigMaps cluster-wide, and RBAC cannot limit that to metadata, so this part is **opt-in**: `actions.enabled: [config-change-hint]`. Without it the crash loop always gets "logs first, restart second". **Secrets are never checked**: their metadata needs `get` on Secrets cluster-wide, which the chart never grants; the restart's hint names a changed Secret as the typical case instead.

### Volumes (`volumes`)

| Issue id | Severity | When |
|---|---|---|
| `volumes/<ns>/<pvc>` | critical | phase `Lost` |
| `volumes/<ns>/<pvc>` | warning | phase `Pending` for more than 5 minutes (StorageClass named; `WaitForFirstConsumer` explained) |
| `volumes/<ns>/<pvc>/full` | warning ≥ 85 %, critical ≥ 95 % | `kubelet_volume_stats_used_bytes / capacity` from Prometheus. Offers **grow** (opt-in `pvc-expand`) by a quarter, rounded up to whole Gi, when the claim is Bound and its StorageClass has `allowVolumeExpansion`. A CloudNativePG volume gets no offer: the cause says to raise the Cluster's `storage.size`. For a claim made from a StatefulSet's volumeClaimTemplates the confirmation says that the template keeps the old size. |

### Disruption budgets (`pdb`)

| Issue id | Severity | When |
|---|---|---|
| `pdb/<ns>/<name>` | warning | a PodDisruptionBudget allows zero disruptions while all its pods are healthy (`minAvailable` equal to the replica count, or `maxUnavailable: 0`). A node drain (kured, upgrades) cannot evict the pod and waits until it gives up (kured: `--drain-timeout`, after which the node is uncordoned and not rebooted; `kubectl drain` without a timeout: forever). |

A PDB that blocks only because pods are unhealthy right now is not reported: that is the PDB doing its job. Nor are PDBs of operators that handle drains themselves:

- CloudNativePG's `<cluster>-primary` PDB, when the cluster has replicas (recognised by its sibling `<cluster>` PDB with pods): when the primary's node is cordoned, CNPG switches the primary over and the old primary can then be evicted. A single-instance cluster with `enablePDB` has nothing to switch to and is reported, with a cause that says so.
- Longhorn's per-node `instance-manager-*` PDBs (selector `longhorn.io/component: instance-manager`, `longhorn.io/managed-by: longhorn-manager`): longhorn-manager creates and removes them according to its `node-drain-policy`, moving replicas off the node first.
 Stats: PDBs, how many block drains.

### Autoscalers (`hpa`)

| Issue id | Severity | When |
|---|---|---|
| `hpa/<ns>/<target>` | warning | `ScalingActive=False` for at least 3 minutes (its `lastTransitionTime`): the autoscaler gets no metrics (metrics-server missing, no resource requests). Shorter is every rollout: the new pods have no metrics until metrics-server has scraped them, about a minute. |
| `hpa/<ns>/<target>` | warning | `AbleToScale=False` |
| `hpa/<ns>/<target>` | warning | `ScalingLimited` with `TooManyReplicas` and running at `maxReplicas` |

Stats: autoscalers, how many run at their maximum.

### Kubernetes version (`kubernetes-support`)

Compares the API server's minor version with a built-in table of upstream end-of-life dates (`agent/src/modules/kubernetes-support/releases.ts`, from https://kubernetes.io/releases/, compiled 2026-11-24). No network access beyond the in-cluster Prometheus.

| Situation | Severity |
|---|---|
| 120 to 61 days before end of life | hint |
| 60 days before end of life or less | warning |
| past end of life, a newer maintained minor known | warning |
| past end of life, the table knows nothing newer (table out of date) | hint |
| minor newer than the table | nothing |

The cause names the oldest maintained newer minor ("one minor version at a time") and the upgrade guide of the distribution as plain text (RKE2, k3s, kubeadm; managed clusters: kubernetes.io/releases). Issue id `kubernetes-support/<minor>`. The table is updated with every Kubernetes minor release.

**Deprecated APIs in use.** With Prometheus, the module also reads the API server's own `apiserver_requested_deprecated_apis` (1 for every deprecated API something asked for since the API server last started, with the release that removes it). One issue per removing release: a **warning** for the next minor, since that upgrade breaks whatever still asks for them, a **hint** for later ones. Issue id `kubernetes-support/deprecated-apis/<release>`. The metric does not say who asked; the cause points to the API server's audit log. The number is a stat on the module's sheet; without Prometheus this part is left out.

### Security posture (`security`)

From the pod specs the run already reads; no extra RBAC, nothing leaves the cluster. One issue per finding type and namespace. System namespaces (`kube-system`, `longhorn-system`, … plus `checks.systemNamespaces`) are skipped; recognised host-level components (Longhorn, Node Exporter, CNIs, kured, …) are exempt from the first three. Details: [SECURITY-CHECKS.md](SECURITY-CHECKS.md).

| Issue id | Severity | When |
|---|---|---|
| `security/<ns>/privileged` | warning | a container sets `securityContext.privileged: true` |
| `security/<ns>/host-access` | hint | `hostNetwork`, `hostPID`, `hostIPC` or a `hostPath` volume |
| `security/<ns>/root` | hint | neither `runAsNonRoot: true` nor a non-zero `runAsUser` (or `runAsUser: 0`) |
| `security/<ns>/no-memory-limit` | hint | a container without `resources.limits.memory` |
| `security/<ns>/mutable-image` | hint | image tag `latest` or none, without a digest |
| `security/<ns>/accept-annotation` | hint | a workload's `kubernanny.io/accept` annotation names an unknown key or `privileged` |

**Accepting hints:** a hint can be accepted in Git: `kubernanny.io/accept: "root: the official image boots runit as root and drops privileges itself"` on the Deployment, StatefulSet, DaemonSet or CronJob (or its pod template). Keys `host-access`, `root`, `no-memory-limit`, `mutable-image`, and `cpu-throttled` for the standard alerts' throttling hint, each with a required reason; `privileged` never. Every hint that can be accepted ends with the snippet for its key (`Deliberate? Set the annotation kubernanny.io/accept: "root: <reason>" on the workload.`). Accepted hints count nowhere and are listed folded on the module's sheet ("1 accepted"). Keys and rules: [SECURITY-CHECKS.md](SECURITY-CHECKS.md#accepting-a-hint-in-git-kubernannyioaccept).

Stats: findings, namespaces with privileged containers, namespaces with findings, exempt namespaces.

### Known vulnerabilities (`vulnerabilities`, off by default)

**Limited by design:** matches only the Kubernetes version and the image-tag versions of the 13 mapped components against OSV.dev (or `VULN_DB_URL`), cached 12 h. It does not see your own images, other components, or the libraries and base layer inside any image; for those, run Trivy Operator (`trivy` below), which scans every image. The module's sheet says so, and says whether Trivy Operator was found. Sends package names and versions, nothing else; switch on with `vulnerabilities.enabled` or in the app. One issue per component, never with actions; the app links each advisory id to osv.dev. Details and the list of mapped components: [SECURITY-CHECKS.md](SECURITY-CHECKS.md).

| Issue id | Severity | When |
|---|---|---|
| `vulnerabilities/<component>` (`vulnerabilities/kubernetes`) | critical | a critical advisory (CVSS ≥ 9.0) with a released fix on a component reachable through an ingress |
| | warning | a critical advisory with a fix on a component without one, or a high one (≥ 7.0) with a fix |
| | hint | medium, low, or no released fix yet |

Database unreachable: answers up to 7 days old are shown and marked, and OSV.dev is left alone for 15 minutes before the next try; without any, the module is *not checkable* (yellow, never red). Stats: what it compares, whether every image is covered (Trivy Operator found or not), versions checked, components left to Trivy, advisories per level, components without a lookup, database host.

A component whose every workload has a fresh Trivy Operator report is left to Trivy: no lookup, no `vulnerabilities/<component>` issue, so the same advisories never show twice.

### Available updates (`image-updates`, off by default)

`image-updates/<component>` (hint): a newer patch, minor or major tag of a recognised component with a plain `x.y.z` tag on Docker Hub, ghcr.io, quay.io or registry.k8s.io. Cached 12 h. Sends repository names only. Details: [SECURITY-CHECKS.md](SECURITY-CHECKS.md). Locked off: `checks.disabled: [image-updates]` (no registry contact, no egress rule).

### Standard alerts (`standard-alerts`)

The generally valid alerts of the community rule sets, built in, so every cluster gets them without writing Prometheus rules: etcd-mixin, kubernetes-mixin, node-exporter mixin, coredns-mixin and the Prometheus mixin, as kube-prometheus-stack ships them. Code: `agent/src/modules/core/standard-alerts/` (`rules.ts` holds every query with the upstream rule it comes from).

How the upstream rules are carried over:

- **Same expression and thresholds**, job selectors dropped (their values differ per install) and aggregated to the labels that identify a finding (`max by (instance, To)` and so on).
- **`for` as a window.** The value is taken over the upstream `for` duration, `min_over_time(<value>[10m:1m])` for "above" thresholds and `max_over_time` for "below" ones: the condition held for the whole window, so a spike never alarms. Without an upstream `for` the current value counts.
- **Threshold applied in the agent, not in PromQL.** An empty answer therefore means "metric missing", never "fine". One query per run (`group by (__name__) (…)`) tells which metrics exist; a rule whose metrics are missing raises nothing and is listed on the sheet as *not checked* (metric missing, query failed, needs Prometheus, no Alertmanager).
- **Severity by Kubernanny's rule**, which sometimes differs from upstream (marked ↓ below).
- **Hard switches.** `checks.disabled: [standard-alerts]` runs none of it. `checks.disabled: [prometheus]` means no Prometheus query at all (`findPrometheus`): only the three inventory rules run, and the sheet says the rest needs Prometheus.

Issue ids are `standard-alerts/<rule>/<where>`; no rule offers actions. The CPU throttling hint (`cpu-throttled`) is the only one about a workload, and the only one a workload can accept in its `kubernanny.io/accept` annotation ([SECURITY-CHECKS.md](SECURITY-CHECKS.md#accepting-a-hint-in-git-kubernannyioaccept)); accepted ones are listed folded on the sheet. CPU limits that add up to more than a node's cores are not a finding at all: CPU is shared out and throttled, nobody is killed, so the resource bars show it as a grey note ("Limits zusammen 148 % der Kerne: wird gedrosselt, nicht beendet"); memory limits above the node's memory stay amber. Stats: etcd peer round trip p99 (worst pair now), CPU and RAM requests against the cluster without its largest node, rules checked. The sheet lists the p99 of every etcd member pair (from, to) and every rule with its state.

**No double reporting.** When Alertmanager fires the same upstream alert (same alert name, same identifying labels: `instance` + `To` for the etcd round trip, `instance` + `mountpoint` for a filesystem, …), Kubernanny shows one issue: its own, whose cause ends with "Alertmanager fires this too (<alert>)". The alert leaves the Alertmanager module (an alert of the same name with other labels stays there). The same holds for upstream alerts the older core checks raise under their own ids: KubeNodeNotReady and KubeNodeUnreachable (`nodes/<node>/not-ready`), KubeNodePressure, KubePersistentVolumeFillingUp (`volumes/…/full`), NodeFilesystem* on `/` (`nodes/<node>/disk`), NodeClockNotSynchronising and NodeClockSkewDetected (`node-clocks`), etcdMembersDown and etcdInsufficientMembers (`etcd/members`), TargetDown (`prometheus/down/<job>`), KubePodCrashLooping and KubeContainerWaiting (`pods/…`), KubeDeploymentReplicasMismatch and KubeStatefulSetReplicasMismatch (`workloads/…`). Only alert names from Kubernanny's own table are ever shown, never one read from Alertmanager.

Every upstream alert considered:

| Upstream alert | Decision | Kubernanny id | Threshold (window) | Severity |
|---|---|---|---|---|
| **etcd-mixin** | | | | |
| etcdMemberCommunicationSlow (peer round trip) | taken | `etcd-peer-rtt/<from>/<to>` | p99 of `etcd_network_peer_round_trip_time_seconds` > 150 ms (10 min); names both members, shows the p99 | warning |
| etcdHighFsyncDurations | taken | `etcd-fsync/<node>` | WAL fsync p99 > 0.5 s / > 1 s (10 min) | warning / critical |
| etcdHighCommitDurations | taken | `etcd-commit/<node>` | backend commit p99 > 0.25 s (10 min) | warning |
| etcdNoLeader | taken | `etcd-no-leader/<node>` | `etcd_server_has_leader` 0 (1 min) | warning ↓ (one member; with none the API server is down and the agent reports the cluster unreachable) |
| etcdHighNumberOfLeaderChanges | taken | `etcd-leader-changes/cluster` | ≥ 4 changes in 15 min (5 min) | warning |
| etcdDatabaseQuotaLowSpace | taken | `etcd-db-quota/<node>` | size / quota > 95 % (10 min) | critical |
| etcdExcessiveDatabaseGrowth | taken | `etcd-db-growth/<node>` | `predict_linear(size[4h], 4h)` > quota (10 min) | warning |
| etcdDatabaseHighFragmentationRatio | taken | `etcd-fragmentation/<node>` | in use / size < 0.5 and in use > 100 MiB (10 min) | hint ↓ |
| etcdMembersDown, etcdInsufficientMembers | covered | `etcd/members` | | |
| etcdHighNumberOfFailedGRPCRequests, etcdGRPCRequestsSlow | left out | | gRPC metrics need `--metrics=extensive`; the effect shows as API server errors, fsync and leader changes | |
| etcdHighNumberOfFailedProposals | left out | | duplicate of no leader / leader changes | |
| **kubernetes-mixin** | | | | |
| KubeCPUOvercommit, KubeMemoryOvercommit | taken (inventory) | `overcommit/cpu`, `overcommit/memory` | requests of Pending and Running pods > allocatable minus the largest node (needs ≥ 2 nodes) | warning |
| KubeletTooManyPods | taken (inventory) | `too-many-pods/<node>` | pods on the node > 95 % of its pod capacity | hint (as upstream) |
| KubeVersionMismatch | taken (inventory) | `version-mismatch` | more than one minor among API server and kubelets | hint ↓ (normal during upgrades) |
| KubeNodeReadinessFlapping | taken | `node-flapping/<node>` | > 2 Ready changes in 15 min (15 min), cordoned nodes skipped | warning |
| KubePersistentVolumeInodesFillingUp | taken | `pv-inodes/<ns>/<pvc>` | < 3 % inodes free / < 15 % and out within 4 days (1 h) | critical / warning |
| KubePersistentVolumeErrors | taken | `pv-errors/<pv>` | PV phase Failed or Pending (5 min) | warning ↓ (a claim waiting for it is the volumes module's) |
| KubeQuotaExceeded | taken | `quota-exceeded/<ns>/<quota>/<resource>` | used / hard > 100 % (15 min) | warning |
| KubeClientCertificateExpiration | taken | `client-certificate/<node>/<job>` | 1st percentile of presented client certificates < 7 days / < 1 day (5 min) | warning / critical |
| KubeletClientCertificateExpiration, KubeletServerCertificateExpiration | taken | `kubelet-client-certificate/<node>`, `kubelet-server-certificate/<node>` | TTL < 7 days / < 1 day (metric only where the kubelet rotates its certificates; RKE2 does not) | warning / critical |
| KubeAPIErrorBudgetBurn | taken, errors only | `api-errors/cluster` | 5xx share (no WATCH/CONNECT) 1 h and 5 m > 14.4 %; 6 h and 30 m > 6 %, or 1 d and 2 h > 3 % | critical / warning. The latency half needs upstream's recording rules and is not included. |
| KubeNodeNotReady, KubeNodeUnreachable, KubeNodePressure | covered | `nodes/…` | | |
| KubePersistentVolumeFillingUp | covered | `volumes/…/full` (85 % / 95 %) | the predicted variant needs < 15 % free, where the volumes module already warns | |
| KubePodCrashLooping, KubePodNotReady, KubeContainerWaiting, KubeDeployment*/KubeStatefulSet*/KubeDaemonSet* mismatch and rollout, KubeJobFailed | covered | `pods/…`, `workloads/…`, `jobs/…` | | |
| KubeHpaMaxedOut, KubeHpaReplicasMismatch | covered | `hpa/…` | | |
| KubePdbNotEnoughHealthyPods | covered | `workloads/…` (the unhealthy pods themselves) | | |
| KubeAPIDown, KubeletDown, KubeletInstanceUnreachable, KubeAPIInstanceUnreachable, KubeProxyDown, TargetDown | covered | agent unreachable, `prometheus/down/<job>` | | |
| KubeAggregatedAPIDown, KubeAggregatedAPIErrors | covered | `metrics-server/api`, and as 5xx in `api-errors` | | |
| KubeJobNotCompleted | left out | | 12 h is arbitrary; backups and migrations run long on purpose | |
| KubeQuotaAlmostFull, KubeQuotaFullyUsed, KubeCPUQuotaOvercommit, KubeMemoryQuotaOvercommit | left out | | informational in upstream; the exceeded quota is what refuses pods | |
| CPUThrottlingHigh | taken, stricter | `cpu-throttled/<ns>/<Kind>/<workload>` | throttled share of the CFS periods (`container_cpu_cfs_throttled_periods_total` / `container_cpu_cfs_periods_total`, 5 min rate) > 25 % for all of 30 min, and > 25 % over the last hour; one hint per workload (its worst container), "default/pantrist-api-pg wird gedrosselt: 40 % der Zeit am CPU-Limit von 1 Kern" with the fix (raise or remove the CPU limit). Upstream fires per container after 15 min, which is why it is famously noisy. Accepted in Git with `kubernanny.io/accept: "cpu-throttled: <reason>"` | hint |
| KubeletPlegDurationHigh, KubeletPodStartUpLatencyHigh, KubeNodeEviction | left out | | need recording rules / dominated by image pulls / evictions show as pod issues | |
| KubeClientErrors, KubeAPITerminatedRequests, KubeStateMetrics*, Kubelet*CertificateRenewalErrors | left out | | self-monitoring of components, or the expiry rule catches it first | |
| **node-exporter mixin** | | | | |
| NodeFilesystemSpaceFillingUp, NodeFilesystemAlmostOutOfSpace | taken, every mount but `/` | `filesystem/<node><mount>` | < 15 % free and full within 24 h (1 h), < 5 % (30 min): warning; < 10 % and full within 4 h (1 h), < 3 % (30 min): critical; read-only skipped | warning / critical |
| … on `/` | covered | `nodes/<node>/disk` | | |
| NodeFilesystemAlmostOutOfFiles | taken, `/` included | `inodes/<node><mount>` | < 5 % / < 3 % inodes free (1 h) | warning / critical |
| NodeHighNumberConntrackEntriesUsed | taken | `conntrack/<node>` | > 75 % of `nf_conntrack_max` | warning |
| NodeNetworkReceiveErrs, NodeNetworkTransmitErrs | taken | `network-errors/<node>/<device>/<direction>` | > 1 % of packets (1 h) | warning |
| NodeFileDescriptorLimit | taken | `file-descriptors/<node>` | > 70 % / > 90 % (15 min) | warning / critical |
| NodeRAIDDegraded, NodeRAIDDiskFailure | taken | `raid-degraded/…`, `raid-disk-failed/…` | fewer active disks than required (15 min); a disk marked failed | critical / warning |
| NodeClockNotSynchronising, NodeClockSkewDetected | covered | `node-clocks/<node>` | | |
| NodeMemoryHighUtilization | covered | `nodes/<node>/memory` | | |
| NodeMemoryMajorPagesFaults | left out | | 500/s is an arbitrary line, noisy on nodes with swap; memory pressure is the nodes module's | |
| NodeCPUHighUsage, NodeSystemSaturation, NodeDiskIOSaturation | left out | | load, not a fault; noisy in a homelab | |
| NodeFilesystemFilesFillingUp | left out | | the 40 % prediction duplicates AlmostOutOfFiles for practical purposes | |
| NodeNetworkInterfaceFlapping | left out | | CNI interfaces come and go with pods | |
| NodeSystemdServiceFailed, NodeSystemdServiceCrashlooping, NodeTextFileCollectorScrapeError, NodeBondingDegraded | left out | | collectors off by default, or setup-specific | |
| **coredns-mixin** | | | | |
| CoreDNSErrorsHigh | taken | `dns-errors/<job>` | SERVFAIL share > 1 % / > 3 % (10 min) | warning / critical |
| CoreDNSLatencyHigh | taken | `dns-latency/<server>/<zone>` | p99 > 4 s (10 min) | critical |
| CoreDNSForwardHealthcheckBrokenCount | taken | `dns-forward-broken/cluster` | every upstream resolver marked down (10 min) | warning |
| CoreDNSDown | covered | workloads of CoreDNS, `prometheus/down` | | |
| CoreDNSForwardLatencyHigh, CoreDNSForwardErrorsHigh, CoreDNSForwardHealthcheckFailureCount | left out | | forwarded queries are part of the overall errors and latency; a single flaky upstream is not a fault | |
| **Prometheus mixin** | | | | |
| PrometheusBadConfig | taken | `prometheus-config/<instance>` | last reload failed (10 min) | warning ↓ (keeps the old configuration) |
| PrometheusRuleFailures | taken | `prometheus-rule-failures/<group>` | evaluation failures (15 min) | warning ↓ |
| PrometheusNotConnectedToAlertmanagers | taken, only where an Alertmanager exists | `prometheus-alertmanager/<instance>` | no Alertmanager discovered (10 min) | warning |
| PrometheusTSDBCompactionsFailing | taken | `prometheus-compactions/<instance>` | failed compactions (4 h) | warning |
| Prometheus remote write, notification queue, SD, scrape limits, duplicate or out-of-order samples, TSDB reloads, Alertmanager* and PrometheusOperator* | left out | | self-monitoring of a setup Kubernanny does not depend on; kube-prometheus-stack ships them | |

## Actions

Every action belongs to an issue: the app names the issue and the action type, the agent takes the target from its own check. Each has a switch (Helm `actions.disabled`, the app), its permission is granted only while it is on, the admission policy holds it to what it sends ([PERMISSIONS.md](PERMISSIONS.md)), every run is logged with the device, and the app confirms each one, saying what exactly happens.

| Action | On by default | Offered on | What it does |
|---|---|---|---|
| `restart` | yes | `pods/…`, `workloads/…`, `argocd/<app>/health` | `kubectl rollout restart` of the workload; on a crash loop see above |
| `argocd-sync`, `argocd-refresh` | yes | `argocd/…`, "Ready to sync" | a sync with the app's own sync options (and Server-Side Apply when chosen, see "Sync options" below), a hard refresh |
| `cnpg-backup` | yes | `cnpg/<ns>/<cluster>/backup` | a CloudNativePG `Backup` |
| `longhorn-backup` | yes | `longhorn/backup/<volume>` (attached volumes) | a Longhorn `Snapshot` and a `Backup` of it |
| `velero-backup` | yes | `velero/<schedule>` | a Velero `Backup` from the schedule's template; not for a schedule with hooks, a resource policy or an order (the admission policy cannot compare those with the schedule) |
| `reconcile-now` | yes | Flux Kustomization/HelmRelease, ExternalSecret, InfisicalStaticSecret, cert-manager Certificate issues | the controller's reconcile annotation; for a Certificate `cmctl renew` |
| `uncordon` | yes | `nodes/<node>/cordoned` | `kubectl uncordon` |
| `cleanup-pods` | yes | `pods/finished/<ns>` | deletes the finished pods listed (never a running one) |
| `logs` | yes | crash loops, failed jobs, CNPG, etcd | reads the last 300 lines, changes nothing |
| `job-rerun` | **opt-in** | `jobs/…` | a Job from the CronJob's template (`kubectl create job --from=cronjob/…`), or a copy of a failed stand-alone Job without its controller-uid labels and selector. Never for a Job another controller owns, nor for one whose pod leaves the Pod Security Standards baseline profile. |
| `force-delete-terminating` | **opt-in** | `pods/terminating/…` | deletes the pod with grace period 0. The confirmation warns that a StatefulSet pod could run twice if the node is in fact alive. |
| `argocd-terminate-op` | **opt-in** | `argocd/<app>/operation-stuck` | ends the running operation |
| `argocd-sync-prune` | **opt-in** | no button: a choice in the sync's confirmation, while the app lists resources to prune | the sync also deletes what is no longer in Git (`prune`), after listing each resource and asking twice |
| `argocd-sync-replace` | **opt-in** | no button: a choice in the sync's confirmation, after a sync Kubernetes refused | the sync replaces objects instead of patching them (`Replace=true`) |
| `pvc-expand` | **opt-in** | `volumes/<ns>/<pvc>/full` | raises the storage request by a quarter; cannot be undone |
| `argocd-rollback` | **opt-in** | the Argo CD sheet, no issue needed | below |
| `config-change-hint` | **opt-in** | no button: the read behind the crash loop's restart offer | reads the metadata of the ConfigMaps a crash-looping container reads through env (above) |

The opt-in ones need `actions.enabled: [<type>, …]` in the Helm values (env `ENABLED_ACTIONS`): each needs a permission a compromised agent pod could use for more than the action (create Jobs, force-delete a terminating pod, end any running operation, grow any claim by half, read ConfigMaps, delete what an Argo CD app no longer has in Git, overwrite fields other managers set), see [SECURITY.md](SECURITY.md).

## Integrations (when the component is detected and switched on)

### Longhorn (`longhorn`)

| Issue id | Severity | When |
|---|---|---|
| `longhorn/<volume>` | warning | `robustness: degraded` (fewer healthy replicas than requested, rebuilding) |
| `longhorn/<volume>` | critical | `robustness: faulted` (no healthy replica) |
| `longhorn/node/<node>` | warning | Longhorn node not `Ready` |
| `longhorn/capacity` | warning < 15 % free, critical < 5 % | free disk across all Longhorn disks |
| `longhorn/backup-target/<name>` | critical | a configured backup target (S3, NFS) is not available: no volume backups run |
| `longhorn/backup/<volume>` | warning | the newest backup of a volume failed (Longhorn's message as cause). Offers **backup now** for an attached volume. |
| `longhorn/backup/<volume>` | warning older than `BACKUP_MAX_AGE_HOURS` *(config)*, critical older than twice that | age of the newest completed backup, for attached volumes that have backups (a RecurringJob that stopped). Offers **backup now**. |
| `longhorn/backup/<volume>` | hint | the same for a **detached** volume: Longhorn's RecurringJobs skip detached volumes unless `allow-recurring-job-while-volume-detached` is on, and nothing writes to them |

Only volumes that exist now are judged, titled by their PVC (`namespace/pvc`) where they have one. Longhorn keeps the backups of deleted volumes in the target until someone removes them; they protect nothing and only appear as a stat ("Backups of deleted volumes") and as `orphaned` in the Backups view, never as an issue or a row. Detached volumes report `unknown` robustness; that is normal and ignored. Stats: volumes healthy/attached, total, free disk, scheduled share, nodes.

### cert-manager (`cert-manager`)

| Issue id | Severity | When |
|---|---|---|
| `certificates/<ns>/<name>` | critical | `notAfter` in the past |
| `certificates/<ns>/<name>` | warning, critical within 3 days *(config)* | `Ready=False` (with cert-manager's message) |
| `certificates/<ns>/<name>` | warning < 14 days *(config)*, critical < 3 days | expiry close. cert-manager renews a 90-day certificate 30 days early, so this means renewal is failing. |
| `certificates/issuer/<name>` | critical | ClusterIssuer not ready: no new certificate can be issued |

Every `certificates/<ns>/<name>` issue offers **renew** (`reconcile-now`), unless the `Issuing` condition is already True: what `cmctl renew` does, the `Issuing` condition set to True with reason `ManuallyTriggered` on the status subresource.

Stats: certificates ready, ClusterIssuers, next expiry.

### Argo CD (`argocd`)

| Issue id | Severity | When | Actions |
|---|---|---|---|
| `argocd/<app>/health` | critical | health `Degraded` or `Missing`; the cause names the broken resources. An app that turned `Degraded` during a sync or within 10 minutes after one gets 3 minutes to settle first (measured from `status.health.lastTransitionTime`, on Argo CD 2 from the sync's start): new pods whose readiness probe fails for a few seconds. A rollout that really breaks it shows after those 3 minutes. | restart of up to three degraded workloads, sync, hard refresh |
| `argocd/<app>/operation` | critical | last sync `Failed` or `Error` | sync, hard refresh |
| `argocd/<app>/sync` | **hint** | `OutOfSync` on an app with **manual** sync whose last sync is more than 7 days ago (`PENDING_HINT_DAYS`): a change may have been forgotten. Sooner it is no issue at all, see "Ready to sync" below. | sync, hard refresh |
| `argocd/<app>/sync` | warning | `OutOfSync` on an app with **automated** sync: Argo CD should have fixed it, so a sync is stuck or something changes the cluster behind Git's back | sync, hard refresh |
| `argocd/<app>/comparison` | warning | `ComparisonError` condition | hard refresh |
| `argocd/<app>/operation-stuck` | warning | an operation has been `Running` for more than 30 minutes (`status.operationState.startedAt`): a hook that never finishes blocks every later sync | end the operation (opt-in `argocd-terminate-op`) |

**Ready to sync.** A manual app that is `OutOfSync`, neither `Degraded` nor `Missing`, and whose last sync did not fail, is routine maintenance, not a problem: no issue, no hint, no notification. The `argocd` module lists it in `pendingSyncs` instead, and the app shows one calm card ("3 Apps bereit zum Sync") that opens the list. Each entry is read from the Application resource alone (the agent has no Argo CD API token, so no commit messages): the revision deployed (`status.operationState.syncResult.revision`, else the newest `status.history` entry) and the one Git has (`status.sync.revision`), the resources that differ (`status.resources[]` with `OutOfSync`; `health: Missing` is new, `requiresPruning` is in the cluster but no longer in Git: removed only by a sync with prune, see "Sync options"), and image changes where Git names the image (Helm parameters `<prefix>.repository|name` + `<prefix>.tag`, Kustomize `images`) and `status.summary.images` says what runs. Since when the change waits is not recorded; the list says "since the last sync", which is the upper bound. The Sync button appears while `argocd-sync` is on; it runs under the id the app had as an issue (`argocd/<ns>/<app>/sync`), with the target taken from the agent's own list.

An app counts as automated when `spec.syncPolicy.automated` is set and not `enabled: false` (Argo CD 3). The "Synced" stat is only tinted as a warning when an automated app is out of sync. No sync is offered while an operation is running. Stats: apps, synced, healthy, automated.


**Sync options.** A sync from Kubernanny writes the Application's `operation` the way Argo CD's own Sync button does, including the app's `spec.syncPolicy.syncOptions` (an operation written with kubectl does not get those by itself, so earlier a Kubernanny sync of an app set to `ServerSideApply=true` ran client-side). When there is more to decide, the confirmation becomes a sheet with the choices that fit the app, each with a sentence on what it does:

- **Delete what is no longer in Git** (`prune: true`, opt-in `argocd-sync-prune`). Offered while `status.resources[]` marks resources with `requiresPruning` (a CronJob removed from the chart). Without it a sync leaves them running, and the list says so. The sheet lists every one (at most 50; with more, prune is not offered from the app) and asks a second time before syncing. The agent reads the Application again, refuses (409 `TARGET_CHANGED`) unless Argo CD would delete exactly the confirmed resources, and sends the patch with that `resourceVersion`.
- **Server-Side Apply** (`ServerSideApply=true`, part of `argocd-sync`). Offered after a sync Kubernetes refused (`is invalid`, `Duplicate value`), unless SSA is in effect already (the app's sync options or the last sync's name it). It writes the same manifests from Git, merged by the API server; it deletes nothing, so it needs no switch of its own.
- **Replace** (`Replace=true`, opt-in `argocd-sync-replace`). Offered after a sync Kubernetes refused, also when SSA is on: with SSA, a list entry another field manager still owns stays next to the new one (the old port 80 next to 8080, both named `http`: `ports[1].name: Duplicate value`). `kubectl replace` writes every object of the app exactly as Git has it, so fields other managers set are lost; suggested first for `Duplicate value`.
- **`field is immutable`**: neither helps (a replace is refused as well). The sheet shows Argo CD's message and says the object has to be deleted and created again (Argo CD: `Replace=true,Force=true` on that resource, or delete it and sync); Kubernanny does not do that.

The last failure's text (`status.operationState.message`, 600 characters at most) is shown above the choices. The admission policy lets the agent's sync carry only the app's own sync options and `ServerSideApply=true`, `Replace=true` only with `actions.enabled: [argocd-sync-replace]`, and `prune` only with `actions.enabled: [argocd-sync-prune]` and while the stored status lists a resource to prune. The audit log names the options and the resources to prune.

Issue ids are `argocd/<namespace>/<app>/{health,operation,sync,comparison,operation-stuck}`. Ending an operation sets `status.operationState.phase: Terminating`, which is what `argocd app terminate-op` has the API server write; the controller then stops the sync. Changes already applied stay. The agent re-reads the Application and refuses (409 `TARGET_CHANGED`) once the operation is no longer running. A restart is offered only for a workload in the Application's `spec.destination.namespace` that the agent's own inventory shows not ready, never for a target taken from the Application's status alone.

#### Rolling back (`argocd-rollback`, off by default)

A bad deploy is not always something Kubernanny can see. With `actions.enabled: [argocd-rollback]` in the Helm values (env `ENABLED_ACTIONS`), the Argo CD sheet lists every app with **manual** sync and a **single** source, with its last deployments from `status.history` (date, short revision, which one runs now), and a "Roll back" button, whether or not an issue is open. Picking an earlier deployment asks for confirmation (app, from and to revision) and then sets the Application's `operation` to a sync of that revision:

```yaml
operation:
  initiatedBy: { username: kubernanny }
  info: [{ name: Reason, value: Rollback from the Kubernanny app }]
  sync: { revision: <the history entry's revision>, syncStrategy: { hook: {} } }
```

No source, no prune, no sync options. Argo CD's controller syncs `spec.source` at `sync.revision` when the operation names no source, the same as `argocd app sync <app> --revision <rev>`. What runs afterwards is that revision of the app's own repository and path or chart. Two consequences:

- **The cluster then differs from Git.** Argo CD compares against `spec.source.targetRevision` again, so the app shows `OutOfSync` ("ready to sync" in Kubernanny, since the app syncs manually) until you `git revert` the bad change, or until someone presses Sync, which rolls forward again. A rollback is a stopgap, not a fix.
- **Only for manual sync.** With automated sync Argo CD would sync straight back to Git; `argocd app rollback` refuses such apps for the same reason, and so does Kubernanny.

How it differs from `argocd app rollback`: Argo CD's own rollback copies the history entry's `source` into the operation (so it can also go back to an older repository or path) and uses the apply strategy with optional prune. Kubernanny never names a source: it refuses any entry whose repository, path or chart differs from the current `spec.source`, because `status` is writable by anyone who can edit the Application and must not steer the agent to another repository. It keeps the hook strategy of a normal sync and never prunes.

Multi-source apps (`spec.sources`) are not offered: their history holds one revision per source, and rolling back one source without the others could combine states that never ran together. Roll those back in Argo CD itself.

The agent re-reads the Application on every request and refuses unless the Argo CD module is on, the app exists, has no `spec.syncPolicy.automated`, has `spec.source` and no `spec.sources`, has no operation pending or running, and the history id exists with a revision that is a 40-character commit SHA (Git) or a chart version (Helm), is not the one deployed now, and came from the same repository and path or chart. At most one rollback per app in 5 minutes. Every rollback is announced through the notification channels first and logged with the device and both revisions. Off (the default), the route answers 403 before reading anything, the sheet lists no history, and the admission policy has no branch that would let the agent set a revision. Routes and errors: [API.md](API.md#post-argocdrollback); permissions: [PERMISSIONS.md](PERMISSIONS.md).

This follows Argo CD's code (the server's rollback handler and the controller's sync of an operation without a source); it has not been tried against a live Argo CD here.

### CloudNativePG (`cnpg`)

| Issue id | Severity | When | Actions |
|---|---|---|---|
| `cnpg/<ns>/<cluster>/instances` | critical | no ready instance | logs of the primary |
| `cnpg/<ns>/<cluster>/instances` | warning | fewer ready instances than requested, or phase not healthy | logs |
| `cnpg/<ns>/<cluster>/archiving` | critical | `ContinuousArchiving=False`: the primary keeps every WAL segment it cannot upload until its volume is full | logs |
| `cnpg/<ns>/<cluster>/backup` | warning | backup configured but never succeeded, or last success older than 26 h *(config)* | start a backup |
| `cnpg/<ns>/<cluster>/backup` | warning | the newest backup failed (`LastBackupSucceeded=False`, `lastFailedBackup` after `lastSuccessfulBackup`) while the last success is still within the limit | start a backup |
| `cnpg/<ns>/<cluster>/backup` | critical | older than twice that | start a backup |

Backup checks only run for clusters with `spec.backup` or a Barman plugin. Stats: clusters, instances ready, oldest last backup, per cluster ready instances and primary.

### Prometheus (`prometheus`)

| Issue id | Severity | When |
|---|---|---|
| `prometheus/down/<job>` | warning | targets of a scrape job are down (`up == 0`), instances listed |

Stats: targets up, jobs, head series. Prometheus is reached at `PROMETHEUS_URL`, else the detected service with port 9090.

### Alertmanager (`alertmanager`)

Your own alerting rules, read from `/api/v2/alerts` (active, not silenced, not inhibited). One issue per alert name (`alertmanager/<alertname>`), critical if any instance has `severity=critical`, warning for `severity=warning`; other severities, `Watchdog` and `InfoInhibitor` are ignored. Silencing in Alertmanager silences Kubernanny too. Stats: firing, critical, active silences.

### Grafana, Loki

| Issue id | Severity | When |
|---|---|---|
| `grafana/database` | warning | `/api/health` reports the database not `ok` |
| `loki/ready` | warning | `/ready` does not answer `ready` |

Stats: Grafana version and database; Loki readiness and lines received per second.

### kured (`kured`)

| Issue id | Severity | When |
|---|---|---|
| `kured/lock` | warning | the reboot lock (`weave.works/kured-node-lock` on the DaemonSet) is held for more than 2 hours: no other node reboots and security updates wait |

Stats: node rebooting now, nodes waiting for a reboot (`kured_reboot_required`, only when Prometheus scrapes kured: without any such series the stat is left out rather than showing 0). The lock is read in both formats kured writes (single holder, and `{"maxOwners", "locks": […]}` with `--concurrency` above 1). Nodes held by the lock show "Startet neu" in the Nodes tab, and their NotReady is a warning.

### System Upgrade Controller (`system-upgrade-controller`)

`upgrade/<plan>` (warning) when a plan cannot resolve its version (`LatestResolved=False`). Stats: each plan's version (as written in the plan; the controller stores `v1.36.6+rke2r1` as `v1.36.6-rke2r1`) and the nodes it is applying to.

### Velero (`velero`)

Per schedule, the newest backup: `velero/<schedule>` critical on `Failed`, warning on `PartiallyFailed` or when older than 26 h *(config)*. Both offer **backup now** (`velero-backup`): the agent reads the Schedule and creates a Backup with its template, named `<schedule>-<timestamp>` and labelled `velero.io/schedule-name`, the same as `velero backup create --from-schedule`. A schedule whose template has `hooks`, a `resourcePolicy` or `orderedResources` is refused with a message (409 `VELERO_HOOKS`): the admission policy cannot compare those with the schedule, and hooks run commands in pods.

### Flux, External Secrets, Infisical

Every Kustomization, HelmRelease and GitRepository (Flux), ExternalSecret and ClusterSecretStore (External Secrets) with `Ready=False` is a warning with the controller's message. The Infisical operator (v0.11) has no `Ready` condition; each kind is judged by its own:

| Kind | Condition | Failed when |
|---|---|---|
| InfisicalSecret (`v1alpha1`) | `secrets.infisical.com/ReadyToSyncSecrets` | `False` |
| InfisicalStaticSecret (`v1beta1`) | `secrets.infisical.com/LastReconcileStatus` | `False` |
| InfisicalDynamicSecret (`v1alpha1`) | `secrets.infisical.com/Reconcile` | `False` |
| InfisicalPushSecret (`v1alpha1`) | `secrets.infisical.com/Reconcile` | `True` (inverted: reason `Error`) |

Issue ids `<module>/<Kind>/<ns>/<name>`. **Reconcile now** (`reconcile-now`) is offered where the controller reconciles on an annotation: Kustomization and HelmRelease (`reconcile.fluxcd.io/requestedAt`, as `flux reconcile`), ExternalSecret (`force-sync`, as the External Secrets FAQ shows) and InfisicalStaticSecret (`kubernanny.io/requested-at`: the operator's v1beta1 controller reconciles on any change of its annotations). Not for GitRepository and ClusterSecretStore (they recover on their interval), nor for the older InfisicalSecret, InfisicalDynamicSecret and InfisicalPushSecret: their controllers ignore metadata changes (`GenerationChangedPredicate`), so an annotation would do nothing. Stats: ready per kind; the summary counts the same, and names resources the controller has not given a status yet instead of calling them ready.

### Gatus (`gatus`)

Reads `GET /api/v1/endpoints/statuses` on Gatus' service (port 8080) over cluster DNS. An endpoint whose newest result failed counts as down; one **warning** per Gatus group (`gatus/group/<group>`, `-` for ungrouped), naming the endpoints and Gatus' error or the condition not met. Stats: up, down, without result. API behind a login (401/403): no issue, a stat saying so. Untrusted: never offers actions.

### Uptime Kuma (`uptime-kuma`)

Uptime Kuma has no read API without credentials (`/metrics` needs an API key in 2.x and can be switched off). With `UPTIME_KUMA_STATUS_PAGE` set to a published status page's slug, the agent reads that page like a browser does (`GET /api/status-page/<slug>` and `/api/status-page/heartbeat/<slug>`, port 3001): a monitor whose newest heartbeat is down counts; one **warning** per status page group (`uptime-kuma/group/<group id>`). Only monitors on that page are seen. Without the setting: workload health only, plus a stat explaining how to enable it. Untrusted: never offers actions.

### Rook Ceph (`rook-ceph`)

`…/<ns>/<name>/health`: warning on HEALTH_WARN, critical on HEALTH_ERR (with Ceph's own messages). `…/capacity`: warning ≥ 75 %, critical ≥ 85 % raw use. Ceph's own per-OSD defaults are nearfull 85 %, backfillfull 90 % and full 95 %; the cluster average runs behind the fullest OSD, hence earlier. `…/operator`: warning on a Failure phase or condition, or a status older than 15 min. Off: `checks.disabled: [rook-ceph]`.

### Traefik, ingress-nginx (`traefik`, `ingress-nginx`)

`<id>/errors/<route>`: the 5xx share over 15 min, only with ≥ 200 requests and ≥ 10 errors, so a quiet homelab never alarms. Warning > 5 % (far beyond a 0.1 to 1 % error budget and rollout blips), critical > 25 %. Without Prometheus: workload health only.

### Kyverno, Gatekeeper (`kyverno`, `gatekeeper`)

`kyverno/policy/<policy>` and `gatekeeper/<Kind>/<name>`: a hint with the violation count (security posture, not an outage). A warning only for Enforce/deny policies whose engine reports errors (`…/errors`), or a Kyverno policy that is not Ready (`…/not-ready`). Gatekeeper makes one CRD per constraint kind, so `constraints.gatekeeper.sh` is read with `*` (read only).

### Trivy Operator (`trivy`)

Reads Trivy Operator's `VulnerabilityReport`s (and `ClusterVulnerabilityReport`s where they exist), read only, nothing leaves the cluster. One issue per workload with the built-in lookup's severity rules:

| Issue id | Severity | When |
|---|---|---|
| `trivy/<ns>/<kind>/<name>` | critical | a critical advisory with a `fixedVersion` on a workload reachable through an ingress |
| | warning | a fixable critical on a workload without one, or a fixable high |
| | hint | no fix yet, medium, low |

Reports older than 14 days or of an image the workload no longer runs are skipped; only counts and the worst advisories are kept. Shown on the component's sheet too. Advisories can be marked as not applicable per workload. Off: `checks.disabled: [trivy]`. Details and suggested Trivy settings: [SECURITY-CHECKS.md](SECURITY-CHECKS.md#trivy-operator-trivy).

### metrics-server (`metrics-server`)

`metrics-server/api` (warning) when it is installed but delivers no node values (often `--kubelet-insecure-tls` missing, or the APIService unavailable). Without Prometheus its readings are also the source of the usage charts: the agent keeps them for 7 days in 5-minute buckets ([ARCHITECTURE.md](ARCHITECTURE.md#detail-views-and-history)).

## Every other component

Recognised components without an integration ([list](COMPONENTS.md)) are judged by their workloads. A component that runs in several namespaces (Redis/Valkey once per app) lists each namespace as an instance (`instances` on its module, with the version and ready pods of each copy): the status is critical when a workload has no ready replica, warning when some are missing, and the Workloads issues of their pods are attached to them. A component whose workloads are only CronJobs (e.g. descheduler) reads "Läuft nach Zeitplan"; a failed run is a `jobs/…` issue. Their sheet shows version, namespace, pods and ingress URLs, found through Ingresses, Gateway API HTTPRoutes and Traefik IngressRoutes.

### Your own applications

`CUSTOM_COMPONENTS` (Helm `customComponents`) adds your own images to the catalog, so they appear as components with their own name, icon and category instead of anonymous workloads:

```yaml
customComponents:
  - name: Shop API
    images: [ghcr.io/acme/shop-api]   # prefix; matches any tag or digest
    category: apps                                  # apps (default), platform, storage, …
    icon: restaurant-outline                        # any ionicon
    description: Backend of the shopping list app.
```

An image prefix matches only at a boundary: `ghcr.io/acme/api` matches `ghcr.io/acme/api:1.2` and `ghcr.io/acme/api@sha256:…`, never `ghcr.io/acme/api-evil`. A prefix ending in `/` matches everything below it (`ghcr.io/acme/`). Your entries are checked before the built-in catalog.

## Not checked (yet)

Controller-manager and scheduler health beyond what the workloads show, ingress reachability from outside (use the Blackbox Exporter, Kubernanny reports its alerts), node-level hardware (SMART), vulnerabilities of components without an OSV mapping and of your own images without Trivy Operator (the `vulnerabilities` module only knows the versions of Kubernetes and 13 recognised components; with Trivy Operator in the cluster every image is covered). See [ROADMAP.md](ROADMAP.md).
