# 0007: Native push, sealed for each device

**Status**: accepted

## Context

Kubernanny reaches people through channels they already run: ntfy, Discord, Slack, Gotify, a webhook ([NOTIFICATIONS.md](../NOTIFICATIONS.md)). Many self-hosters have none of these, and the ones that are public (ntfy.sh, Discord) read what they carry, which is why `detail: minimal` exists. Push straight to the Kubernanny app removes the extra service. On iOS and Android that means Apple's and Google's push services; nobody else can wake a phone. They must not learn what the cluster says, and an install that does not want push must be able to switch it off so it cannot be turned on again from a phone.

## Decisions

**1. Path: agent → relay → Firebase Cloud Messaging HTTP v1 → phone (APNs for iOS).** One provider for both platforms: FCM forwards to APNs, so the relay holds one credential (a Firebase service account) instead of an APNs key plus an FCM key. Sending to FCM needs that credential, which must not live in every cluster, so the relay sends, not the agent. An install without a relay, or with a relay without a service account, has no native push; ntfy and the webhooks are unaffected.

**2. The agent hands a push to the relay over its existing WebSocket, not over a new HTTPS route.** A new frame pair, `Push` (0x05, agent → relay) and `PushResult` (0x06), next to the call frames ([RELAY.md](../RELAY.md), "Native push"). The connection is already authenticated by the registration proof, so a push needs no second proof, the relay's per-agent limits key on the proven agent id for free, no public route is added that anyone could hammer, and the Cloudflare Worker's Durable Object for that agent, which holds the socket, sends it. The relay announces push in its `Ready` frame (`push: true`); the agent sends no `Push` frame otherwise. An HTTPS `POST` with a proof of possession was the alternative: it would need its own challenge round trip (or a replayable signature over a timestamp, and the agent has no signing key, [0005](0005-relay-protocol.md) decision 4), its own rate limiting by agent id, and on the Worker a second route to the same object.

**3. Content: HPKE (RFC 9180) mode_auth, DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305**, info `kubernanny-push/1`, `0x01 | enc | ciphertext` ([PROTOCOL.md](../PROTOCOL.md), "Push messages"). Considered: a one-way Noise `N` (or `K`), and a hand-made X25519 + ChaCha20-Poly1305 box. HPKE won because it is a standard that the code running *without* the app can implement from the platform's own primitives: CryptoKit on iOS (X25519, HMAC-SHA256, ChaChaPoly; CryptoKit's own HPKE needs iOS 17, the app supports 15, so the key schedule is written out), JCA plus Tink's X25519 on Android. Noise's BLAKE2b is in neither platform library. `mode_auth` with the agent's static key as sender key, which the phone pinned at pairing, means a push opens only if the agent made it: the relay, Google, and anyone who learns the push public key cannot forge one. The TypeScript implementation is checked both ways against `@hpke/core` and pinned by `protocol/test/push-vectors.json`; the Java copy runs against those vectors on any JDK (`npm test` in `app/native/push`); the Swift copy has the same test for macOS.

**4. A push key pair of its own per cluster, not the device key.** The iOS Notification Service Extension and the Android messaging service open pushes while the app is not running, so they need a key outside the app's own store. Sharing the device key would put the key that *is* the device (it can read logs, restart workloads) into a second process and, on iOS, a second keychain group. `@aparajita/capacitor-secure-storage` writes to the app's default keychain group with no access group option, so sharing it would have meant patching the plugin or moving every existing key. Instead the app makes a fresh X25519 pair for push when someone taps "Push to this device", keeps the secret half natively (iOS: a keychain item in the App Group `group.app.kubernanny.push`, used as keychain access group, `AfterFirstUnlockThisDeviceOnly`, because the extension runs while the phone is locked; Android: app-private preferences encrypted with an Android Keystore key) and registers the public half with the agent. Whoever extracts a push key can read pushes for that cluster and nothing else. A key derived from the device key was considered and rejected: it gives nothing a random key does not, and the derivation would need the device key at hand anyway.

