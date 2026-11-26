import { PushContent, decodePushContent, fromBase64Url, keyPairFromSecret, openPush, parsePublicKey } from '@kubernanny/protocol';

/**
 * Opens one push as the native code does (iOS extension, Android service):
 * the reference those copies mirror, tested against the same vectors
 * (protocol/test/push-vectors.json). `message` is the FCM data field `m`.
 */
export function openPushMessage(pushSecret: string, agentKey: string, message: string): PushContent {
  return decodePushContent(openPush(keyPairFromSecret(fromBase64Url(pushSecret)), parsePublicKey(agentKey), fromBase64Url(message)));
}

/** A push sealed longer ago (or further ahead, by the agent's clock) than this is not shown. */
export const MAX_PUSH_AGE_MS = 60 * 60 * 1000;

/**
 * Whether an opened push may be shown (docs/PROTOCOL.md, "Push replay").
 * The sealed time `s` must lie within an hour of the phone's clock, and be
 * later than the last push shown for that key: whoever relays pushes
 * (the relay, Google) can record one and send it again, and without this a
 * recorded "all fine" could cover a later problem. The native copies keep
 * the last shown time per key id next to the key. Mirrored by
 * PushFreshness.java and PushKeys.isFresh (iOS extension); keep them identical.
 */
export function pushFresh(sealedAt: number, now: number, lastShown: number | null): boolean {
  if (!Number.isFinite(sealedAt) || Math.abs(now - sealedAt) > MAX_PUSH_AGE_MS) {
    return false;
  }
  return lastShown === null || sealedAt > lastShown;
}

/**
 * Whether a status push (`p: 0`, docs/PROTOCOL.md "Status pushes") may update
 * the widget: sealed within the hour. It is never shown, so it is not
 * compared with the last push shown and does not move it: a delayed alert
 * sealed before it still shows. A replayed one changes nothing, because the
 * widget only takes a check newer than its own. Mirrored by
 * PushFreshness.statusFresh and PushKeys.isStatusFresh.
 */
export function statusPushFresh(sealedAt: number, now: number): boolean {
  return pushFresh(sealedAt, now, null);
}
