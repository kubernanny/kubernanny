# Changelog

## 0.3.0 (unreleased)

### Kubernanny

- The project is called **Kubernanny** now (the name Pulse is taken by an established homelab monitor). Everything moved: image `ghcr.io/kubernanny/agent`, chart `oci://ghcr.io/kubernanny/charts/kubernanny`, namespace `kubernanny`, Secrets `kubernanny-identity` and `kubernanny-devices`, URL scheme `kubernanny://`, metrics `kubernanny_*`, app id `app.kubernanny`. New icon: the nanny whose one eye is the traffic light.

### Switches

- Every tool is a subclass of `Integration` (core checks of `CoreCheck`), one file each, declaring what it reads and which actions it may offer.
- Modules, action types and notifications can be switched off in the app ("What is checked") and in Helm (`checks.disabled`, `actions.disabled`). The chart's RBAC is generated from the modules' declarations and leaves out whatever is switched off in Helm, so a disabled Argo CD integration has no permission to read or patch Argo CD at all.
- `DISABLED_MODULES` and `DISABLED_ACTIONS`; `DISABLED_CHECKS` still works.

### Security: end to end

- Every call between app and agent is a Noise IK handshake (`Noise_IK_25519_ChaChaPoly_BLAKE2b`) between the device's own key pair and the agent's key pinned at pairing: confidential and authenticated end to end, whatever carries it (TLS, plain HTTP in the LAN, a proxy). Specification with test vectors: `docs/PROTOCOL.md`; decision records in `docs/decisions/`.
- Shared `protocol/` package on audited `@noble/*` primitives, cross-tested against libsodium's Noise implementation in CI.
- No bearer tokens any more. Devices are public keys in `kubernanny-devices`; the agent's key pair lives in `kubernanny-identity`. Pairing links and the QR code carry the agent key; the log and the app show its fingerprint.
- Replay cache and a 5-minute clock window; the app corrects its clock from the agent's authenticated answer. Rate limit on handshakes.
- API routes are only reachable through the end-to-end endpoint, over an in-pod Unix socket; on the TCP port they answer 401.
- Admin CLI in the pod: `node dist/cli.js pair | devices | revoke <id>`.
- Plain `http://` addresses work in the app once the key is pinned; fetching an unpinned key still needs https, localhost or the same origin.
- Sandbox: 1 MiB in-memory `/tmp` for the socket; memory request raised to 128 Mi (measured ~96 MB RSS).

### Security fixes after review

- Rate limits no longer let strangers lock out paired devices: size, version and replay checks cost nothing, the handshake has only a generous CPU ceiling, and after it each paired device spends its own budget while unknown keys and pairing share one small one.
- Pairing codes: the right code is compared before any throttle and is never burnt by wrong attempts, so nobody who knows the agent key can block pairing (`PAIRING_RATE_LIMITED` past 5 wrong codes in 10 minutes, direct or through the relay).
- Replay entries are written before the clock check; calls that change something get a 60 s clock window (reads keep 5 minutes).
- A failed internal dispatch is answered sealed (`502 E2E_INTERNAL`) instead of dropping the answer.
- An unreachable API server is no longer silent: the snapshot keeps the last good `checkedAt`, adds `failingSince`, and after 3 failed runs turns red with the issue `agent/cluster-unreachable`, notified like any other.
- Every route is guarded by default (`@Public()` only for `/healthz`, `/api/identity`, `/api/e2e`).
- Switching notifications, modules or actions off, starting a maintenance window, revoking a device and pairing one each send one notification first, naming the device, even with notifications off in the app or during maintenance.
- Concurrent changes to settings, silences and devices no longer overwrite each other; `DEMO` must be a known value; calendar tags are not looked up as releases; CVSS vectors cannot read inherited properties; the relay backoff resets after a stable connection dies silently.

### Relay: reach the cluster without a VPN

