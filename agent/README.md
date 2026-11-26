# kubernanny

The part of Kubernanny that runs in your cluster: reads the Kubernetes API once a minute, recognises components, runs checks, offers four bound actions, sends notifications and serves the API and the web UI.

```sh
(cd ../protocol && npm ci && npm run build)   # the shared end-to-end protocol, linked as file:../protocol
npm ci
npm run start:demo          # built-in demo cluster on :8080 (DEMO=broken|warning|healthy)
npm test                    # Vitest
npm run typecheck
```

Against a real cluster: `kubectl proxy`, then `K8S_API_URL=http://127.0.0.1:8001 npm run start:dev`. In the pod: `node dist/cli.js pair | devices | revoke <id>`.

| Directory | Contents |
|---|---|
| `src/inventory` | one read of the cluster per run |
| `src/discovery` | the component catalog and image matching |
| `src/checks` | pure judgement functions (nodes, pods, etcd, Longhorn, certificates, Argo CD, CNPG, alerts) |
| `src/modules` | core modules, inspectors, in-cluster HTTP and Prometheus |
| `src/status` | run loop, snapshot, light, score, history |
| `src/views` | detail views and history for the app's tabs |
| `src/actions` | the issue actions, logs and the opt-in rollback |
| `src/notify` | when and how to notify |
| `src/auth`, `src/pairing` | agent key pair, paired device keys, one-time pairing codes |
| `src/e2e` | `POST /api/e2e` (Noise, replay cache, rate limit) and the internal Unix socket |
| `src/cli.ts` | admin commands inside the pod |
| `src/metrics` | `kubernanny_*` in Prometheus text format |
| `src/demo` | the demo cluster |

Architecture: [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md). API: [../docs/API.md](../docs/API.md). Every environment variable: [../docs/CONFIGURATION.md](../docs/CONFIGURATION.md).
