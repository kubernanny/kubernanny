import { PushContent, decodePushContent, fromBase64Url, keyPairFromSecret, openPush, parsePublicKey } from '@kubernanny/protocol';

/**
 * Opens one push as the native code does (iOS extension, Android service):
 * the reference those copies mirror, tested against the same vectors
 * (protocol/test/push-vectors.json). `message` is the FCM data field `m`.
 */
export function openPushMessage(pushSecret: string, agentKey: string, message: string): PushContent {
  return decodePushContent(openPush(keyPairFromSecret(fromBase64Url(pushSecret)), parsePublicKey(agentKey), fromBase64Url(message)));
}
