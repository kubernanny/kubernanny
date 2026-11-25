/**
 * Native push, sealed for one device (docs/PROTOCOL.md, "Push messages";
 * decisions/0007-native-push.md).
 *
 * A push travels agent -> relay -> Firebase Cloud Messaging (-> APNs) ->
 * phone, and is read on the phone by code that runs without the app: the
 * iOS Notification Service Extension and the Android messaging service. So
 * the construction is one every platform has the primitives for, natively:
 *
 *   HPKE (RFC 9180), mode_auth, single shot,
 *   DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305
 *   info = "kubernanny-push/1", aad = empty
 *
 *   message = 0x01 | enc (32, the ephemeral public key) | ciphertext
 *
 * The recipient key is a push key pair of its own, made by the app for this
 * one purpose and cluster (never the device's static key, which stays with
 * the app). The sender key is the agent's static key, which the device pinned
 * at pairing: mode_auth means only the agent can produce a message that
 * opens, not the relay, not Google, not anyone who learns the push public key.
 *
 * Small on purpose, so that the Swift and Java copies (app/native/push) can
 * be read against it line by line; test/push-vectors.json pins the bytes and
 * the test suite checks this implementation against @hpke/core.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { extract, expand } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { toBase64Url } from './keys.js';
import { KeyPair, concat, generateKeyPair } from './noise.js';

export const PUSH_VERSION = 1;
/** HPKE `info`: binds every push to this protocol and version, apart from the Noise calls and the relay proof. */
export const PUSH_INFO = new TextEncoder().encode('kubernanny-push/1');
/**
 * Largest plaintext the agent seals. FCM and APNs both carry about 4 KiB;
 * sealed (+49 bytes) and in base64url (+1/3) this stays under 2.8 KiB, room
 * for the token, the key id and the generic iOS alert.
 */
export const MAX_PUSH_PLAINTEXT = 2048;
const ENC = 32;
const TAG = 16;
const MODE_AUTH = 0x02;

const encoder = new TextEncoder();
const i2osp2 = (n: number) => Uint8Array.of(n >> 8, n & 0xff);
const KEM_SUITE = concat(encoder.encode('KEM'), i2osp2(0x0020));
const HPKE_SUITE = concat(encoder.encode('HPKE'), i2osp2(0x0020), i2osp2(0x0001), i2osp2(0x0003));
const HPKE_V1 = encoder.encode('HPKE-v1');
const EMPTY = new Uint8Array(0);

function labeledExtract(suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array): Uint8Array {
  return extract(sha256, concat(HPKE_V1, suite, encoder.encode(label), ikm), salt);
}

function labeledExpand(suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, length: number): Uint8Array {
  return expand(sha256, prk, concat(i2osp2(length), HPKE_V1, suite, encoder.encode(label), info), length);
}

/** DHKEM's ExtractAndExpand: the KEM shared secret from both DH results and the kem_context. */
function kemSharedSecret(dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const prk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', dh);
  return labeledExpand(KEM_SUITE, prk, 'shared_secret', kemContext, 32);
}

/** KeySchedule for mode_auth without PSK: the AEAD key and nonce (sequence 0, single shot). */
function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const pskIdHash = labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info);
  const context = concat(Uint8Array.of(MODE_AUTH), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, sharedSecret, 'secret', EMPTY);
  return { key: labeledExpand(HPKE_SUITE, secret, 'key', context, 32), nonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', context, 12) };
}

/** noble refuses low-order points (an all-zero result), which ends the seal or open. */
const dh = (secret: Uint8Array, publicKey: Uint8Array) => x25519.getSharedSecret(secret, publicKey);

/**
 * Seals `plaintext` for the device's push key, as the agent (`sender`, its
 * static key pair). `ephemeral` is only ever passed by the test vectors.
 */
