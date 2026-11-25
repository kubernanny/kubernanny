/**
 * The relay's wire format (docs/RELAY.md, decisions/0005-relay-protocol.md).
 *
 * The relay never sees a Noise key or a plaintext: it carries the sealed
 * bodies of docs/PROTOCOL.md between an HTTP client and the WebSocket an
 * agent holds open to it. Everything here is about that carrying:
 *
 *   agent id   base64url(BLAKE2b-256(agent static public key)), 43 characters
 *   frame      u8 type | u32 call id (big-endian) | payload      (binary WebSocket message)
 *   heartbeat  the text messages "ping" -> "pong"
 *
 * and about proving, at registration, that the agent holds the private key
 * behind the id it registers (so nobody can take another agent's place).
 */
import { x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { hmac } from '@noble/hashes/hmac.js';
import { toBase64Url } from './keys.js';
import { KeyPair, concat } from './noise.js';

export const FrameType = {
  /** relay -> agent: one sealed request body (`0x01 | message 1`). */
  Call: 0x01,
  /** agent -> relay: part of a response body, more follows. */
  ReplyChunk: 0x02,
  /** agent -> relay: `u16 status | last part`. Status 200 carries a sealed body, anything else the agent's plain JSON refusal. */
  ReplyEnd: 0x03,
  /** relay -> agent: nobody waits for this call any more (timeout); the agent may drop its answer. */
  Cancel: 0x04,
  /** agent -> relay: one native push to deliver (PushRequest as JSON); the id is the agent's own. Only when Ready said `push: true`. */
  Push: 0x05,
  /** relay -> agent: what became of that push (`{"s": PushOutcome}`), same id. */
  PushResult: 0x06,
  /** relay -> agent, call id 0: `nonce (32) | relay ephemeral public key (32)`. */
  Challenge: 0x10,
  /** agent -> relay, call id 0: `agent static public key (32) | proof (32)`. */
  Proof: 0x11,
  /** relay -> agent, call id 0: registered; payload is the relay's limits as JSON (RelayLimitsInfo). */
  Ready: 0x12,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

/** WebSocket close codes the relay uses (4000-4999 is the application range). */
export const RelayClose = {
  /** A frame that does not parse, or one out of order. */
  Protocol: 4000,
  /** The registration proof did not verify, or the key does not hash to the id. */
  ProofFailed: 4001,
  /** No proof within the registration timeout. */
  RegistrationTimeout: 4002,
  /** Another connection registered the same agent id since. Newest wins: a restarted agent must not wait for its old socket to time out. */
  Replaced: 4003,
  /** Nothing heard (not even a ping) within the idle timeout. */
  Idle: 4008,
  /** The relay has as many agents as it takes. */
  Full: 4029,
} as const;

export const HEARTBEAT_PING = 'ping';
export const HEARTBEAT_PONG = 'pong';
/** Domain separation for everything the registration proof derives. */
export const RELAY_LABEL = 'kubernanny-relay/1';
/** Response parts the agent sends: small enough for every WebSocket implementation's message limit. */
export const REPLY_CHUNK = 256 * 1024;
const HEADER = 5;
const MAX_CALL_ID = 0xffffffff;
const encoder = new TextEncoder();

export interface Frame {
  type: number;
  callId: number;
  payload: Uint8Array;
}

/** What the relay tells a freshly registered agent (Ready frame). */
export interface RelayLimitsInfo {
  maxRequestBytes: number;
  maxResponseBytes: number;
  maxConcurrent: number;
  callTimeoutMs: number;
  /** The relay delivers native push (Push frames); absent or false: it does not, and the agent sends none. */
  push?: boolean;
}

/**
 * One push for the relay to hand to Firebase Cloud Messaging. The relay sees
 * the device's FCM token, its platform, the key id and the size of the
 * sealed message; never what it says (protocol/src/push.ts).
 */
export interface PushRequest {
  /** FCM registration token. */
  token: string;
  platform: 'ios' | 'android';
  /** pushKeyId() of the device's push key. */
  kid: string;
  /** sealPush() output, base64url. */
  message: string;
  /** Language of the generic iOS alert shown when the phone cannot open the message (the agent's LANGUAGE). */
  lang?: 'en' | 'de';
}

/**
 * sent: FCM took it. unregistered: FCM says the token is gone (the agent forgets it).
 * rate_limited, unavailable: try a later message. invalid: the request was malformed.
 * failed: anything else. disabled: this relay has no push.
 */
export type PushOutcome = 'sent' | 'unregistered' | 'rate_limited' | 'unavailable' | 'invalid' | 'failed' | 'disabled';
export const PUSH_OUTCOMES: readonly PushOutcome[] = ['sent', 'unregistered', 'rate_limited', 'unavailable', 'invalid', 'failed', 'disabled'];
/** The largest Push frame payload either side accepts: a token, a sealed MAX_PUSH_PLAINTEXT in base64url and the JSON around it. */
export const MAX_PUSH_FRAME = 8 * 1024;

export function encodePushRequest(id: number, push: PushRequest): Uint8Array {
  return encodeFrame(FrameType.Push, id, encoder.encode(JSON.stringify({ t: push.token, o: push.platform, k: push.kid, m: push.message, ...(push.lang ? { l: push.lang } : {}) })));
}

/** The relay's side: the request, or null when it is not one (the relay then answers `invalid`). */
export function decodePushRequest(payload: Uint8Array): PushRequest | null {
  if (payload.length > MAX_PUSH_FRAME) {
    return null;
  }
  try {
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) as Record<string, unknown> | null;
    const { t, o, k, m, l } = raw ?? {};
    if (
      typeof t !== 'string' ||
      !/^[A-Za-z0-9:_\-.]{20,4096}$/.test(t) ||
      (o !== 'ios' && o !== 'android') ||
      typeof k !== 'string' ||
      !/^[A-Za-z0-9_-]{16}$/.test(k) ||
      typeof m !== 'string' ||
      !/^[A-Za-z0-9_-]{66,4000}$/.test(m)
    ) {
      return null;
    }
    return { token: t, platform: o, kid: k, message: m, ...(l === 'de' || l === 'en' ? { lang: l } : {}) };
  } catch {
    return null;
  }
}

export function encodePushResult(id: number, outcome: PushOutcome): Uint8Array {
  return encodeFrame(FrameType.PushResult, id, encoder.encode(JSON.stringify({ s: outcome })));
}

/** The agent's side; anything it does not know reads as `failed`. */
export function decodePushResult(payload: Uint8Array): PushOutcome {
  try {
    const s = (JSON.parse(new TextDecoder().decode(payload)) as { s?: unknown } | null)?.s;
    return PUSH_OUTCOMES.includes(s as PushOutcome) ? (s as PushOutcome) : 'failed';
  } catch {
    return 'failed';
  }
}

export class RelayFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayFrameError';
  }
}

