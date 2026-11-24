# Security checks

Two modules look at the security of what runs in the cluster, not at its health:

| Module | Default | Reads | Sends out of the cluster |
|---|---|---|---|
| Security posture (`security`) | on | the pod specs the run already lists | nothing |
| Known vulnerabilities (`vulnerabilities`) | **off** | `/version` and the detected components (already read) | component package names and versions to api.osv.dev, or your mirror |

<p><img src="screenshots/65-sheet-security.png" alt="Security posture hints" width="260"> <img src="screenshots/64-sheet-vulnerabilities.png" alt="Known vulnerabilities" width="260"></p>

*The security posture check and the vulnerability lookup in the app.*

Neither needs a permission the agent does not already have, and neither offers an action: they say what to change, you change it in your manifests or charts.

## Security posture (`security`)

Purely from the inventory: every pod's spec, grouped by the workload that owns it (Deployment, StatefulSet, DaemonSet, CronJob, an operator's resource such as a CNPG `Cluster`, or the bare pod).

| Finding | Severity | When | Fix in the text |
|---|---|---|---|
| `security/<ns>/privileged` | **warning** | a container (or init container) sets `securityContext.privileged: true` | remove it; grant only the capabilities needed |
| `security/<ns>/host-access` | hint | `hostNetwork`, `hostPID`, `hostIPC` or a `hostPath` volume | remove where possible; PersistentVolume instead of hostPath |
| `security/<ns>/root` | hint | a container has neither `runAsNonRoot: true` nor a non-zero `runAsUser` (container setting over pod setting), or sets `runAsUser: 0` | `securityContext.runAsNonRoot: true` (and `runAsUser` if the image has no user) |
| `security/<ns>/no-memory-limit` | hint | a container has no `resources.limits.memory` | set a memory limit |
| `security/<ns>/mutable-image` | hint | an image with the tag `latest` or no tag at all, and no digest | a fixed version or a digest |

- **One issue per finding type and namespace**, not per pod: ten replicas, or a namespace of twenty charts without limits, are one line that lists up to five workloads ("und 3 weitere"). A homelab does not drown in hints.
- **Hints never colour the light**, never cost score and are never sent. The one warning is a privileged container outside the system namespaces: whoever takes over that container has the node.
- **Left alone**: the system namespaces `kube-system`, `kube-public`, `kube-node-lease`, `calico-system`, `tigera-operator`, `cattle-system`, `cattle-fleet-system`, `longhorn-system`, `metallb-system`, `rook-ceph`, `openebs`, `system-upgrade`, plus `checks.systemNamespaces` (`SECURITY_SYSTEM_NAMESPACES`). Their pods need host access by design and are not yours to fix.
- **Host-level components**: workloads of recognised components that need privileges, host access or root wherever they are installed (Longhorn, Rook Ceph, OpenEBS, NFS provisioner, Local Path Provisioner, Node Exporter, Promtail, Grafana Alloy, kured, System Upgrade Controller, Cilium, Calico, Flannel, MetalLB, kube-vip, CrowdSec) are left out of the first three findings in any namespace. Missing limits and mutable tags still count for them.
- **Only memory limits.** CPU limits are debated (they throttle a container even when the node is idle); a missing memory limit is what lets one container push the node into evicting others.
- **Not checked**: Secrets exposed as environment variables. A pod spec only shows `secretKeyRef` and `envFrom`, not whether the value is sensitive or whether the program logs its environment, so any finding would be a guess.

Stats: findings, namespaces with privileged containers, namespaces with findings, how many namespaces are exempt.

## Known vulnerabilities (`vulnerabilities`)

### What it does

Once per run (every minute) the module collects the versions Kubernanny already knows:

- **Kubernetes**: `/version`'s `gitVersion` with the distribution suffix cut (`v1.33.4+rke2r1` becomes `1.33.4`), looked up as the Go module `k8s.io/kubernetes`, under which OSV lists the advisories of the control plane components.
- **Recognised components** whose catalog entry names an OSV package (`osv` in `agent/src/discovery/catalog.ts`), at the version of their image tag (`v1.12.0-build20250218` becomes `1.12.0`, `8.1-alpine` becomes `8.1.0`). A tag that is not a version (`latest`, a date, a digest only) is not looked up; the module's stats count those as "Ohne Abgleich".

It asks OSV which advisories affect each version (`POST /v1/querybatch`), fetches each advisory (`GET /v1/vulns/{id}`), and keeps both in memory for 12 hours, so each version is asked about at most twice a day. Records that are aliases of each other (`GO-2026-5106` and `GHSA-423p-g724-fr39` for the same CVE) count once, shown under the GHSA id.

### Mapped components

Only packages where real queries (November 2026) showed that OSV has advisories under release versions matching the image tags:

| Component | OSV package |
|---|---|
| Argo CD | Go `github.com/argoproj/argo-cd` (`/v2`, `/v3` by major version) |
| cert-manager | Go `github.com/cert-manager/cert-manager` |
| CloudNativePG | Go `github.com/cloudnative-pg/cloudnative-pg` |
| External Secrets | Go `github.com/external-secrets/external-secrets` |
| Flux | Go `github.com/fluxcd/source-controller` (only when the version came from the source-controller image) |
| Kyverno | Go `github.com/kyverno/kyverno` |
| Traefik | Go `github.com/traefik/traefik/v2`, `/v3` (v1 lived under another path: not looked up) |
| Cilium | Go `github.com/cilium/cilium` |
| Velero | Go `github.com/vmware-tanzu/velero` |
| Gitea | Go `code.gitea.io/gitea` (only the `gitea/gitea` image; Forgejo shares the catalog entry but not the version numbers) |
| Vaultwarden | crates.io `vaultwarden` |
| Weblate | PyPI `weblate` |
| n8n | npm `n8n` |

