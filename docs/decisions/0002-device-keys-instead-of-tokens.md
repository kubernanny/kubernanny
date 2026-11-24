# 0002: Device key pairs instead of bearer tokens

**Status**: accepted (0.3.0), replaces the device tokens of 0.2

## Context

0.2 gave each device a random 256-bit token and stored its SHA-256. Better than one shared token, but a token is still a secret that crosses the network on every request and lives in the agent's Secret (as a hash) and the app (in clear).

## Decision

Each device creates an X25519 key pair per cluster at pairing. The private key never leaves the device; the agent stores only the public key and a name. The device proves the key in every handshake (Noise `ss` and `se`). The admin token (`kubernanny-token`, `PULSE_TOKEN`) is removed; admin access is `kubectl exec` into the pod (0003). The agent itself has one key pair, `kubernanny-identity`.

## Consequences

- Nothing secret crosses the network, ever. Reading `kubernanny-devices` gives only public keys.
- A stolen device is revoked by deleting its entry, effective on the next call.
- `PULSE_TOKEN` makes the agent refuse to start with a message, so an old values file is noticed instead of silently ignored.
- Upgrading from 0.2 means pairing every device again (the app cannot turn a token into a key pair without the user).
- One key pair per cluster, not per app install: clusters cannot correlate a device, and losing one cluster's key affects only that cluster.
- The private keys live in the iOS Keychain / Android Keystore ("this device only", no iCloud sync, no restore onto another device). On the web they sit in the browser's storage, protected by the origin and the CSP.
