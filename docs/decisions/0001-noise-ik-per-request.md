# 0001: End-to-end encryption, one Noise IK handshake per API call

**Status**: accepted (0.3.0)

## Context

Until 0.2 the app sent a bearer token over TLS. That is only as good as the TLS path: TLS ends at the ingress, the hop to the pod is plain inside the cluster, and the coming relay (0004) must not be able to read anything. Kubernanny also has to work over plain HTTP in a LAN or VPN without an ingress, where there is no TLS at all. We wanted one mechanism that is secure on every path, so the path stops mattering.

## Decision

Every call is a complete `Noise_IK_25519_ChaChaPoly_BLAKE2b` handshake (docs/PROTOCOL.md). The device knows the agent's static key from the pairing link (IK: the initiator knows the responder's key in advance); the request travels in message 1, the answer in message 2 and transport frames.

## Options weighed

| Option | Why not |
|---|---|
| Keep the bearer token, rely on TLS | the token crosses every hop TLS does not cover; a relay or a TLS-terminating proxy sees it |
| mTLS with client certificates | ends at the ingress again; certificate handling on phones and in browsers is painful; nothing for the relay path |
| Long-lived Noise session over WebSocket | session state, reconnect logic, and the app is request/response anyway; a session per call costs ~1 ms of X25519 on a phone |
| Noise XX (no prior knowledge) | one more round trip, and the agent key would be learned in band (TOFU on every pairing); the link can carry the key, so IK is strictly better here |
| Signal / MLS / age | built for other problems (asynchronous messaging, groups, files) |
| WebCrypto only | X25519 in WebCrypto is not available on all WebViews Kubernanny targets; noble runs everywhere and is audited |

## Consequences

- Any transport works, plain HTTP included, once the key is pinned.
- No session state on the agent apart from a replay cache.
- Requests are not forward-secret against theft of the agent's static key (they depend on `es` and `ss`); answers are. Documented in PROTOCOL.md, "Limits".
- We maintain a small Noise implementation. Mitigated by keeping it to one pattern, test vectors, and an interop test against libsodium's implementation in CI.
