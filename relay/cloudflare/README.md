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

The Worker is then at `https://kubernanny-relay.<your-subdomain>.workers.dev`. For your own domain, uncomment `routes` in `wrangler.toml` and deploy again. Setting `RELAY_PUBLIC_URL` to the URL agents dial is optional here (without it the proof is checked against the host Cloudflare routed the connect by), but it pins it to one name.

Add a Cloudflare rate limiting rule for the relay's host (Security, WAF, rate limiting rules in the dashboard): for example at most 30 requests per minute per IP on paths matching `/v1/agents/*/ws`, and a looser one on `/v1/agents/*/e2e`. The Worker has no per-address limits of its own, and every connect wakes an object. Check Cloudflare's documentation for what your plan includes.

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
- The per-agent token buckets (calls per minute, bytes per hour) are saved in the socket's attachment after every call, so they survive the object's hibernation and last exactly as long as the connection, as on the Node relay. No storage write is involved. The calling address' share of them (`CF-Connecting-IP`) lives in memory and starts over after a hibernation.
- The push allowance of an agent id is also written to the object's storage after each push (one row), so a reconnect does not start it full. The per-token push limit lives in a second Durable Object class, `TokenLimiter`, one per token digest (binding `TOKENS`): one request and one storage write per push. There is no per-address or relay-wide push budget.
- Registration timeouts are an in-memory timer, so a connection that never proves a key costs no storage write; an object that hibernated with one closes it at the next connect, and refuses a late proof.
- Unproven connections are capped per agent id (4, the oldest goes), not per client address: everything aimed at one id lands in one object. `RELAY_MAX_INFLIGHT_BYTES` applies per object, since objects share no memory; Cloudflare's own limits bound the rest. A Workers WebSocket does not report unread bytes, so `RELAY_MAX_SOCKET_BUFFER_BYTES` does not apply.
- A request body is read through a counting reader that stops past `RELAY_MAX_REQUEST_BYTES`, and only once an agent is connected.

## Try it locally

```sh
npx wrangler dev --port 8787
# in relay/: a real demo agent connects to it and calls go through it
RELAY_E2E_URL=http://127.0.0.1:8787 npx vitest run test/external-relay.e2e.spec.ts
```

`npx wrangler deploy --dry-run --outdir dist` builds the bundle without deploying.

## The public relay (relay.kubernanny.app)

The chart's default `relay.url` is run by the project: the Relay workflow (`.github/workflows/relay.yml`) deploys this Worker on every push to `main` that touches the relay or the protocol, with the custom domain `relay.kubernanny.app` and `RELAY_PUBLIC_URL` pinned to it. The repository's `CLOUDFLARE_API_TOKEN` needs Account → Workers Scripts: Edit and, on the zone `kubernanny.app`, Workers Routes: Edit and DNS: Edit. The rate limiting rule for `/v1/agents/*/ws` lives with the zone in the maintainer's infrastructure.