/**
 * The id an agent registers under and the app addresses it by. Derived from
 * the public key the app pinned at pairing, so the app needs nothing else;
 * it reveals nothing the key does not (a hash cannot be turned back into it).
 */
export function relayAgentId(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error('a public key is 32 bytes');
  }
  return toBase64Url(blake2b(publicKey, { dkLen: 32 }));
}

/** 32 bytes in base64url without padding: what relayAgentId() produces. */
export function isAgentId(text: string): boolean {
  return typeof text === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(text);
}

export function encodeFrame(type: FrameType, callId: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  if (!Number.isInteger(callId) || callId < 0 || callId > MAX_CALL_ID) {
    throw new RelayFrameError('call id out of range');
  }
  const out = new Uint8Array(HEADER + payload.length);
  out[0] = type;
  new DataView(out.buffer).setUint32(1, callId, false);
  out.set(payload, HEADER);
  return out;
}

/** Parses a binary WebSocket message. The payload is a view into `bytes`, not a copy. */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < HEADER) {
    throw new RelayFrameError('frame shorter than its header');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { type: bytes[0]!, callId: view.getUint32(1, false), payload: bytes.subarray(HEADER) };
}

export function encodeReplyEnd(callId: number, status: number, last: Uint8Array): Uint8Array {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RelayFrameError('status out of range');
  }
  return encodeFrame(FrameType.ReplyEnd, callId, concat(Uint8Array.of(status >> 8, status & 0xff), last));
}