export function sealPush(sender: KeyPair, recipientPublic: Uint8Array, plaintext: Uint8Array, ephemeral: KeyPair = generateKeyPair()): Uint8Array {
  if (recipientPublic.length !== 32) {
    throw new Error('a push key is 32 bytes');
  }
  if (plaintext.length > MAX_PUSH_PLAINTEXT) {
    throw new Error(`push plaintext over ${MAX_PUSH_PLAINTEXT} bytes`);
  }
  const enc = ephemeral.publicKey;
  const shared = kemSharedSecret(concat(dh(ephemeral.secretKey, recipientPublic), dh(sender.secretKey, recipientPublic)), concat(enc, recipientPublic, sender.publicKey));
  const { key, nonce } = keySchedule(shared, PUSH_INFO);
  return concat(Uint8Array.of(PUSH_VERSION), enc, chacha20poly1305(key, nonce, EMPTY).encrypt(plaintext));
}

/** Opens a push on the device: its push key pair, and the agent key it pinned at pairing. Throws on anything that does not open. */
export function openPush(recipient: KeyPair, senderPublic: Uint8Array, message: Uint8Array): Uint8Array {
  if (message.length < 1 + ENC + TAG || message[0] !== PUSH_VERSION) {
    throw new Error('not a push message of this version');
  }
  const enc = message.subarray(1, 1 + ENC);
  const shared = kemSharedSecret(concat(dh(recipient.secretKey, enc), dh(recipient.secretKey, senderPublic)), concat(enc, recipient.publicKey, senderPublic));
  const { key, nonce } = keySchedule(shared, PUSH_INFO);
  return chacha20poly1305(key, nonce, EMPTY).decrypt(message.subarray(1 + ENC));
}

/**
 * What a push says, as JSON inside the sealed message. Short keys: the
 * whole thing has to fit MAX_PUSH_PLAINTEXT.
 */
export interface PushContent {
  /** Title, already in the agent's language. */
  t: string;
  /** Body. */
  b: string;
  /** Priority as in docs/NOTIFICATIONS.md: 5 critical, 4 security, 3 warnings, 2 resolved only. */
  p: number;
  /** The agent's clock when it sealed this, ms since the epoch. */
  s: number;
}

/** The content as bytes, the body shortened (on a character boundary) until it fits. */
export function encodePushContent(content: PushContent): Uint8Array {
  let body = content.b;
  for (;;) {
    const bytes = encoder.encode(JSON.stringify({ ...content, b: body }));
    if (bytes.length <= MAX_PUSH_PLAINTEXT) {
      return bytes;
    }
    const chars = Array.from(body);
    if (chars.length <= 1) {
      throw new Error('push title too long');
    }
    // Cut well past the overflow at once; JSON escaping makes bytes and characters differ.
    body = chars.slice(0, Math.max(0, chars.length - Math.max(16, Math.ceil((bytes.length - MAX_PUSH_PLAINTEXT) / 2)))).join('') + '…';
  }
}

export function decodePushContent(bytes: Uint8Array): PushContent {
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Partial<PushContent> | null;
  if (!value || typeof value.t !== 'string' || typeof value.b !== 'string' || typeof value.p !== 'number' || typeof value.s !== 'number') {
    throw new Error('not push content');
  }
  return { t: value.t, b: value.b, p: value.p, s: value.s };
}

/**
 * Which of the phone's push keys a message is for: 16 characters of the
 * BLAKE2b-256 of the push public key. Sent in clear next to the message, so
 * the phone picks the key (one per cluster) without trying each.
 */
export function pushKeyId(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error('a push key is 32 bytes');
  }
  return toBase64Url(blake2b(publicKey, { dkLen: 32 })).slice(0, 16);
}

/** An FCM registration token as the agent and the relay accept it: printable, no spaces, bounded. */
export function isPushToken(token: unknown): token is string {
  return typeof token === 'string' && /^[A-Za-z0-9:_\-.]{20,4096}$/.test(token);
}

export type PushPlatform = 'ios' | 'android';
export const PUSH_PLATFORMS: readonly PushPlatform[] = ['ios', 'android'];
