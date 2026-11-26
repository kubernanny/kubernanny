# kubernanny

The part of Kubernanny that runs in your cluster: reads the Kubernetes API once a minute, recognises components, runs checks, offers a few actions bound to open issues ([list](../docs/PERMISSIONS.md)), sends notifications and serves the API and the web UI.

```sh
(cd ../protocol && npm ci && npm run build)   # the shared end-to-end protocol, linked as file:../protocol
npm ci
npm run start:demo          # built-in demo cluster on :8080 (DEMO=broken|warning|healthy)
npm test                    # Vitest
npm run typecheck
```

Against a real cluster: `kubectl proxy`, then `K8S_API_URL=http://127.0.0.1:8001 npm run start:dev`. In the pod: `node dist/cli.js pair | devices | revoke <id>`.

Architecture, with what each directory under `src/` holds: [../docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md#the-agent). API: [../docs/API.md](../docs/API.md). Every environment variable: [../docs/CONFIGURATION.md](../docs/CONFIGURATION.md).