**5. Registration is an ordinary sealed call, per device.** `POST /api/push/register {token, platform, key}` and `DELETE`, with the device the handshake proved as principal; a device registers and removes only itself. Token and key are stored with the device in `kubernanny-devices`, so revoking a device removes them, and `/api/devices` says only `push: true`. The token is the phone's address at FCM; it is never logged. FCM's `UNREGISTERED` makes the agent forget a token. The app asks for the notification permission only on that tap, never at start, and registers a new FCM token on start when FCM hands one out.

**6. The "app" channel uses the notifier's plan.** Same five-minute rule, escalation, resolution, silences, maintenance window, security alerts and weekly report as ntfy and the webhooks; the same title and body (so `detail: minimal` sends only counts, still sealed). One message per run, sealed once per device.

**7. iOS shows a generic alert unless the extension opens the message.** FCM delivers to iOS with an APNs alert (`Kubernanny` / "New status from a cluster", in the agent's `LANGUAGE`) and `mutable-content`; the extension replaces it with the opened text. If it cannot open it, the generic text stays and names nothing. Android gets data-only messages; the service shows only what opened, nothing otherwise.

**8. Off means off: `APP_PUSH=off` (Helm `notifications.appPush.enabled: false`).** The push routes answer `404 PUSH_OFF` before reading or writing anything, stored tokens are deleted on start, the relay connection is never offered as a push carrier (and refuses a push even if asked), and the app shows push as locked, with no button. **Default: on.** Nothing leaves the cluster until a device opts in, and it needs a relay first (off by default); the opt-in is a paired device, which can already read everything push would say. On the relay, push is off unless a service account is configured, and `RELAY_PUSH=off` keeps it off even then.

**9. The relay limits pushes per agent (60 an hour, bursts of 20, 4 waiting) and per FCM token (30 an hour, across every agent of a Node relay).** A token is not secret to the relay, and a paired device chooses the token it registers, so someone could register their own agent ids and aim them at a stranger's phone; the per-token limit bounds that. On the Worker the per-token limit lives in the agent's object, so it is per agent there.

**10. Notification state survives restarts.** The issues already pushed are kept in `kubernanny-settings` (key `notified`, at most 300 entries and 96 KiB, oldest dropped first), written through the same serialised writes as the settings and silences. A restart no longer sends "opened" again for an issue still open, and still sends "resolved" for one that healed while the agent was away. This was a roadmap item; it applies to every channel.

## Alternatives considered

| | Why not |
|---|---|
| APNs and FCM directly, two credentials | twice the secrets and code on the relay for no gain; FCM already forwards to APNs |
| The agent talks to FCM itself | every cluster would need the project's service account, which can push to every Kubernanny user |
| UnifiedPush / ntfy as the app's transport | no iOS story; ntfy already works as a channel today |
| Plaintext pushes with `detail: minimal` | Google and the relay would still see the cluster name and counts; sealing costs a few hundred lines |
| Sharing the device key with the extension | puts the key that acts as the device into a second process and keychain group (decision 4) |
| Noise N/K for the content | BLAKE2b is not in CryptoKit or JCA; HPKE uses only what both platforms ship |

## Consequences

- Google learns that a device gets Kubernanny pushes, when and how large; Apple the same for iOS. Neither learns a word of them. The relay additionally learns the FCM token and platform for each registered device of an agent. Rows in [SECURITY.md](../SECURITY.md) and [COMMUNICATION.md](../COMMUNICATION.md).
- Push needs the public relay (or one with your own Firebase project) and a build of the app with Firebase config files, which are not in the repository; builds without them run as before and hide the option ([RELEASING.md](../RELEASING.md)). A relay's service account and an app's config files must belong to the same Firebase project: a self-built app needs its own relay with push.
- The iOS project needs a Notification Service Extension target and the App Group `group.app.kubernanny.push`, added once by `app/scripts/add-push-extension.rb`.
- The native code (Swift, Java) cannot be built in CI on Linux; its decryption is the part that is tested against the shared vectors.
