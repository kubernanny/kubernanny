# 0003: Decrypted calls reach the routes through a Unix socket

**Status**: accepted (0.3.0)

## Context

The end-to-end endpoint decrypts a call and must then run it like any API call: same routes, pipes, guards and audit log. Re-implementing routing inside the endpoint would mean two code paths that drift apart. Sending it back to the agent's own TCP port would need a secret header and opens the door for anything that can reach that port (another pod, or a request the agent itself is tricked into making) to pose as a device.

## Decision

The agent serves its express app a second time on a Unix socket in the pod (`INTERNAL_SOCKET`, default `/tmp/kubernanny.sock`, mode 0600, on an in-memory emptyDir). Requests arriving there get a JavaScript symbol property set on them, which no network input can set; the guard accepts a principal header only on such requests. On the public port every route but `/healthz`, `/api/identity` and `/api/e2e` answers 401 `E2E_REQUIRED`.

The admin CLI (`node dist/cli.js pair | devices | revoke <id>`) uses the same socket. Whoever can `kubectl exec` into the pod is admin, which matches what they could do anyway.

## Consequences

- One routing path for every caller; the existing controller tests cover both.
- No secret header, no shared secret in memory to leak.
- Outgoing HTTP calls of the agent (Prometheus, Grafana, webhooks) cannot be steered onto a socket file, so server-side request forgery cannot reach the internal API.
- `readOnlyRootFilesystem` needs a writable `/tmp`: the chart mounts a 1 MiB in-memory emptyDir.
- Socket paths are limited to about 100 bytes; the agent refuses longer ones at start.