- Optional relay (`relay.enabled: true`): the agent dials out over WebSocket, the app falls back to the relay when the cluster is not reachable directly (a 4 s check, then GET calls only). The relay passes sealed Noise messages along; it sees an agent id (a hash of the agent's public key), sizes and timing, never content. Two implementations: Node (NestJS + ws, image `ghcr.io/kubernanny/relay`, signed like the agent) and a Cloudflare Worker with Durable Objects. `docs/RELAY.md`.
- Hardened after an independent review: in-flight byte budgets per agent with a fair share and a progress timeout, caps on pending connections and registered agents per address, `TRUST_PROXY` off by default, WebSocket frame limits on the agent, pairing attempts throttled through the relay (`PAIRING_RATE_LIMITED`). New limits: `RELAY_MAX_INFLIGHT_BYTES`, `RELAY_INFLIGHT_SHARE`, `RELAY_PROGRESS_TIMEOUT_MS`, `RELAY_STREAM_TIMEOUT_MS`, `RELAY_MAX_PENDING_PER_IP`, `RELAY_MAX_AGENTS_PER_IP`; on a full relay the address with the most agents gives one up for a newcomer.
- The app picks up the relay URL from the agent's `/info` in the background.

### New checks and views

- Security posture: privileged containers, host network/PID/paths, root, missing memory limits, untagged images, as hints (`docs/SECURITY-CHECKS.md`).
- Known vulnerabilities of the running versions (Kubernetes and mapped components) from OSV.dev, off by default (`vulnerabilities.enabled`, `VULN_DB_URL` for a mirror); answers cached 12 h, a database that is down is left alone for 15 minutes. Modules can be off until switched on (`ENABLED_MODULES`).
- Kubernetes end of support: your minor against the upstream support table, and, with Prometheus, deprecated APIs still in use that the next minor removes (a warning before you upgrade into breakage).
- Gatus and Uptime Kuma: failing endpoint monitors.
- Your own components (`customComponents`), matched by image.
- Incident history (`GET /incidents`): every problem with start, end and duration, a seven-day strip in the app.
- Backups overview across Longhorn, Velero, CloudNativePG and etcd snapshots, with unprotected volumes and databases.
- Events grouped by object and reason ("35× in 39 min").

### Living with it

- Push straight to the Kubernanny app (iOS, Android), sealed per device with HPKE: the relay and Google see a token and a size, never the text. Through the relay and Firebase Cloud Messaging; `notifications.appPush.enabled: false` makes it impossible. Decision record 0007.
- Notification state survives agent restarts: no repeated "opened", "resolved" still sent.

- Silence a known problem for 1, 8, 24 or 168 hours: still shown, but no light, score or notification. Stored in the `kubernanny-settings` ConfigMap, so it survives restarts.
- Maintenance window: 1 to 24 hours without notifications for planned work; the checks and the app go on, and whatever is still broken afterwards is sent then.
- Weekly digest (`notifications.weeklyDigest`): incidents of the week, open problems, on a weekday and hour in `timezone`.
- The app says when a newer agent is out (`agentVersion` in the snapshot).
- Share a status report from the app as plain text, without ids, addresses or keys (the native share sheet, Web Share, or the clipboard).

### Checks for more of the stack

- Rook Ceph (health with Ceph's own messages, raw capacity, operator), Traefik and ingress-nginx 5xx rates from Prometheus (only with enough traffic), Kyverno and Gatekeeper policy violations (hints), node clock offset.
- Trivy Operator (`trivy`): reads its VulnerabilityReports (read only, nothing leaves the cluster), one issue per workload with the built-in lookup's severity rules and per-workload "does not apply here". Components Trivy covers are left to it. The built-in lookup now says plainly that it only compares Kubernetes and 13 recognised components, not your own images.
- Available image updates for recognised components (off by default, `imageUpdates.enabled`; repository names only leave the cluster).
- Mark one known-vulnerability advisory on one component as not applicable for 30, 90 or 365 days: announced, audited; `vulnerabilities.allowAccept: false` makes it impossible.

### Permissions, documented from the code

- `docs/PERMISSIONS.md` is generated from the same code as the chart's RBAC and kept in step by a test: every write verb with what exactly it changes, every read per module with its reason, the namespace Role, what the agent never holds, and which Helm switch removes what (RBAC rule, route, outbound connection).
- The app shows under each action switch what it may change. The landing page lists the hard switches ("Off means gone").

### English and German

- The app follows the device language, with a switch at the foot of the cluster list. The agent words every text per request in the app's language (`l` in the sealed request) and its notifications in `LANGUAGE`.

### Demo

- The app's first screen offers a demo, and https://demo.kubernanny.app is the web app straight in demo mode: a recorded cluster in three states, kept fresh by shifting its times, with actions that pretend to work. Recordings come from the agent's demo cluster (`npm run demo:export`).

### Apps and releases

- Home-screen widgets (iOS WidgetKit, Android RemoteViews): each cluster's light, headline and last check, no keys and no issue texts on the device's shared storage; off per cluster or altogether.
- `npm run store:shots` renders the store screenshots in every required size, English and German.

- Native iOS and Android apps (Capacitor 8, Swift Package Manager), `kubernanny://` links, icons and splash (`npm run native-assets`). Device keys in the Keychain and Android Keystore, never in a backup.
- fastlane: `npm run release`, `release:production`, `store:metadata`, `store:screenshots`. `docs/RELEASING.md`.

### Website

- kubernanny.app: landing page and the documentation from `docs/`, prerendered with Analog and deployed to Cloudflare Pages on every push to main.

### Supply chain and tests

- Agent and relay images and the Helm chart are signed with cosign (keyless) and carry an SBOM and provenance; `docs/SECURITY.md` shows `cosign verify`.
- Playwright end-to-end tests against the web demo and a running agent in CI; CI also checks that the chart's RBAC follows the switches.

### Breaking

- `LANGUAGE` defaults to `en`: set `language: de` in the chart for German notifications.
- `PULSE_TOKEN`, `existingTokenSecret` and the Secret `kubernanny-token` are gone; the agent refuses to start while `PULSE_TOKEN` is set. Every device pairs again after the upgrade (`kubectl -n kubernanny exec deploy/kubernanny -- node dist/cli.js pair`). The Secret `kubernanny-token` can be deleted.
- `POST /api/pair` and bearer authentication are removed; `GET /info` reports `agentKey` and `agentFingerprint` instead of `tokenSource`.

## 0.2.0 (unreleased)

### Security

- A token per device, stored only as a SHA-256 hash in `kubernanny-devices`; device list and revocation in the app and the API. The admin token is never handed out.
- Audit log of actions, log reads, pairings and revocations with the device name.
- Security headers on everything the agent serves: strict CSP without inline scripts, no framing, `nosniff`, `no-referrer`, HSTS behind HTTPS, `no-store` on the API; 4 KB request bodies.
- The app sends tokens only over HTTPS, or to localhost.
- Data from Prometheus, Alertmanager, Grafana and Loki can never carry actions; responses capped at 8 MB, no redirects.
- Notification URLs must be HTTPS (HTTP only in-cluster); `NOTIFY_DETAIL=minimal` sends no names.
- Optional NetworkPolicy in the chart.

### Agent

- Manual Argo CD apps out of sync are a hint, not a warning: hints never colour the light, cost score or notify.
- Recognises about 75 components by their container images and links them to their ingress URLs.
- Deep checks for Longhorn, cert-manager, Argo CD, CloudNativePG, Prometheus, Alertmanager, Grafana, Loki, kured, System Upgrade Controller, Velero, Flux, External Secrets, Infisical and metrics-server.
- New core checks: failed CronJob runs and Jobs, stuck rollouts, pending and lost PVCs, full volumes, node memory and disk.
- Detail views: nodes, workloads, storage, network, events; history from Prometheus or from metrics-server.
- Health score next to the traffic light.
- Creates its own token in a Secret; the log shows a one-time pairing code with a QR code, never the token.
- Notifications to Discord, Slack, Gotify and JSON webhooks besides ntfy; test notification.
- `kubernanny_*` metrics on a separate port.
- Serves the web UI.
- Reaches Prometheus and friends over cluster DNS; no `services/proxy` permission.
- Demo mode in three scenarios.

### App

- New design: heartbeat, one-sentence headline, seven tabs, component sheets, logs view, desktop layout, light and dark.
- Pairing by link, QR code or typed code; pair another device from the settings.

### Deployment

- Generic Helm chart (OCI), plain manifests, multi-arch image with the web UI, ServiceMonitor.

## 0.1.0

- First agent with five checks (nodes, Longhorn, cert-manager, Argo CD, CNPG), traffic light, ntfy.
