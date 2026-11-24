# Security model

Kubernanny runs with read access to most of your cluster and a few write verbs. This page says exactly what it can do, what an attacker with each piece could do, and what keeps that small.

## What the agent can do

ClusterRole (`deploy/helm/kubernanny/templates/rbac.yaml`, mirrored in `deploy/install.yaml`, kept in step by `agent/src/rbac.spec.ts`):

| Access | Resources | Why |
|---|---|---|
| get, list | nodes, pods, services, namespaces, events, PVCs | inventory |
| get | pods/log | logs of the pod an issue names |
| get, list | deployments, statefulsets, daemonsets, jobs, cronjobs, ingresses, storageclasses, metrics | inventory |
| get, list | Longhorn volumes and nodes, cert-manager certificates and ClusterIssuers, Argo CD applications, CNPG clusters, upgrade plans, Velero backups, Flux kustomizations/helmreleases/gitrepositories, External Secrets, InfisicalSecrets | integrations (each only while switched on in the chart) |
| **patch** | deployments, statefulsets, daemonsets | restart (`rbac.allowActions`) |
| **patch** | Argo CD applications | sync, hard refresh (`rbac.allowActions`) |
| **create** | CNPG backups | backup now (`rbac.allowActions`) |

Role in its own namespace: `get` on the Secrets `kubernanny-identity` (its key pair) and `kubernanny-devices` (public keys of paired devices), by name; `patch` on `kubernanny-devices`; `get`/`patch` on the ConfigMap `kubernanny-settings` (the switches set in the app), and `create` on Secrets and ConfigMaps (Kubernetes cannot restrict `create` by name; the agent creates only those three). No `list`, no `delete`, no access to Secrets in any other namespace.

The ClusterRole is generated per module and action from the agent's code (`deploy/helm/kubernanny/files/rbac.json`). `checks.disabled: [argocd]` removes every Argo CD rule, reads and the `patch` its actions need. `actions.disabled: [restart]` removes the `patch` on workloads. A permission two actions share stays while either is enabled: `patch` on Argo CD Applications needs both `argocd-sync` and `argocd-refresh` disabled (or the module). `rbac.allowActions: false` removes every write verb. Switches in the app are softer: they stop the agent from using a permission, but the permission stays granted; use the Helm values for anything that must be impossible.

What it **cannot** do: read Secrets other than its own two, delete anything, exec into pods, change RBAC, create workloads, reach services through the API server proxy. With `rbac.allowActions: false` it has no write verb except its own two Secrets.

## Network

- **Inbound**: port 8080 (web UI, `/healthz`, `/api/identity` and the end-to-end endpoint `/api/e2e`; every other API route only through the in-pod socket) and 9100 (metrics). Every call is end-to-end encrypted and authenticated ([PROTOCOL.md](PROTOCOL.md)), so plain HTTP in a LAN is fine; still keep 8080 on a VPN or not exposed at all. The chart's ingress never routes `/metrics`.
- **Outbound**: the API server; Prometheus, Alertmanager, Grafana and Loki over cluster DNS (only GET on their read endpoints); your notification endpoints. Only if you switch them on: one WebSocket to the relay (`relay.enabled`, carries sealed messages only, [RELAY.md](RELAY.md)) and HTTPS to api.osv.dev or your mirror (`vulnerabilities.enabled`, package names and versions only, [SECURITY-CHECKS.md](SECURITY-CHECKS.md)). With NetworkPolicies, allow exactly these; the chart's policy does. The complete list with ports and how to check it: [IN-CLUSTER.md](IN-CLUSTER.md).

## Threats

