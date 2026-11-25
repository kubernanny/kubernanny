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