Left out on purpose, after checking:

- **Grafana**: its Go module is not versioned like its releases. OSV lists fixes as pseudo-versions (`1.9.2-0.2026…`), and advisories from 2020 without a fixed version would show up on Grafana 12.
- **Prometheus**: the Go module versions (`v0.305.0`) do not match the release tags (`3.5.0`).
- **Harbor**: fixes as pseudo-versions and `+incompatible` tags; the same false positives as Grafana.
- **Longhorn, Nextcloud, authentik, Immich, Paperless-ngx, kured, MetalLB**: OSV returned no advisories under the package names we tried, old versions included, so we could not confirm that it covers them. A clean result would only suggest safety.
- **Rancher, Portainer, ingress-nginx, Vault, Keycloak**: many advisories without any fixed version for current releases; we could not tell real unfixed issues from incomplete ranges, and did not want to guess.

Adding one: set `osv` on the catalog entry, check a few versions with real queries first (an old version with known advisories must return them, a current one should not return advisories from years ago), and add it to the table above.

### Severity

The severity of an advisory comes from its CVSS v3 vector (scored with the formula of the specification), else from the database's own label (GitHub's `CRITICAL`, `HIGH`, `MODERATE`, `LOW`; CVSS v4 vectors are not scored). Bands: critical from 9.0, high from 7.0, medium from 4.0.

One issue per affected component, `vulnerabilities/<component id>` (`vulnerabilities/kubernetes` for the cluster itself):

| Issue severity | When |
|---|---|
| critical | a critical advisory with a released fix, on a component reachable through an ingress (Ingress, HTTPRoute or Traefik IngressRoute) |
| warning | a critical advisory with a released fix on a component without one, or a high advisory with a released fix |
| hint | everything else: medium and low advisories, and advisories no release fixes yet |

A warning nobody can act on teaches people to ignore the light, so advisories without a fix stay hints. The cluster itself is never "reachable through an ingress" in this sense: a Kubernetes advisory is at most a warning.

Title and cause: `Argo CD 2.11.3: 3 bekannte Schwachstellen`, then the worst ids with their level and score, and the first release that fixes all fixable ones ("Behoben in 2.11.7"), or that no update is known yet. The app links every id to `https://osv.dev/vulnerability/<id>`, opened in the system browser; it builds that URL itself from ids that look like advisory ids, so neither the agent nor the database can make it open another site. The issue is shown on the module and on the component's own sheet. It never offers an action.

Stats: versions checked, advisories per level, components without a lookup, the database host.

### When the database cannot be reached

- With answers from the last 7 days in memory: the module shows them and says so ("Stand vor 3 h, api.osv.dev gerade nicht erreichbar").
- Without (first run, or the agent restarted while offline): the module shows "not checkable" with the reason. Like any module that cannot run, that keeps the light from being green (yellow, never red) and sends nothing.

### What leaves the cluster

Only while the module is switched on: OSV ecosystem names, package names and versions (`Go`, `github.com/argoproj/argo-cd/v3`, `3.1.2`), and advisory ids. No cluster name, namespace, workload name, host name, address or anything from a pod spec. api.osv.dev is run by Google; its terms and privacy policy apply to those requests. Your IP address is visible to it, as to any server.

That is why the module is **off by default**, unlike every other check. The app shows the sentence "Schickt Namen und Versionen der Komponenten an api.osv.dev (Google). Keine Clusterdaten, keine Namen von Workloads." next to its switch (with your mirror's host instead, when one is set).

### Switching it on and off

| Where | Effect |
|---|---|
| App, cluster settings → "What is checked" → "Known vulnerabilities" | on or off for this agent, stored in the ConfigMap `kubernanny-settings` |
| Helm `vulnerabilities.enabled: true` (env `ENABLED_MODULES=vulnerabilities`) | on by default for this install; the app can still switch it off, and that choice is kept |
| Helm `checks.disabled: [vulnerabilities]` (env `DISABLED_MODULES`) | locked off; the app cannot switch it on |
| `DEMO=…` | on, with a built-in database (below) |

With `networkPolicy.egress.enabled`, the chart adds egress for the database while the module is enabled in Helm: HTTPS to anywhere (a NetworkPolicy cannot name a host), unless `networkPolicy.egress.internetHttps` already allows it or `vulnerabilities.dbNamespace` names the namespace of your mirror. Switched on only in the app, the module needs that egress too.

### A self-hosted database

`vulnerabilities.dbUrl` (env `VULN_DB_URL`) replaces `https://api.osv.dev`. It must be HTTPS, or plain HTTP to an in-cluster `*.svc` host. Any server that answers `POST /v1/querybatch` and `GET /v1/vulns/{id}` the way api.osv.dev does ([API docs](https://google.github.io/osv.dev/api/)) works. Building blocks:

- The OSV project publishes its complete data set, one zip per ecosystem (for example `https://osv-vulnerabilities.storage.googleapis.com/Go/all.zip`, see [data dumps](https://google.github.io/osv.dev/data/)).
- The code of osv.dev itself is open source (`github.com/google/osv.dev`).

We have not tested a particular mirror; if you run one, a note in an issue or a pull request for this page is welcome. The links in the app keep pointing at osv.dev: opening one sends that advisory id from your phone to osv.dev, nothing else.

### Demo and tests

The demo cluster never calls the internet: `DemoVulnDb` (`agent/src/demo/demo-vulns.ts`) answers like OSV from two real records, fetched once and trimmed. In the broken scenario the CloudNativePG operator runs 1.26.1, affected by GHSA-423p-g724-fr39 (critical, CVSS 9.9, fixed in 1.28.3, no ingress: a warning); the other scenarios run 1.28.3 and stay clean. The tests use a fake `fetch` for the OSV client.
