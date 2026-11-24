# 0004: Direct first, relay as fallback

**Status**: accepted, built (protocol details in [0005](0005-relay-protocol.md))

## Context

Most self-hosters reach their cluster only through a VPN or the LAN. Asking them to open an ingress to the internet for a status app is the wrong trade. But "only in the VPN" means no status on the go.

## Decision

The app tries the agent's address directly (VPN, LAN, ingress). If that fails and the agent has a relay configured, it sends the same sealed bytes through the relay, which the agent holds an outbound WebSocket to. The relay forwards ciphertext by agent id and sees nothing else: no paths, no answers, no device identities (Noise hides the initiator's key).

There is a public relay, free with fair use, run by the maintainer outside any cluster it serves. Anyone can run their own (container or Cloudflare Worker) or switch the relay off; the agent then has no outbound connection at all.

## Consequences

- No inbound port needed for access from anywhere; the agent dials out.
- The relay learns metadata: which agent, when, how many bytes, and the device's IP. Documented in [docs/RELAY.md](../RELAY.md).
- Measured cost of a Node relay: about 47 MB idle, 55 MB with 1 000 connected agents, 66 MB under traffic.
- A relay running inside the cluster it monitors would fail together with it; the docs say so.
