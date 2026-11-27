# Changelog

Agent, chart and relay. The apps in the App Store and on Google Play have their own release notes (`fastlane/release-notes/`).

## 0.4.0 (2026-11-27)

Install: `helm upgrade --install kubernanny oci://ghcr.io/kubernanny/charts/kubernanny --version 0.4.0 -n kubernanny`, or `kubectl apply -f deploy/install.yaml` from the `v0.4.0` tag. **New permission**: the agent may now delete Jobs (`job-delete`, on by default), held by the admission policy to failed Jobs of a CronJob or without owner; `actions.disabled: [job-delete]` keeps the old permissions.

### Added

- **Delete a failed Job from the app** (`job-delete`, on by default): a CronJob whose last run failed, or a failed Job nobody owns, offers to delete that Job with its pods, so the warning and alerts on it (`KubeJobFailed`) go. Only the Job the agent saw (by uid); the admission policy allows deleting failed Jobs of a CronJob or without owner, nothing else. `actions.disabled: [job-delete]` removes it and its permission. [CHECKS.md](docs/CHECKS.md#actions).
- **The app shows which actions are off, and why**: an issue lists the actions that would fit but are switched off (`unavailable`), off in the app (switch it on with one tap) or locked in the deployment, as opt-in or disabled, with the Helm values line to copy. The settings group the actions into active, switched off in the app and locked in the Helm chart. `GET /settings` names why an action is locked (`lockedBy`) and whether it is opt-in. [API.md](docs/API.md).

## 0.3.1 (2026-11-26)

### Fixed

- **The chart is signed again**: 0.3.0 was published, but its cosign signature was refused by the registry. Same chart and images as 0.3.0 otherwise; [SECURITY.md](docs/SECURITY.md) shows how to verify.

## 0.3.0 (2026-11-26): first public release

Install: `helm install kubernanny oci://ghcr.io/kubernanny/charts/kubernanny --version 0.3.0 -n kubernanny --create-namespace`, or `kubectl apply -f deploy/install.yaml` from the `v0.3.0` tag. Images: `ghcr.io/kubernanny/agent:0.3.0`, `ghcr.io/kubernanny/relay:0.3.0`.

### Added

- **An agent in your cluster** that recognises about 75 components by their images (Longhorn, Argo CD, cert-manager, CloudNativePG, Prometheus, Velero, Flux, Rook Ceph, Traefik, Trivy Operator and more, plus your own via `customComponents`), checks them every 60 seconds and on changes, and sums it up as a traffic light, a score and one sentence. [CHECKS.md](docs/CHECKS.md), [COMPONENTS.md](docs/COMPONENTS.md).
- **Core checks**: nodes, etcd, the API server, workloads, CronJobs and Jobs, rollouts, volumes, disruption budgets, autoscalers, node clocks, Kubernetes end of support and deprecated APIs still in use.
- **Security checks and updates** as hints: security posture, known vulnerabilities of the running versions from OSV (off by default), Trivy Operator's reports, available image updates (off by default). A security hint you keep on purpose is accepted in Git with a reason, by the annotation `kubernanny.io/accept` on the workload. [SECURITY-CHECKS.md](docs/SECURITY-CHECKS.md).
- **Actions bound to an open issue**: the agent offers only the action that fixes what it found (restart a crashing workload, sync or refresh an Argo CD app, start an overdue backup, uncordon a node, …), the target comes from the issue and never from the request, some actions are opt-in, and admission policies limit each write to exactly what it changes. [PERMISSIONS.md](docs/PERMISSIONS.md).
- **You decide what it looks at**: every module, action and notification can be switched off in the app or locked off in Helm, where the chart's RBAC drops the permission with it. The permissions reference is generated from the code.
- **The app** for iOS, Android and the browser: overview, issues with cause and fix, nodes, workloads, storage, network, events, backups across Longhorn, Velero, CloudNativePG and etcd, seven days of incidents that survive restarts and rollouts, seven days of CPU and RAM even without Prometheus, logs of the crashed run, home-screen widgets. English and German.
- **End to end encrypted**: every call between a device and the agent is a Noise IK handshake between the device's own key and the agent key pinned at pairing, whatever carries it. No tokens, no account. [PROTOCOL.md](docs/PROTOCOL.md).
- **Pairing** by QR code or link from the agent's log, always confirmed with the agent key's fingerprint; devices listed and revoked in the app or with `kubectl exec`.
- **The relay** (optional) for access without a VPN: the agent dials out, the relay passes sealed messages on and sees neither content nor names. A public one at relay.kubernanny.app, or run your own (Node image or Cloudflare Worker). [RELAY.md](docs/RELAY.md).
- **Notifications** to ntfy, Discord, Slack, Gotify or a webhook, with full or minimal detail, a weekly digest, silences and maintenance windows.
- **Native push** to the app, sealed per phone (the relay, Google and Apple see a token and a size), an optional sign of your own on every real push (off by default), hourly silent status pushes for the widgets, and a **dead man's switch**: the relay warns the phone when the agent or the whole cluster goes silent. [NOTIFICATIONS.md](docs/NOTIFICATIONS.md).
- **Security changes are announced**: pairing a device, revoking one, switching notifications, modules or actions off and long silences each send a notification first, naming the device; every action and log read is in the audit log.
- **A hardened deployment**: non-root, read-only file system, no Secret read but its own two, no `services/proxy`, an optional NetworkPolicy, `kubernanny_*` metrics on a separate port, a multi-arch image without npm, base pinned by digest.
- **Supply chain**: agent and relay images and the chart signed with cosign (keyless), with SBOM and provenance; CI actions pinned by commit. [SECURITY.md](docs/SECURITY.md).
- **A demo**: `DEMO=broken|warning|healthy` on the agent, the demo button in the app, and demo.kubernanny.app.
- **Reviewed**: an independent security review and a pentest before the release; what they found and what changed is summarised in [SECURITY.md](docs/SECURITY.md).

### Changed

For anyone who ran a 0.2 test build:

- **Devices pair with their own key pair** instead of a bearer token, and the admin token is gone (admin tasks run with `kubectl exec`). Pair every device again after the upgrade. [ADR 0002](docs/decisions/0002-device-keys-instead-of-tokens.md).

Earlier versions were never published.
