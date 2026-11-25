# What Kubernanny may do in your cluster

This page lists every permission the agent can hold, why it needs it, and the Helm value that takes it away. The tables are generated from the agent's code and the chart (`npm run docs:permissions` in `agent/`), from the same declarations the chart's RBAC is built from (`agent/src/rbac/`, `deploy/helm/kubernanny/files/rbac.json`). A test fails when this page and the code disagree, so it cannot drift.

Two kinds of switches exist. **Hard switches** are Helm values: they remove the RBAC rule, the route or the outbound connection, so the agent could not do the thing even if it tried, and the app cannot switch it back on. **Soft switches** are in the app (cluster settings, "What is checked"): they stop the agent from using a permission, but the permission stays granted. Use the Helm values for anything that must be impossible.

## Write access at a glance

The agent can change only these things in your cluster, each on one object an open issue names. The exception is `argocd-rollback`: **off by default**, it is offered only after you name it in `actions.enabled`, and then for any manual-sync, single-source Argo CD app, without an open issue. It adds **no new RBAC verb** (the same `patch` on Applications that `argocd-sync` and `argocd-refresh` already hold), but a **new admission-policy branch**, rendered only on opt-in, that lets the agent set a `revision` taken from the app's own history:

<!-- generated:write -->
| Action | Verb and resource | What exactly it changes | What the admission policy still allows the ServiceAccount (Kubernetes 1.30+) | Offered by | How to make it impossible |
|---|---|---|---|---|---|
| `restart` | patch `apps/deployments`, `apps/statefulsets`, `apps/daemonsets` | merge patch of `spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"]` on the Deployment, StatefulSet or DaemonSet the issue names: the same as `kubectl rollout restart` | only an UPDATE that changes nothing but that annotation (spec, template spec and labels, the other annotations, metadata compared); no create, no delete | `argocd`, `pods` | `actions.disabled: [restart]`: the route answers 403 and removes the rule; so does `checks.disabled` for all of `argocd`, `pods`, or `rbac.allowActions: false` for every write action |
| `argocd-sync` | patch `argoproj.io/applications` | merge patch of `operation` (a sync with `initiatedBy.username: kubernanny`) on the Application the issue names: the same as pressing Sync in Argo CD | only `operation` (a sync initiated by `kubernanny`, without `revision(s)`, `source(s)`, `manifests` or `resources`) and the refresh annotation; spec, status, labels, other annotations unchanged; no create, no delete | `argocd` | `actions.disabled: [argocd-sync]`: the route answers 403 and removes the rule only together with `actions.disabled: [argocd-refresh]` (and `argocd-rollback` not named in `actions.enabled`, as by default), or with `checks.disabled` for `argocd`, or `rbac.allowActions: false` for every write action |
| `argocd-rollback` | patch `argoproj.io/applications` | off unless named in `actions.enabled`. Merge patch of `operation` (a sync with `initiatedBy.username: kubernanny` and `sync.revision` set to an earlier entry of the app's own `status.history`, no source, no prune, no options) on a manual-sync, single-source Application the request names: like `argocd app sync --revision`, the app's `spec.source` at that revision. Adds no RBAC verb (the same `patch` as `argocd-sync`), only a branch of the admission policy | rendered only with `actions.enabled: [argocd-rollback]`: additionally a sync initiated by `kubernanny` whose `revision` is the revision of an entry in the stored `status.history` with the same repository as `spec.source`, on an app without automated sync and with a single `spec.source`; no `revisions`, `source(s)`, `manifests`, `resources`, `prune`, `dryRun`, `syncOptions`, `retry`, `apply` or `force`, `info` only `Reason` | `argocd` | Off by default: leave it out of `actions.enabled` (the default). Also `actions.disabled: [argocd-rollback]`: the route answers 403 and removes the rule only together with `actions.disabled: [argocd-refresh]`, `actions.disabled: [argocd-sync]`, or with `checks.disabled` for `argocd`, or `rbac.allowActions: false` for every write action |
| `argocd-refresh` | patch `argoproj.io/applications` | merge patch of the annotation `argocd.argoproj.io/refresh: hard` on the Application the issue names: the same as a hard refresh in Argo CD | the same policy as `argocd-sync`: the refresh annotation set to `hard` or `normal`, nothing else | `argocd` | `actions.disabled: [argocd-refresh]`: the route answers 403 and removes the rule only together with `actions.disabled: [argocd-sync]` (and `argocd-rollback` not named in `actions.enabled`, as by default), or with `checks.disabled` for `argocd`, or `rbac.allowActions: false` for every write action |
| `cnpg-backup` | create `postgresql.cnpg.io/backups` | creates one `Backup` object (`generateName: <cluster>-kubernanny-`, label `app.kubernetes.io/created-by: kubernanny`) for the database cluster the issue names: the same as `kubectl cnpg backup` | only CREATE of a Backup naming a cluster, without `method`, `target`, `online`, `onlineConfiguration` or `pluginConfiguration`; whether the cluster exists is not checked (CNPG fails such a Backup) | `cnpg` | `actions.disabled: [cnpg-backup]`: the route answers 403 and removes the rule; so does `checks.disabled` for `cnpg`, or `rbac.allowActions: false` for every write action |
<!-- /generated:write -->

What starts a write:

- **Only a confirmed tap in the app**, on an action that an issue open right now offers. There is no schedule, no automatic repair and no other trigger.
- **The target comes from the agent's own check**, never from the request. The app sends "run `restart` for issue X"; namespace, kind and name are taken from the issue the agent found itself. A stolen device key can therefore restart what is broken at this moment, and nothing else.
- Before running, the agent checks that the action type is switched on, the issue is still open and still offers that action; otherwise it refuses (`ACTION_DISABLED`, `ISSUE_GONE`, `ACTION_NOT_OFFERED`).
- **Restarts offered on an Argo CD issue** name only a workload the agent's inventory shows not ready, in the Application's destination namespace (`spec.destination.namespace`). The Application's `status.resources` alone is never believed: whoever can edit an Application writes it.

### Admission policy

The rules above are the agent's code. RBAC itself cannot bind a `patch` to one annotation, so a compromised agent pod could otherwise use the actions' permissions for anything on those objects (an image, a service account, an Application's source). The chart therefore installs ValidatingAdmissionPolicies (`templates/admission-policy.yaml`, also in `deploy/install.yaml`) that match only requests of the agent's ServiceAccount and deny everything beyond the column "What the admission policy still allows" in the table above:

- **workloads**: an UPDATE whose pod template spec, template labels, workload labels, annotations, owner references, finalizers and every other spec field (per kind: replicas, selector, strategy, volume claim templates, …) are unchanged, and whose template annotations differ at most in `kubectl.kubernetes.io/restartedAt`. No CREATE, no DELETE.
- **Argo CD Applications**: an UPDATE with spec, status, labels, finalizers and other annotations unchanged; `argocd.argoproj.io/refresh` only `hard` or `normal`; a changed `operation` only initiated by `kubernanny` and without `revision(s)`, `source(s)`, `manifests` or `resources`. No CREATE, no DELETE. Only with `actions.enabled: [argocd-rollback]` a second branch is rendered: the same hook sync by `kubernanny`, but with `sync.revision` equal to the `revision` of an entry in the stored `status.history` whose `source.repoURL` is the app's `spec.source.repoURL`, on an app without `spec.syncPolicy.automated` and with a single `spec.source`; still no `revisions`, `source(s)`, `manifests`, `resources`, `prune`, `dryRun`, `syncOptions`, `retry`, `apply` or `force`, and `info` only `Reason`. Without the opt-in the branch is absent and every `revision` is denied.
- **CNPG Backups**: a CREATE naming a cluster, without `method`, `target`, `online`, `onlineConfiguration` or `pluginConfiguration`. Whether that cluster exists is not checked (a policy sees only the request; CNPG fails a Backup of a missing cluster).

`failurePolicy: Fail`: an expression that cannot be evaluated denies the request. `rbac.admissionPolicy.enabled` (default `true`) renders them while at least one write action is enabled and the cluster serves `admissionregistration.k8s.io/v1` ValidatingAdmissionPolicy (Kubernetes 1.30+); on older clusters nothing is rendered and the chart notes say the policy is missing.

What was verified and what was not: the expressions were evaluated with cel-go (optional types on, objects as plain maps) against allowed and forbidden requests for every resource, the chart was rendered with Helm 3.16. **They have not been run by a real API server**, which type-checks them against each resource's schema: a type-check warning (`kubectl get validatingadmissionpolicy -o yaml`, `status.typeChecking`) or a refused restart after installing is a bug to report. A field Kubernetes adds to a workload's spec in a later version is not compared until it is listed in the template.

Switching it off, from soft to hard:

- in the app: "What is checked", the action's switch (the permission stays granted);
- `actions.disabled: [<type>]`: the action is refused and its permission leaves the ClusterRole (unless another enabled action shares it, see the table);
- `checks.disabled: [<module>]`: the module is not run, so nothing offers its actions; the permissions only it needs leave the ClusterRole;
- `rbac.allowActions: false`: every write verb leaves the ClusterRole, the agent is strictly read-only apart from its own Secrets and ConfigMap.

Audit: every action and every log read is written to the agent's log with the device that asked, the action and the target object (`kubectl -n kubernanny logs deploy/kubernanny | grep audit`). Switching a module, an action or notifications off, maintenance windows, silencing any warning or outage, device changes and accepted vulnerability advisories are also announced through every notification channel at once.

## Per module

A module's reads are granted only while the module is not in `checks.disabled`. Integrations run when their component is detected; core checks run unless switched off, except the ones marked otherwise.

<!-- generated:modules -->
| Id | Module | On by default | Reads, and why | Offers | Other access | How to make it impossible |
|---|---|---|---|---|---|---|
| `nodes` | Nodes | yes | nothing of its own (the inventory) |  |  | `checks.disabled: [nodes]`: not run; removes its issues |
| `node-clocks` | Node clocks | yes | nothing of its own (the inventory) |  |  | `checks.disabled: [node-clocks]`: not run; removes its issues |
| `etcd` | etcd | yes | get, list `k3s.cattle.io/etcdsnapshotfiles`: age of the newest etcd snapshot (k3s, RKE2) | `logs` |  | `checks.disabled: [etcd]`: not run; removes its RBAC rules, its issues |
| `apiserver` | API server | yes | nothing of its own (the inventory) |  |  | `checks.disabled: [apiserver]`: not run; removes its issues |
| `kubernetes-support` | Kubernetes version | yes | nothing of its own (the inventory) |  |  | `checks.disabled: [kubernetes-support]`: not run; removes its issues |
| `pods` | Workloads | yes | nothing of its own (the inventory) | `restart`, `logs` |  | `checks.disabled: [pods]`: not run; removes its issues |
| `pdb` | Disruption budgets | yes | get, list `policy/poddisruptionbudgets`: budgets that allow no disruption and block node drains |  |  | `checks.disabled: [pdb]`: not run; removes its RBAC rules, its issues |
| `hpa` | Autoscalers | yes | get, list `autoscaling/horizontalpodautoscalers`: autoscalers that cannot read metrics or are stuck at their maximum |  |  | `checks.disabled: [hpa]`: not run; removes its RBAC rules, its issues |
| `volumes` | Volumes | yes | nothing of its own (the inventory) |  |  | `checks.disabled: [volumes]`: not run; removes its issues |
| `standard-alerts` | Standard alerts | yes | nothing of its own (the inventory) |  |  | `checks.disabled: [standard-alerts]`: not run; removes its issues |
| `security` | Security | yes | nothing of its own (the inventory) |  |  | `checks.disabled: [security]`: not run; removes its issues |
| `vulnerabilities` | Known vulnerabilities | no (switch on in the app or Helm) | nothing of its own (the inventory) |  | Sends component names and versions to api.osv.dev (Google). No cluster data, no workload names. | `checks.disabled: [vulnerabilities]`: not run; removes its outbound requests, its issues |
| `image-updates` | Newer versions | no (switch on in the app or Helm) | nothing of its own (the inventory) |  | Sends image names (no tags, no cluster data) to their registry: docker.io, ghcr.io, quay.io, registry.k8s.io. | `checks.disabled: [image-updates]`: not run; removes its outbound requests, its issues |
| `longhorn` | Longhorn | when detected | get, list `longhorn.io/volumes`: robustness (degraded, faulted) and size of every volume<br>get, list `longhorn.io/nodes`: disk space and schedulability per storage node<br>get, list `longhorn.io/backups`: age of the newest backup per volume<br>get, list `longhorn.io/backuptargets`: whether the backup target is reachable<br>get, list `longhorn.io/replicas`: where each volume's replicas run and which failed, for the sheet |  |  | `checks.disabled: [longhorn]`: not run; removes its RBAC rules, its issues |
| `cert-manager` | cert-manager | when detected | get, list `cert-manager.io/certificates`: expiry and Ready condition of every certificate<br>get, list `cert-manager.io/clusterissuers`: whether the issuers are ready<br>get, list `acme.cert-manager.io/challenges`: ACME challenges still open, with their state and reason, for the sheet |  |  | `checks.disabled: [cert-manager]`: not run; removes its RBAC rules, its issues |
| `argocd` | Argo CD | when detected | get, list `argoproj.io/applications`: sync and health status of every app | `argocd-sync`, `argocd-refresh`, `argocd-rollback`, `restart` |  | `checks.disabled: [argocd]`: not run; removes its RBAC rules, the permissions of `argocd-refresh`, `argocd-rollback`, `argocd-sync`, its issues |
| `cnpg` | CloudNativePG | when detected | get, list `postgresql.cnpg.io/clusters`: instances, failover state and last backup per database cluster<br>get, list `postgresql.cnpg.io/scheduledbackups`: schedule and last and next run of every scheduled backup, for the sheet | `cnpg-backup`, `logs` |  | `checks.disabled: [cnpg]`: not run; removes its RBAC rules, the permissions of `cnpg-backup`, its issues |
| `prometheus` | Prometheus | when detected | nothing of its own (the inventory) |  | plain HTTP GET to Prometheus over cluster DNS; its answers never carry actions | `checks.disabled: [prometheus]`: not run; removes its outbound requests, its issues |
| `alertmanager` | Alertmanager | when detected | nothing of its own (the inventory) |  | plain HTTP GET to Alertmanager over cluster DNS; its answers never carry actions | `checks.disabled: [alertmanager]`: not run; removes its outbound requests, its issues |
| `grafana` | Grafana | when detected | nothing of its own (the inventory) |  | plain HTTP GET to Grafana over cluster DNS; its answers never carry actions | `checks.disabled: [grafana]`: not run; removes its outbound requests, its issues |
| `loki` | Loki | when detected | nothing of its own (the inventory) |  | plain HTTP GET to Loki over cluster DNS; its answers never carry actions | `checks.disabled: [loki]`: not run; removes its outbound requests, its issues |
| `kured` | kured | when detected | nothing of its own (the inventory) |  | plain HTTP GET to kured over cluster DNS; its answers never carry actions | `checks.disabled: [kured]`: not run; removes its outbound requests, its issues |
| `system-upgrade-controller` | System Upgrade Controller | when detected | get, list `upgrade.cattle.io/plans`: plans that cannot resolve a version, and which nodes are upgrading |  |  | `checks.disabled: [system-upgrade-controller]`: not run; removes its RBAC rules, its issues |
| `velero` | Velero | when detected | get, list `velero.io/backups`: phase and age of the newest backup per schedule |  |  | `checks.disabled: [velero]`: not run; removes its RBAC rules, its issues |
| `metrics-server` | metrics-server | when detected | nothing of its own (the inventory) |  |  | `checks.disabled: [metrics-server]`: not run; removes its issues |
| `flux` | Flux | when detected | get, list `kustomize.toolkit.fluxcd.io/kustomizations`: the Ready condition of every Kustomization<br>get, list `helm.toolkit.fluxcd.io/helmreleases`: the Ready condition of every HelmRelease<br>get, list `source.toolkit.fluxcd.io/gitrepositories`: the Ready condition of every GitRepository |  |  | `checks.disabled: [flux]`: not run; removes its RBAC rules, its issues |
| `external-secrets` | External Secrets | when detected | get, list `external-secrets.io/externalsecrets`: the Ready condition of every ExternalSecret<br>get, list `external-secrets.io/clustersecretstores`: the Ready condition of every ClusterSecretStore |  |  | `checks.disabled: [external-secrets]`: not run; removes its RBAC rules, its issues |
| `infisical` | Infisical | when detected | get, list `secrets.infisical.com/infisicalsecrets`: the secrets.infisical.com/ReadyToSyncSecrets condition of every InfisicalSecret<br>get, list `secrets.infisical.com/infisicalstaticsecrets`: the secrets.infisical.com/LastReconcileStatus condition of every InfisicalStaticSecret<br>get, list `secrets.infisical.com/infisicaldynamicsecrets`: the secrets.infisical.com/Reconcile condition of every InfisicalDynamicSecret<br>get, list `secrets.infisical.com/infisicalpushsecrets`: the secrets.infisical.com/Reconcile condition of every InfisicalPushSecret |  |  | `checks.disabled: [infisical]`: not run; removes its RBAC rules, its issues |
| `gatus` | Gatus | when detected | nothing of its own (the inventory) |  | plain HTTP GET to Gatus over cluster DNS; its answers never carry actions | `checks.disabled: [gatus]`: not run; removes its outbound requests, its issues |
| `uptime-kuma` | Uptime Kuma | when detected | nothing of its own (the inventory) |  | plain HTTP GET to Uptime Kuma over cluster DNS; its answers never carry actions | `checks.disabled: [uptime-kuma]`: not run; removes its outbound requests, its issues |
| `rook-ceph` | Rook Ceph | when detected | get, list `ceph.rook.io/cephclusters`: Ceph health, its warnings and raw capacity per CephCluster |  |  | `checks.disabled: [rook-ceph]`: not run; removes its RBAC rules, its issues |
| `traefik` | Traefik | when detected | nothing of its own (the inventory) |  | plain HTTP GET to Traefik over cluster DNS; its answers never carry actions | `checks.disabled: [traefik]`: not run; removes its outbound requests, its issues |
| `ingress-nginx` | ingress-nginx | when detected | nothing of its own (the inventory) |  | plain HTTP GET to ingress-nginx over cluster DNS; its answers never carry actions | `checks.disabled: [ingress-nginx]`: not run; removes its outbound requests, its issues |
| `kyverno` | Kyverno | when detected | get, list `wgpolicyk8s.io/policyreports`: failing and erroring results per Kyverno policy<br>get, list `wgpolicyk8s.io/clusterpolicyreports`: the same for cluster-scoped resources<br>get, list `kyverno.io/clusterpolicies`: whether a policy enforces (Enforce) and is Ready<br>get, list `kyverno.io/policies`: the same for namespaced policies |  |  | `checks.disabled: [kyverno]`: not run; removes its RBAC rules, its issues |
| `gatekeeper` | OPA Gatekeeper | when detected | get, list `templates.gatekeeper.sh/constrainttemplates`: which constraint kinds exist and whether they compiled<br>get, list `constraints.gatekeeper.sh/*`: violations the audit found per constraint, and its enforcement action |  |  | `checks.disabled: [gatekeeper]`: not run; removes its RBAC rules, its issues |
| `trivy` | Trivy Operator | when detected | get, list `aquasecurity.github.io/vulnerabilityreports`: Trivy Operator's scan of each workload's images: counts and the worst advisories<br>get, list `aquasecurity.github.io/clustervulnerabilityreports`: the same for cluster-scoped resources, where Trivy Operator writes them |  |  | `checks.disabled: [trivy]`: not run; removes its RBAC rules, its issues |
<!-- /generated:modules -->

## Always: the inventory every run reads

These lines are in the ClusterRole whatever is switched off: every check builds on them.

<!-- generated:inventory -->
| Resources | Verbs | Why |
|---|---|---|
| `nodes`, `pods`, `services`, `namespaces`, `events`, `persistentvolumeclaims` | get, list, watch | nodes, pod health, which service belongs to a component, warning events, volumes |
| `apps/deployments`, `apps/statefulsets`, `apps/daemonsets` | get, list, watch | workload readiness, the owner of a crashing pod, component recognition by image |
| `batch/jobs`, `batch/cronjobs` | get, list, watch | failed jobs and missed schedules |
| `networking.k8s.io/ingresses` | get, list, watch | which component is reachable under which address |
| `storage.k8s.io/storageclasses` | get, list, watch | the Storage tab |
| `metrics.k8s.io/nodes`, `metrics.k8s.io/pods` | get, list | CPU and memory, when metrics-server runs |
| `gateway.networking.k8s.io/httproutes` | get, list | addresses published through the Gateway API |
| `traefik.io/ingressroutes` | get, list | addresses published as Traefik IngressRoutes |
| `traefik.containo.us/ingressroutes` | get, list | the same, older Traefik API group |
<!-- /generated:inventory -->

## In its own namespace (Role)

<!-- generated:role -->
| Resources | Names | Verbs | What for |
|---|---|---|---|
| secrets | `kubernanny-identity`, `kubernanny-devices` | get | the agent's X25519 key pair; the names and public keys of paired devices |
| secrets | `kubernanny-devices` | patch | adds a device on pairing, removes it on revocation |
| configmaps | `kubernanny-settings` | get, patch | the switches set in the app, silenced issues, accepted advisories |
| secrets, configmaps | any (see why) | create | creates the three objects above on first start. Kubernetes RBAC cannot limit `create` by name (the name is not known before the object exists), so this line cannot carry `resourceNames`; the agent only ever creates those three |
| coordination.k8s.io/leases | `kubernanny` | get, patch | which pod is in charge during a rolling update (sends notifications, runs actions, holds the relay): renewed every 2 s, released on shutdown |
| coordination.k8s.io/leases | any (see why) | create | creates that Lease on first start (again, `create` cannot be limited by name) |
<!-- /generated:role -->

## What it never has

In no combination of switches, enforced by `agent/src/permissions-doc.spec.ts` against the chart with everything switched on and against `deploy/install.yaml`:

<!-- generated:never -->
- `delete` or `deletecollection` on anything
- wildcards (`*`) in API groups or verbs, or a wildcard resource with anything but get and list
- Secrets outside its own namespace (no Secret in the ClusterRole at all)
- `list` or `watch` on Secrets, or `get`/`patch` on a Secret other than its own two
- `pods/exec`, `pods/attach`, `pods/portforward`
- `services/proxy`, `nodes/proxy`, `pods/proxy` (the API server proxy into the cluster network)
- `escalate`, `bind`, `impersonate`, or any write on RBAC objects
- `create` of pods or workloads, `update` of anything
- anything on nodes but reading them (no cordon, drain or label)
<!-- /generated:never -->

## Switch -> what is removed

Every switch of `values.yaml` (a test fails when one is added without a row here). "Hard" means the app cannot undo it.

<!-- generated:switches -->
| Switch | Hard | RBAC removed | Routes refused | Outbound removed | Other |
|---|---|---|---|---|---|
| `rbac.allowActions: false` | yes | every `patch` and `create` in the ClusterRole (every write action is added to `actions.disabled`, `argocd-rollback` too, whatever `actions.enabled` says) | `POST /api/actions/<type>` answers 403 `ACTION_DISABLED` for restart, argocd-sync, argocd-refresh, cnpg-backup; `POST /api/argocd/rollback` likewise |  | the app shows those action switches as locked |
| `checks.disabled: [notifications]` | yes |  | `POST /api/notify/test` answers 403 `NOTIFICATIONS_LOCKED` | no message through any channel (ntfy, the webhook, app push): issue notifications, security alerts, the weekly report and the test message are not sent; the chart does not even pass NTFY_URL, WEBHOOK_URL or the existing Secret to the agent | the app shows notifications as locked. `checks.disabled: [prometheus]` likewise means no request to Prometheus from any module or view, not only the Prometheus module |
| `rbac.admissionPolicy.enabled: true (default)` | yes |  |  |  | adds ValidatingAdmissionPolicies (Kubernetes 1.30+) that deny every request of the agent's ServiceAccount on workloads, Argo CD Applications and CNPG Backups beyond what its actions change (see the write table). false: the RBAC rules alone apply. Rendered only while a write action is enabled |
| `actions.disabled: [<type>]` | yes | the permission of that action, unless another enabled action needs the same one (see the per-action table) | the action route answers 403 `ACTION_DISABLED`; issues no longer offer the action |  |  |
| `actions.enabled: [] (default)` | yes |  | `POST /api/argocd/rollback` answers 403 `ACTION_DISABLED` before reading anything; the Argo CD sheet lists no history |  | the opt-in action types stay locked in the app. `[argocd-rollback]` turns the rollback on: no new RBAC verb (it shares `patch` on Applications with `argocd-sync`), but the admission policy gains the branch that lets the agent sync a manual-sync app to a revision from its own history; without it that branch is not rendered and a sync with a `revision` is denied. `actions.disabled` and `rbac.allowActions: false` win over it. Ids other than the opt-in ones fail the install |
| `vulnerabilities.enabled: false (default)` | no |  |  | no request to the vulnerability database until someone switches the module on in the app. To make that impossible: `checks.disabled: [vulnerabilities]` |  |
| `imageUpdates.enabled: false (default)` | no |  |  | no request to any container registry until someone switches the module on in the app, and no NetworkPolicy egress rule for registries. To make that impossible: `checks.disabled: [image-updates]` (also drops the egress rule) |  |
| `vulnerabilities.allowAccept: false` | yes |  | `POST /api/vulnerabilities/accept` and `/unaccept` answer 403 `ACCEPT_LOCKED` before reading or writing anything |  | stored acceptances are ignored, every advisory counts again; the app hides the Accept button |
| `relay.enabled: false (default)` | yes |  |  | no `RELAY_URL`: no WebSocket to the relay, and no NetworkPolicy egress rule for it |  |
| `notifications.weeklyDigest.enabled: false (default)` | yes |  |  | no weekly report through the notification channels |  |
| `notifications.appPush.enabled: false` | yes |  | `POST` and `DELETE /api/push/register` and `POST /api/push/test` answer 404 `PUSH_OFF` before reading or writing anything | no Push frame on the relay connection: the agent never hands a push to the relay | push tokens stored earlier are deleted from `kubernanny-devices` on start; the app shows push as locked |
| `ingress.enabled: false (default)` | yes |  |  |  | no Ingress object: the agent is reachable only inside the cluster (or through the relay) |
| `serviceMonitor.enabled: false (default)` | yes |  |  |  | no ServiceMonitor; `/metrics` on port 9100 stays, without names |
| `networkPolicy.enabled: true` | yes |  |  |  | adds a NetworkPolicy: port 8080 only from the ingress controller namespace, 9100 only from the monitoring namespace |
| `networkPolicy.egress.enabled: true` | yes |  |  | everything except DNS, the API server, the monitoring namespace and the HTTPS rules below |  |
| `networkPolicy.egress.internetHttps: false` | yes |  |  | with egress on: HTTPS to the internet (notifications to public services, api.osv.dev). Only together with `networkPolicy.egress.apiServerCIDRs`: without it the API-server rule allows its ports, 443 included, to any address |  |
| `actions.disabled: [argocd-refresh]` | yes | patch `argoproj.io/applications`, once `argocd-rollback`, `argocd-sync` is disabled too | `POST /api/actions/argocd-refresh` answers 403 `ACTION_DISABLED` | | |
| `actions.disabled: [argocd-rollback]` | yes | patch `argoproj.io/applications`, once `argocd-refresh`, `argocd-sync` is disabled too | `POST /api/argocd/rollback` answers 403 `ACTION_DISABLED` | | |
| `actions.disabled: [argocd-sync]` | yes | patch `argoproj.io/applications`, once `argocd-refresh`, `argocd-rollback` is disabled too | `POST /api/actions/argocd-sync` answers 403 `ACTION_DISABLED` | | |
| `actions.disabled: [cnpg-backup]` | yes | create `postgresql.cnpg.io/backups` | `POST /api/actions/cnpg-backup` answers 403 `ACTION_DISABLED` | | |
| `actions.disabled: [logs]` | yes | get `pods/log` | `GET /api/logs` answers 403 `ACTION_DISABLED` | | |
| `actions.disabled: [restart]` | yes | patch `apps/deployments`, `apps/statefulsets`, `apps/daemonsets` | `POST /api/actions/restart` answers 403 `ACTION_DISABLED` | | |
| `checks.disabled: [etcd]` | yes | get, list `k3s.cattle.io/etcdsnapshotfiles` |  |  | not run, no issues |
| `checks.disabled: [pods]` | yes |  |  |  | not run, no issues |
| `checks.disabled: [pdb]` | yes | get, list `policy/poddisruptionbudgets` |  |  | not run, no issues |
| `checks.disabled: [hpa]` | yes | get, list `autoscaling/horizontalpodautoscalers` |  |  | not run, no issues |
| `checks.disabled: [vulnerabilities]` | yes |  | `POST /api/vulnerabilities/accept` and `/unaccept` answer 403 | its requests out of the cluster (Known vulnerabilities) | not run, no issues |
| `checks.disabled: [image-updates]` | yes |  |  | its requests out of the cluster (Newer versions) | not run, no issues |
| `checks.disabled: [longhorn]` | yes | get, list `longhorn.io/volumes`, `longhorn.io/nodes`, `longhorn.io/backups`, `longhorn.io/backuptargets`, `longhorn.io/replicas` |  |  | not run, no issues |
| `checks.disabled: [cert-manager]` | yes | get, list `cert-manager.io/certificates`, `cert-manager.io/clusterissuers`; get, list `acme.cert-manager.io/challenges` |  |  | not run, no issues |
| `checks.disabled: [argocd]` | yes | get, list `argoproj.io/applications`; the permissions of `argocd-refresh`, `argocd-rollback`, `argocd-sync` |  |  | not run, no issues |
| `checks.disabled: [cnpg]` | yes | get, list `postgresql.cnpg.io/clusters`, `postgresql.cnpg.io/scheduledbackups`; the permissions of `cnpg-backup` |  |  | not run, no issues |
| `checks.disabled: [prometheus]` | yes |  |  | every request to Prometheus, from every module and view (nodes, volumes, etcd, clocks, ingress error rates, history) | not run, no issues |
| `checks.disabled: [alertmanager]` | yes |  |  | HTTP to Alertmanager | not run, no issues |
| `checks.disabled: [grafana]` | yes |  |  | HTTP to Grafana | not run, no issues |
| `checks.disabled: [loki]` | yes |  |  | HTTP to Loki | not run, no issues |
| `checks.disabled: [kured]` | yes |  |  | HTTP to kured | not run, no issues |
| `checks.disabled: [system-upgrade-controller]` | yes | get, list `upgrade.cattle.io/plans` |  |  | not run, no issues |
| `checks.disabled: [velero]` | yes | get, list `velero.io/backups` |  |  | not run, no issues |
| `checks.disabled: [flux]` | yes | get, list `kustomize.toolkit.fluxcd.io/kustomizations`; get, list `helm.toolkit.fluxcd.io/helmreleases`; get, list `source.toolkit.fluxcd.io/gitrepositories` |  |  | not run, no issues |
| `checks.disabled: [external-secrets]` | yes | get, list `external-secrets.io/externalsecrets`, `external-secrets.io/clustersecretstores` |  |  | not run, no issues |
| `checks.disabled: [infisical]` | yes | get, list `secrets.infisical.com/infisicalsecrets`, `secrets.infisical.com/infisicalstaticsecrets`, `secrets.infisical.com/infisicaldynamicsecrets`, `secrets.infisical.com/infisicalpushsecrets` |  |  | not run, no issues |
| `checks.disabled: [gatus]` | yes |  |  | HTTP to Gatus | not run, no issues |
| `checks.disabled: [uptime-kuma]` | yes |  |  | HTTP to Uptime Kuma | not run, no issues |
| `checks.disabled: [rook-ceph]` | yes | get, list `ceph.rook.io/cephclusters` |  |  | not run, no issues |
| `checks.disabled: [traefik]` | yes |  |  | HTTP to Traefik | not run, no issues |
| `checks.disabled: [ingress-nginx]` | yes |  |  | HTTP to ingress-nginx | not run, no issues |
| `checks.disabled: [kyverno]` | yes | get, list `wgpolicyk8s.io/policyreports`, `wgpolicyk8s.io/clusterpolicyreports`; get, list `kyverno.io/clusterpolicies`, `kyverno.io/policies` |  |  | not run, no issues |
| `checks.disabled: [gatekeeper]` | yes | get, list `templates.gatekeeper.sh/constrainttemplates`; get, list `constraints.gatekeeper.sh/*` |  |  | not run, no issues |
| `checks.disabled: [trivy]` | yes | get, list `aquasecurity.github.io/vulnerabilityreports`, `aquasecurity.github.io/clustervulnerabilityreports` |  |  | not run, no issues |
| `checks.disabled: [<any other id>]` | yes | | | | not run, no issues (nothing of its own in the ClusterRole) |
<!-- /generated:switches -->

## How to verify

As the agent's ServiceAccount, in a running cluster:

```sh
SA=system:serviceaccount:kubernanny:kubernanny
kubectl auth can-i --list --as=$SA                       # everything, cluster-wide
kubectl auth can-i --list --as=$SA -n kubernanny         # plus its own namespace
kubectl auth can-i get secrets -n default --as=$SA       # no
kubectl auth can-i delete pods -n default --as=$SA       # no
kubectl auth can-i create pods/exec -n default --as=$SA  # no
kubectl auth can-i patch deployments -n default --as=$SA # yes, unless rbac.allowActions: false
# The admission policy (Kubernetes 1.30+): RBAC says yes, the policy says no.
kubectl -n default set image deploy/<any> '*=busybox' --as=$SA --dry-run=server     # denied
kubectl -n default rollout restart deploy/<any> --as=$SA --dry-run=server           # allowed
```

Before installing, render the chart with the switches you plan and read the ClusterRole:

```sh
helm template kubernanny deploy/helm/kubernanny -n kubernanny | yq 'select(.kind == "ClusterRole")'
helm template kubernanny deploy/helm/kubernanny -n kubernanny --set rbac.allowActions=false | grep -E '"(patch|create)"'   # nothing
helm template kubernanny deploy/helm/kubernanny -n kubernanny --set 'checks.disabled={argocd}' | grep argoproj.io        # nothing
helm template kubernanny deploy/helm/kubernanny -n kubernanny --set 'actions.disabled={restart}' | grep -A2 '"apps"'     # get, list only
helm template kubernanny deploy/helm/kubernanny -n kubernanny --set 'actions.disabled={logs}' | grep pods/log            # nothing
```

CI runs the same renders and fails when a switched-off permission is still granted. Without Helm, `deploy/install.yaml` is the chart with everything on; edit its ClusterRole by hand to drop lines.