export function decodeReplyEnd(payload: Uint8Array): { status: number; last: Uint8Array } {
  if (payload.length < 2) {
    throw new RelayFrameError('reply without a status');
  }
  const status = (payload[0]! << 8) | payload[1]!;
  if (status < 100 || status > 599) {
    throw new RelayFrameError('status out of range');
  }
  return { status, last: payload.subarray(2) };
}

/** A response body as the frames that carry it: chunks, then the end frame with the status. */
export function encodeReply(callId: number, status: number, body: Uint8Array, chunk = REPLY_CHUNK): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let offset = 0;
  while (body.length - offset > chunk) {
    frames.push(encodeFrame(FrameType.ReplyChunk, callId, body.subarray(offset, offset + chunk)));
    offset += chunk;
  }
  frames.push(encodeReplyEnd(callId, status, body.subarray(offset)));
  return frames;
}

/**
 * The key the proof is made with. Hashed with a label and both public keys
 * rather than using the raw DH output: the relay picks the "ephemeral" key,
 * and a hostile relay could pick a device's Noise ephemeral key from a
 * message 1 it carried. It would then learn a labelled hash of that call's
 * `es` value, which is useless for opening it (that needs `es` itself).
 */
function proofKey(shared: Uint8Array, relayEphemeral: Uint8Array, agentPublic: Uint8Array): Uint8Array {
  return blake2b(concat(encoder.encode(RELAY_LABEL), shared, relayEphemeral, agentPublic), { dkLen: 32 });
}

function proofMac(key: Uint8Array, nonce: Uint8Array): Uint8Array {
  return hmac(blake2b, key, concat(encoder.encode(RELAY_LABEL), nonce)).subarray(0, 32);
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

/**
 * The relay's side of one registration. A fresh nonce and ephemeral key per
 * connection, and it verifies once: a proof recorded from another
 * connection, or replayed on this one, does not pass.
 */
export class RegistrationChallenge {
  private readonly nonce: Uint8Array;
  private readonly ephemeral: KeyPair;
  private used = false;

  constructor(nonce: Uint8Array = randomBytes(32), ephemeralSecret: Uint8Array = x25519.utils.randomSecretKey()) {
    if (nonce.length !== 32) {
      throw new Error('the nonce is 32 bytes');
    }
    this.nonce = nonce.slice();
    this.ephemeral = { secretKey: ephemeralSecret, publicKey: x25519.getPublicKey(ephemeralSecret) };
  }

  /** The Challenge frame to send. */
  frame(): Uint8Array {
    return encodeFrame(FrameType.Challenge, 0, concat(this.nonce, this.ephemeral.publicKey));
  }

  /** True when the Proof payload comes from the holder of the private key whose public key hashes to `agentId`. */
  verify(proof: Uint8Array, agentId: string): boolean {
    if (this.used || proof.length !== 64) {
      return false;
    }
    this.used = true;
    const agentPublic = proof.subarray(0, 32);
    if (relayAgentId(agentPublic) !== agentId) {
      return false;
    }
    let shared: Uint8Array;
    try {
      shared = x25519.getSharedSecret(this.ephemeral.secretKey, agentPublic);
    } catch {
      return false; // a low-order point
    }
    return constantTimeEqual(proofMac(proofKey(shared, this.ephemeral.publicKey, agentPublic), this.nonce), proof.subarray(32));
  }
}

/** The agent's side: the Proof frame answering a Challenge payload. */
export function answerChallenge(agent: KeyPair, challenge: Uint8Array): Uint8Array {
  if (challenge.length !== 64) {
    throw new RelayFrameError('challenge must be 64 bytes');
  }
  const nonce = challenge.subarray(0, 32);
  const relayEphemeral = challenge.subarray(32);
  const shared = x25519.getSharedSecret(agent.secretKey, relayEphemeral);
  const mac = proofMac(proofKey(shared, relayEphemeral, agent.publicKey), nonce);
  return encodeFrame(FrameType.Proof, 0, concat(agent.publicKey, mac));
}
