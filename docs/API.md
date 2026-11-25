# Agent HTTP API

The app and the web UI use only this API. Everything is JSON, under `/api`. **No route below is reachable directly**: every call travels end-to-end encrypted through `POST /api/e2e` ([PROTOCOL.md](PROTOCOL.md)), which authenticates the device and hands the call to these routes over the agent's internal socket. The paths, methods and bodies below are what goes *inside* the encrypted envelope (`m`, `p`, `b`). On the public port they answer 401 `E2E_REQUIRED`. Every response carries the security headers described in [COMMUNICATION.md](COMMUNICATION.md); API responses are `Cache-Control: no-store`. Types: `agent/src/status/status.service.ts`, `agent/src/views/*.ts`; the app mirrors them in `app/src/app/core/agent.model.ts`.

## Language

Every text a person reads comes in the language the request asks for: issue titles and causes, module names, descriptions, summaries and stat labels, settings labels and privacy notes, history series labels, action results (`done`) and error messages. The app sets `l` (`en` or `de`) in the sealed request ([PROTOCOL.md](PROTOCOL.md#message-1-device-to-agent)); without it, or with a value the agent does not know, the agent answers in its default, `LANGUAGE` (`en` unless configured). Ids, codes, severities, states, numbers and everything else machine-readable are the same in every language, and so are texts that come from the cluster itself (a condition's message, an alert's summary, a component's name). Notifications, the weekly report and the pairing banner in the pod log have no reader to ask and always use `LANGUAGE`.

## Errors

Errors carry the HTTP status and a body with a stable `code` and a `message` in the request's language, which the app may show as is (switch on `code`, never on `message`):

```json
{ "code": "ISSUE_GONE", "message": "The problem no longer exists." }
```

| Code | Status | Meaning |
|---|---|---|
| `E2E_REQUIRED` | 401 | an API route called directly instead of through `/api/e2e` |
| `E2E_CLOCK_SKEW` | 401 | the device's clock is more than 5 minutes off (60 seconds for `POST` and `DELETE`), or the call is dated before the agent started (its replay cache is in memory only); the sealed answer carries the agent's time |
| `E2E_BUSY` | 503 | too many calls in flight inside the agent (sealed), or the replay cache is full (plain); try again |
| `E2E_INTERNAL` | 502 | the agent decrypted the call but could not carry it out internally (sealed); try again |
| `DEVICE_UNKNOWN` | 401 | the device key is not (or no longer) paired |
| `PAIRING_CODE_INVALID` | 401 | code wrong, expired or used |
| `PAIRING_RATE_LIMITED` | 429 | more than 5 wrong codes in 10 minutes; the code itself stays valid |
| `PAIRING_UNAVAILABLE` | 503 | the agent cannot store keys (RBAC for `kubernanny-identity` / `kubernanny-devices` missing) |
| `DEVICE_NOT_FOUND` | 404 | revoking a device that does not exist |
| `ACTION_DISABLED` | 403 | the action type is switched off |
| `SETTING_LOCKED` | 403 | switched off in the deployment, only changeable there |
| `SETTING_UNKNOWN` | 400 | unknown module or action id in `POST /settings` |
| `ADMIN_ONLY` | 403 | a device asked for a route of the admin CLI |
| `ISSUE_GONE` | 409 | the issue no longer exists (fixed meanwhile) |
| `ACTION_NOT_OFFERED` | 404 | the issue does not offer that action |
| `ACTION_UNKNOWN` | 400 | not one of the four action types |
| `NO_CHANNEL` | 400 | test notification without a configured channel |
| `NOTIFICATIONS_LOCKED` | 403 | test notification while `checks.disabled: [notifications]` switches every channel off |
| `NOTIFY_FAILED` | 502 | the test notification did not reach every channel; the message names the failing one |
| `ACCEPT_LOCKED` | 403 | accepting advisories is switched off in the deployment (`vulnerabilities.allowAccept: false`) |
| `MODULE_OFF` | 403 | accepting an advisory while neither the `vulnerabilities` module nor the `trivy` integration is running |
| `ADVISORY_NOT_FOUND` | 404 | the advisory is not reported for that component right now |
| `ACCEPT_DAYS`, `ACCEPT_TARGET`, `ACCEPT_REASON`, `ACCEPT_LIMIT` | 400 | duration other than 30, 90 or 365; component or advisory missing or malformed; reason not text; more than 500 accepted |

## On the public port

### `GET /healthz`

`{ "ok": true }`. Liveness only, contains no cluster data.

### `GET /api/identity`

`{ "publicKey": "-DOwtH7H5Dqd…", "fingerprint": "6CR3-RQZS-NBKK-9VND" }`: the agent's public key, for pairing by hand. The app fetches it only over `https://`, from `localhost` or from the web UI's own origin; pairing links carry it already.

### `POST /api/e2e`

`application/octet-stream`: one sealed call, see [PROTOCOL.md](PROTOCOL.md). 200 with a sealed answer once the handshake completed (the call's own status is inside); otherwise a plain `{ "code": … }`: `E2E_VERSION`, `E2E_HANDSHAKE`, `E2E_REPLAY` (400), `E2E_TOO_LARGE` (413, bodies over 64 KiB), `E2E_RATE_LIMITED` (429: the handshake ceiling of the path (direct or relayed), the source address's own bucket, or the caller's own budget, per device or shared by unknown keys, see [PROTOCOL.md](PROTOCOL.md)), `E2E_BUSY` (503).

## Pairing (inside the envelope)

### `POST /pair`

The only call an unpaired key may make. Registers the key **that sealed the call**:

```json
{ "code": "RHTXZ-YAGBS", "name": "iPhone, Safari" }
```

```json
{ "deviceId": "de472efc-a079-4503-bef2-e0892e04b925", "cluster": "homelab" }
```

Case and dashes are ignored. A code works once, for 60 minutes. Wrong attempts never burn it: past five in 10 minutes they are answered `429 PAIRING_RATE_LIMITED`, while the right code still pairs. A new pairing is announced through the notification channels. The name is cleaned (control characters become spaces, 40 characters) and appears in the device list and the audit log. Pairing the same key again keeps the device and takes the new name.

## Status

### `GET /status`

The last snapshot, answered from memory.

```jsonc
{
  "cluster": "homelab",
  "light": "red",                       // green | yellow | red | unknown
  "score": 28,                          // 0..100
  "checkedAt": "2026-11-24T16:27:22.410Z",
  "durationMs": 19,
  "kubernetes": { "version": "v1.33.4+rke2r1", "distribution": "RKE2" },
  "overview": {
    "nodes": { "ready": 3, "total": 3 },
    "pods": { "running": 62, "total": 64 },
    "cpu": { "usedMilli": 5400, "allocatableMilli": 16000 },   // null without metrics-server
    "memory": { "used": 47244640256, "allocatable": 65498251264 },
    "volumes": { "bound": 11, "total": 12 },
    "ingresses": 12, "namespaces": 16, "workloads": 35, "components": 27,
    "prometheus": true, "metricsServer": true
  },
  "modules": [
    {
      "id": "longhorn", "name": "Longhorn", "category": "storage", "icon": "server-outline",
      "description": "Repliziertes Block-Storage über alle Nodes.",
      "namespace": "longhorn-system", "version": "1.9.0",
      "status": "warning",              // ok | warning | critical | error | skipped
      "summary": "Volume weblate/data-weblate-0 degraded",
      "stats": [{ "label": "Platte frei", "value": "271 GiB von 640 GiB", "tone": "ok" }],
      "links": [{ "label": "longhorn.example.com", "url": "https://longhorn.example.com" }],
      "workloads": { "ready": 5, "total": 5, "items": [{ "kind": "DaemonSet", "namespace": "longhorn-system", "name": "longhorn-manager", "ready": 3, "desired": 3 }] },
      "issueIds": ["longhorn/pvc-1f3e…"]
    }
  ],
  "issues": [
    {
      "id": "pods/default/Deployment/social-importer",
      "check": "pods", "module": "pods",
      "severity": "critical",
      "title": "default/social-importer: CrashLoopBackOff",
      "cause": "back-off 5m0s restarting failed container. Letzter Exit: Error (Code 1). 14 Neustarts.",
      "since": "2026-11-24T16:27:22.410Z",
      "actions": [
        { "type": "logs", "namespace": "default", "pod": "social-importer-6b7d9-x2k4p", "container": "social", "previous": true },
        { "type": "restart", "kind": "Deployment", "namespace": "default", "name": "social-importer" }
      ]
    }
  ],
  "error": "only set when the last run could not read the cluster",
  "failingSince": "only set while runs fail: ISO time of the first failed run in a row"
}
```

Texts above are shown in German (`l: "de"`); with `l: "en"` the same snapshot reads `"description": "Replicated block storage across all nodes."`, `"label": "Disk free"`, `"value": "271 GiB of 640 GiB"` and so on.

When a run cannot read the cluster (API server unreachable, RBAC), the snapshot keeps the last good run, with its `checkedAt` (so the app and `kubernanny_last_run_timestamp_seconds` show how old it is), and adds `error` and `failingSince`. From the third failed run in a row the light is `red` and one critical issue `agent/cluster-unreachable` ("Kubernanny cannot read the cluster", with the error as cause) joins the issues; it is recorded and notified like any issue (silences, the notification switch and maintenance windows apply), and disappears with the first run that reads the cluster again.

Issues are sorted critical first, then by age, then in the order the modules report them (never by title, so the order is the same in every language). `since` is when this agent process first saw the issue. Issues of the `vulnerabilities` module and of the `trivy` integration also carry `advisories`: advisory ids (`["GHSA-423p-g724-fr39"]`, `["CVE-2024-21538"]`), which the app links to `https://osv.dev/vulnerability/<id>`; they never offer actions. The `vulnerabilities` module and the `trivy` integration carry `canAccept` (advisories can be marked as not applicable, see `POST /vulnerabilities/accept`) and `accepted`: `[{ component, name, advisory, until, by, reason? }]`.

### `POST /status/refresh`

Runs all checks now and answers with the new snapshot.

### `GET /info`

```json
{
  "agentVersion": "0.3.0", "cluster": "homelab", "intervalSeconds": 60, "notifyAfterSeconds": 300,
  "channels": ["ntfy", "discord"], "agentKey": "-DOwtH7H5Dqd…", "agentFingerprint": "6CR3-RQZS-NBKK-9VND", "prometheus": true,
  "components": ["longhorn", "argocd", "…"]
}
```

The app shows the fingerprint of the key it pinned, not the one in this answer.

## Detail views

| Route | Returns |
|---|---|
| `GET /nodes` | `NodeView[]`: roles, ready, cordoned, rebooting (kured), kubelet, OS, kernel, runtime, arch, IP, CPU and memory (allocatable, requested by pods, used), root disk share, pod count and capacity, abnormal conditions, taints |
| `GET /workloads` | `WorkloadView[]`: kind, namespace, name, ready/desired, health, recognised component, images, restarts, CPU and memory of all pods, pods with node, phase, readiness, restarts |
| `GET /storage` | `{ classes, volumes }`: StorageClasses (provisioner, default, expansion, reclaim policy, volume count); PVCs with capacity, used bytes (Prometheus), access modes, pods using them, Longhorn robustness and replicas |
| `GET /network` | `{ ingresses, loadBalancers }`: hosts, TLS, certificate with days left (matched by secret name), backends, class, component; LoadBalancer services with addresses and ports |
| `GET /events` | up to 200 Kubernetes `Warning` events, newest first, one row per object and reason: `{ time, namespace, kind, name, reason, message, count, firstSeen, events }`. Kubernetes writes a new Event whenever the message changes; those are merged, `count` summed, `message` and `time` from the newest, `firstSeen` from the oldest, `events` how many were merged (1: none) |
| `GET /history?hours=6` | `{ source, hours, series[] }`. `hours` 1..168. Series ids: `cpu`, `memory` (ratios), `net-in`, `net-out` (bytes/s), `restarts`, `etcd-fsync`, `apiserver-p99` (seconds), `node-cpu:<node>`, `node-memory:<node>`. `source: agent` without Prometheus: only `cpu` and `memory`, at most 6 h. |

### `GET /incidents?days=7`

The issues of the last `days` days (1..7, default 7; larger values answer 7) as episodes, newest start first. From the agent's memory: the same episodes the weekly report counts, recorded every run whether notifications are on or not. Hints (`info`) are never recorded. After a restart the history starts again; `coveredSince` says from when, and the app should say that nothing before it is known.

```ts
interface IncidentsView {
  coveredSince: string;          // ISO: when the agent started watching
  days: number;                  // the window answered, 1..7
  incidents: IncidentView[];     // newest start first
}
interface IncidentView {
  id: string;                    // unique per episode: "<issueId>@<start>"
  issueId: string;               // the issue id, as in /status while it is open
  title: string;                 // the title when it was first seen, in the request's language
  severity: 'warning' | 'critical';   // critical if it was critical at any point
  module: string;                // module id, as in /status
  start: string;                 // ISO, when the agent first saw it
  end: string | null;            // ISO; null while still open
  durationMs: number;            // until end, or until now while open
  silenced: boolean;             // someone silenced it during the episode
}
```

An issue that goes away and comes back is two episodes with the same `issueId`. The demo agent answers with a believable week of resolved incidents (calm when healthy, rough when broken) plus whatever is open now.

### `GET /backups`

Every backup the agent already reads, one row per protected thing, judged with the thresholds the checks use (`BACKUP_MAX_AGE_HOURS`: older a warning, twice as old critical). Built from the last run, no API call of its own; a switched-off module contributes nothing.

```ts
interface BackupsView {
  maxAgeHours: number;
  rows: BackupRow[];             // worst first, then cnpg, longhorn, etcd, velero, then by id
  targets: BackupTargetView[];   // Longhorn backup targets
  unprotected: { kind: 'cnpg' | 'longhorn'; name: string; namespace?: string }[];
}
interface BackupRow {
  id: string;                    // cnpg/<ns>/<cluster>, longhorn/<volume>, etcd, velero/<schedule>
  kind: 'cnpg' | 'longhorn' | 'etcd' | 'velero';
  name: string;                  // cluster, the volume's PVC (else the volume), "etcd", the Velero schedule
  namespace?: string;            // cnpg and longhorn (the PVC's) only
  lastSuccess: string | null;    // ISO time of the last successful backup
  ageMs: number | null;          // its age at the time of the run
  state: 'ok' | 'warning' | 'critical';
  note?: string;                 // why it is not ok
  target: { type: 's3' | 'azure' | 'gcs' | 'nfs' | 'cifs' | 'local' | 'unknown'; location?: string } | null;
  count: number | null;          // backups or snapshots listed for it; null for CNPG (only the last one is known)
}
interface BackupTargetView {
  kind: 'longhorn'; name: string; type: BackupRow['target']['type']; location: string;
  available: boolean | null;     // null while Longhorn has not checked it
}
```

Sources and rules, each the same as its check: CNPG clusters with backups configured (`status.lastSuccessfulBackup`; failing WAL archiving makes the row critical; target from `barmanObjectStore.destinationPath`, `unknown` for the barman-cloud plugin), Longhorn backups per volume (a failed newest backup is a warning; an unreachable backup target makes every volume row critical), RKE2/k3s etcd snapshots as one row (S3 or local, from the last good snapshot), Velero backups per schedule (the newest run's phase; schedules older than the threshold a warning; the target is the storage location's name, as the agent does not read BackupStorageLocations). `unprotected`: CNPG clusters without backup configuration and attached Longhorn volumes without any backup; not judged, not every volume needs one. `location` is the configured URL without a query string; Longhorn and CNPG keep credentials in Secrets, not in these URLs.

## Actions

### `POST /actions/:type?issue=<issue id>&index=<n>`

`type`: `argocd-sync`, `argocd-refresh`, `restart`, `cnpg-backup`. `index` picks among several actions of the same type on one issue (an Argo CD app with two degraded Deployments offers two restarts), default 0.

```json
{ "done": "Deployment social-importer wird neu gestartet." }
```

The agent looks up the issue in its current snapshot and runs the action stored there; the request cannot name a target. After an action the agent starts a new run.

### `GET /logs?issue=<issue id>&index=<n>`

The last 300 lines (with timestamps) of the pod named by the issue's `logs` action; for `CrashLoopBackOff` those of the previous, crashed container.

```json
{ "pod": "social-importer-6b7d9-x2k4p", "container": "social", "previous": true, "text": "2026-11-24T04:02:12.006Z ERROR …" }
```

## Devices, pairing and notifications

| Route | Purpose |
|---|---|
| `GET /devices` | every paired device: `{ id, name, createdAt, lastSeenAt, push, current }[]` (`lastSeenAt` since the agent started; `push`: native push is registered; never the public key or a push token) |
| `DELETE /devices/:id` | revoke a device (204); its key stops working on the next call. Any paired device may revoke any other (the lost-phone case); each revocation is announced through the notification channels first. |
| `POST /pair/code` | a new one-time code for another device: `{ code, app, web }` (links as in the log, with the agent key). The previous code stops working. |
| `POST /pair/code/banner` | admin CLI only (`node dist/cli.js pair`): the start banner with a fresh code, as text |
| `POST /issues/silence?issue=<id>&hours=<1, 8, 24 or 168>` | silences an open issue: it stays in `issues` with `silencedUntil`, but no longer counts for light and score and sends no notification. `{ silencedUntil }`; 404 `ISSUE_GONE`, 400 `SILENCE_HOURS`. Silencing a critical issue, and four or more silences within 10 minutes, are announced through the notification channels first. |
| `POST /issues/unsilence?issue=<id>` | ends the silence at once (204) |
| `POST /maintenance?hours=<1, 2, 4, 8 or 24>` | starts a maintenance window (or moves its end): checks go on, notifications wait until it ends; the snapshot carries `maintenanceUntil`. Starting one is announced through the notification channels first. `{ maintenanceUntil }`; 400 `MAINTENANCE_HOURS`. |
| `POST /maintenance/end` | ends it at once (204) |
| `POST /vulnerabilities/accept` | marks one advisory on one component as not applicable: `{ "component": "cnpg", "advisory": "GHSA-423p-g724-fr39", "days": 90, "reason": "operator not exposed" }`; for a Trivy Operator finding the component is the workload, `trivy:<namespace>:<kind>:<name>` in lower case (`trivy:default:deployment:social-importer` for the issue `trivy/default/Deployment/social-importer`), and it is listed in the `trivy` module's `accepted` (`days` 30, 90 or 365; `reason` optional, cleaned, at most 200 characters). Only an advisory the component's issue lists right now. It no longer counts for that issue (the issue goes when nothing remains) and appears in the vulnerabilities module's `accepted` until it expires. Announced through the notification channels first, written to the audit log. `{ acceptedUntil }`. Refused with 403 `ACCEPT_LOCKED` (Helm `vulnerabilities.allowAccept: false`) or `MODULE_OFF` before anything is read or written. |
| `POST /vulnerabilities/unaccept` | `{ "component", "advisory" }`: counts again at once (204); the same 403s |
| `GET /settings` | what runs: `{ modules: [{ id, name, icon, category, description, deep, detected, state, defaultOff?, privacy? }], actions: [{ type, label, description, effect, state }], notifications }`, each `state` `on`, `off` (app) or `locked` (deployment). `defaultOff`: the module stays off until switched on (`vulnerabilities`); `privacy`: what it sends out of the cluster, shown next to its switch; `effect`: what an action may change in the cluster, one line ([PERMISSIONS.md](PERMISSIONS.md) has the details) |
| `POST /settings` | switch within the deployment's limits: `{ "modules": { "argocd": false }, "actions": { "restart": false }, "notifications": true }`. 403 `SETTING_LOCKED` for anything switched off in the deployment, 400 `SETTING_UNKNOWN` for unknown ids. Answers with the new view; a new run starts at once. Switching notifications, a module or an action off is announced through the notification channels first, naming the device, whatever the notification switch says. |
| `POST /notify/test` | sends a test message through every channel: `{ channels: ["ntfy", "discord", "app"] }` (`app`: native push to every registered device) |
| `GET /push` | native push for the calling device: `{ state, relay, registered }`; `state` `on`, `locked` (`APP_PUSH=off` in the deployment) or `no-relay`; `relay`: the relay is connected and delivers push now |
| `POST /push/register` | `{ "token": "<FCM token>", "platform": "ios" \| "android", "key": "<push public key, base64url>" }`: native push to the calling device, sealed for that key (204). Replaces an earlier registration of the same device. 400 `PUSH_INVALID`, `PUSH_DEVICE_ONLY`; 409 `PUSH_NO_RELAY`. The token is never logged; `GET /devices` shows only `push: true`. |
| `DELETE /push/register` | turns native push off for the calling device (204); its token and key are deleted |
| `POST /push/test` | one test push to the calling device only: `{ outcome }` (`sent`, `unavailable`, `rate_limited`, …); 409 `PUSH_NOT_REGISTERED` |

The three push writes answer `404 PUSH_OFF` before reading or writing anything when the deployment switched native push off (`notifications.appPush.enabled: false`).

## Metrics (port 9100)

`GET /metrics` in Prometheus text format, no auth, not on the ingress:

| Metric | Labels | Meaning |
|---|---|---|
| `kubernanny_health_score` | | 0..100 |
| `kubernanny_light` | | 0 green, 1 yellow, 2 red, 3 unknown |
| `kubernanny_issues` | `severity` | open issues |
| `kubernanny_module_status` | `module`, `category` | 0 ok, 1 warning, 2 critical, 3 error |
| `kubernanny_components_detected` | | recognised components |
| `kubernanny_run_duration_seconds` | | duration of the last run |
| `kubernanny_last_run_timestamp_seconds` | | for staleness alerts |

Example alert: `time() - kubernanny_last_run_timestamp_seconds > 300` (the agent stopped checking).
