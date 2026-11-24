# Kubernanny relay on Cloudflare Workers

The same relay as the Node service in `relay/` (same HTTP API, same registration proof, the same per-agent limits, built from the same code in `relay/src/core` and `@kubernanny/protocol`; the relay-wide and per-address limits have no Worker equivalent, see docs/RELAY.md), running as a Worker with one Durable Object per agent id. The object holds the agent's WebSocket with the WebSocket Hibernation API: between calls it is evicted from memory while the socket stays open, and the agent's heartbeat (`ping` -> `pong`) is answered by the runtime without waking it.

How the relay works and what it can see: [docs/RELAY.md](../../docs/RELAY.md).

## Deploy

You need a Cloudflare account. Durable Objects with the SQLite storage backend are used (`new_sqlite_classes` in `wrangler.toml`); check Cloudflare's current pricing page for what your plan includes.

```sh
# build the shared protocol package once
cd protocol && npm ci && npm run build
cd ../relay && npm ci            # the Worker bundles relay/src/core, which needs relay's dependencies
cd cloudflare && npm ci
npx wrangler login
npx wrangler deploy
```

The Worker is then at `https://kubernanny-relay.<your-subdomain>.workers.dev`. For your own domain, uncomment `routes` in `wrangler.toml` and deploy again.

Point the agents at it:

```yaml
relay:
  enabled: true
  url: wss://kubernanny-relay.<your-subdomain>.workers.dev
```

## Settings

`[vars]` in `wrangler.toml` take the same `RELAY_*` variables as the Node relay (docs/RELAY.md, "Running your own"). `RELAY_MAX_AGENTS`, `RELAY_MAX_AGENTS_PER_IP`, `RELAY_MAX_PENDING_PER_IP` and `RELAY_MAX_PENDING_REGISTRATIONS` do not apply: every agent has its own object. There is no `/metrics`; use the Workers dashboard.

## Differences to the Node relay

- No periodic idle check: it would wake every object regularly. A connection whose last heartbeat is older than `RELAY_IDLE_TIMEOUT_MS` is closed when a call needs it.
- The per-agent token buckets (calls per minute, bytes per hour) are saved in the socket's attachment after every call, so they survive the object's hibernation and last exactly as long as the connection, as on the Node relay. No storage write is involved.
- Registration timeouts use a Durable Object alarm; a new connection never moves an earlier alarm later.
- Unproven connections are capped per agent id (4, the oldest goes), not per client address: everything aimed at one id lands in one object. `RELAY_MAX_INFLIGHT_BYTES` applies per object, since objects share no memory; Cloudflare's own limits bound the rest.

## Try it locally

```sh
npx wrangler dev --port 8787
# in relay/: a real demo agent connects to it and calls go through it
RELAY_E2E_URL=http://127.0.0.1:8787 npx vitest run test/external-relay.e2e.spec.ts
```

`npx wrangler deploy --dry-run --outdir dist` builds the bundle without deploying.