| If someone gets… | They can | They cannot | Mitigation |
|---|---|---|---|
| **a device's private key** (lost, unlocked phone) | read the status, node and workload lists, events, logs of pods that currently have an issue; sync or refresh a broken Argo app; restart a currently broken workload; start a CNPG backup of a cluster whose backup is overdue; create a pairing code and so pair a device of their own; **blind and lock out the owner**: switch notifications, any module or any action off, silence issues, start a 24 h maintenance window, revoke every other device | name any other target, restart healthy workloads, delete, read Secrets, switch on anything the Helm values switched off, do any of the blinding changes unnoticed | actions bound to open issues; switching notifications, a module or an action off, starting a maintenance window, revoking a device and pairing a new one each send **one notification through your channels first**, naming the device, even with notifications off in the app or during maintenance (only `checks.disabled: [notifications]` in Helm silences them); every change is in the audit log with the device. On such a message you did not expect: **revoke that device** from another paired device (settings → Paired devices) or with `node dist/cli.js revoke <id>`, check the settings, and if it already revoked your devices, [rotate everything](#rotating-everything) |
| **the agent's key** (Secret `kubernanny-identity`) | answer devices in the agent's place, if they also control the network path; read recorded requests | act as a device, read recorded answers | only readable with kubectl; rotate by deleting the Secret (all devices pair again) |
| **the device list** (Secret `kubernanny-devices`) | public keys and names | anything | nothing secret in it |
| **the pod's log** | a pairing code: expired after 60 min, single use; the agent's public key | a credential | none needed |
| **a pairing code** | pair one device, once, within 60 min; it then shows in the device list, the log and as a notification | anything after the code was used | revoke the unknown device |
| **the agent's public key** (a pairing link, a QR code) | send pairing attempts, directly or through the relay: wrong ones get `429 PAIRING_RATE_LIMITED` past 5 per 10 minutes, and all strangers together share a small budget (about 7200 attempts an hour at most) | guess a code (31^10 codes, under 10^-11 per code's hour), burn the code, keep the owner from pairing (the right code is compared before any throttle), use up a paired device's budget | none needed |
| **the network path** (Wi-Fi, ingress, proxy, relay) | see sizes and timing; drop calls | read, change or replay calls; pose as the agent | end-to-end encryption with a pinned agent key |
| **the pod** (RCE in the agent) | everything the ServiceAccount can (above), the agent key | read other Secrets, escalate via RBAC | non-root, read-only root FS, no capabilities, seccomp; `rbac.allowActions: false` for read-only |
| **the metrics port** | the score, issue counts, module status | issue texts, names, logs | not on the ingress; NetworkPolicy |
| **the phone's storage** | nothing usable: the device keys are in the Keychain / Keystore, bound to this device | | revoke the device if the phone itself is lost |
| **the browser profile** (web UI) | the device keys of the clusters paired in that browser | | revoke the device; prefer the app on shared computers |

**Keys.** Device and agent keys are X25519; every call is a Noise IK handshake (`Noise_IK_25519_ChaChaPoly_BLAKE2b`) on audited primitives (`@noble/*`), checked against libsodium's implementation and published test vectors. Pairing codes are compared in constant time.

**Every channel** (app, pairing, Kubernetes API, monitoring, notifications, metrics, logs) with its protection and residual risks: [COMMUNICATION.md](COMMUNICATION.md).

**Logs of pods with an issue** are readable by every paired device. They can contain secrets your application logs. If that matters, restrict who may use the app, or set `rbac.allowActions: false` and remove `pods/log` from a custom ClusterRole.

## Revoking a device

In the app: cluster settings → Paired devices → Remove. Any paired device can revoke any other, including itself. Or in the pod:

```sh
kubectl -n kubernanny exec deploy/kubernanny -- node dist/cli.js devices
kubectl -n kubernanny exec deploy/kubernanny -- node dist/cli.js revoke <id>
```

The key is dead on the next call.

## Rotating everything

```sh
kubectl -n kubernanny delete secret kubernanny-identity kubernanny-devices
kubectl -n kubernanny rollout restart deploy/kubernanny
kubectl -n kubernanny logs deploy/kubernanny    # new key, new pairing code
```

All devices must pair again; the app reports the old agent key as no longer answering.

## Supply chain

One image, built by GitHub Actions from this repository (`Dockerfile`, multi-arch). Runtime dependencies: NestJS, rxjs, reflect-metadata, qrcode, and `@noble/curves`, `@noble/ciphers`, `@noble/hashes` (audited, pure JavaScript, pinned to exact versions) through the shared `protocol/` package. The web UI is built in the same pipeline and copied into the image; it loads no third-party resources at runtime (fonts are bundled).

Every published image carries a build provenance attestation and an SBOM, and is signed keyless with Sigstore by the workflow itself (no long-lived key exists). Verify before you deploy:

```sh
cosign verify ghcr.io/kubernanny/agent:<version> \
  --certificate-identity-regexp '^https://github.com/kubernanny/kubernanny/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
docker buildx imagetools inspect ghcr.io/kubernanny/agent:<version> --format '{{ json .SBOM }}'
```

The Helm chart in `oci://ghcr.io/kubernanny/charts/kubernanny` is signed the same way. CI also renders the chart with the switches (`checks.disabled`, `actions.disabled`, `rbac.allowActions`) and fails if a switched-off permission is still granted.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private vulnerability reporting on this repository ("Security" tab → "Report a vulnerability"). You will get an answer within a week.
