# Decisions

Short records of choices that shape Kubernanny, with what was weighed. A decision is replaced by a new record, never edited into something else.

| # | Decision | Status |
|---|---|---|
| [0001](0001-noise-ik-per-request.md) | End-to-end encryption: one Noise IK handshake per API call | accepted |
| [0002](0002-device-keys-instead-of-tokens.md) | Device key pairs instead of bearer tokens | accepted |
| [0003](0003-internal-socket.md) | Decrypted calls reach the routes through a Unix socket | accepted |
| [0004](0004-direct-and-relay.md) | Direct first, relay as fallback; the relay is optional and self-hostable | accepted |
| [0005](0005-relay-protocol.md) | The relay protocol: opaque sealed bodies, agent id from the key, proof of possession, Nest with plain `ws` | accepted |
| [0006](0006-agent-languages.md) | The agent speaks the app's language: texts as keys, rendered per request | accepted |
| [0007](0007-native-push.md) | Native push through the relay and FCM, sealed per device with HPKE; off for good with `APP_PUSH=off` | accepted |
