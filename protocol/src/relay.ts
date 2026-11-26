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
import { constantTimeEqual, randomBytes } from './bytes.js';
import { toBase64Url } from './keys.js';
import { KeyPair, concat } from './noise.js';
import { isPushToken } from './push.js';

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
  /** agent -> relay: the dead man's switch messages to hold (DeadmanDeposit as JSON), replacing any held before. Only when Ready said `deadman: true`. */
  Deposit: 0x07,
  /** relay -> agent: what became of that deposit (`{"s": DepositOutcome}`), same id. */
  DepositResult: 0x08,
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
/**
 * The relay protocol's version. 2 binds the registration proof to the
 * relay's origin (security review L3); nothing of version 1 was released.
 */
export const RELAY_PROTOCOL_VERSION = 2;
/** Domain separation for everything the registration proof derives. */
export const RELAY_LABEL = `kubernanny-relay/${RELAY_PROTOCOL_VERSION}`;
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
  /**
   * The relay delivers status pushes (`silent` Push frames) as silent
   * background messages, never as a visible alert. Absent or false: the
   * agent sends none, because a relay before them would show its generic
   * iOS alert for each one.
   */
  statusPush?: boolean;
  /**
   * The relay holds dead man's switch deposits (Deposit frames) and sends
   * them when this agent stays away longer than their grace. Absent or
   * false: the agent deposits nothing, and the app says the relay does not
   * support it.
   */
  deadman?: boolean;
  /**
   * Since the last registration the relay sent deposited messages: their key
   * ids (`k`) and how long the agent was away until this registration, in ms
   * (`m`). The agent then sends those devices a "reachable again" push.
   */
  deadmanFired?: { k: string[]; m: number };
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
  /**
   * A status push for the home-screen widget (wire `"q": 1`, docs/RELAY.md):
   * the relay sends it as a silent background message (Android data-only at
   * normal priority, iOS `apns-push-type: background` with
   * `content-available`), never with an alert, under a per-token budget of
   * its own. The sealed content says the same (`p: 0`), so the phone shows
   * nothing whatever the relay does.
   */
  silent?: boolean;
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
  return encodeFrame(FrameType.Push, id, encoder.encode(JSON.stringify({ t: push.token, o: push.platform, k: push.kid, m: push.message, ...(push.lang ? { l: push.lang } : {}), ...(push.silent ? { q: 1 } : {}) })));
}

/** The relay's side: the request, or null when it is not one (the relay then answers `invalid`). */
export function decodePushRequest(payload: Uint8Array): PushRequest | null {
  if (payload.length > MAX_PUSH_FRAME) {
    return null;
  }
  try {
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) as Record<string, unknown> | null;
    const { t, o, k, m, l, q } = raw ?? {};
    if (
      !isPushToken(t) ||
      (o !== 'ios' && o !== 'android') ||
      typeof k !== 'string' ||
      !/^[A-Za-z0-9_-]{16}$/.test(k) ||
      typeof m !== 'string' ||
      !/^[A-Za-z0-9_-]{66,4000}$/.test(m) ||
      (q !== undefined && q !== 1)
    ) {
      return null;
    }
    return { token: t, platform: o, kid: k, message: m, ...(l === 'de' || l === 'en' ? { lang: l } : {}), ...(q === 1 ? { silent: true } : {}) };
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

/**
 * One dead man's switch message as the agent deposits it with the relay: a
 * push like any other (token, platform, key id, sealed message, language of
 * the generic iOS alert), plus the grace in minutes this device chose.
 */
export interface DeadmanItem {
  token: string;
  platform: 'ios' | 'android';
  kid: string;
  message: string;
  lang?: 'en' | 'de';
  graceMinutes: number;
}

/**
 * Everything the relay holds for one agent (docs/RELAY.md, "Dead man's
 * switch"). Replaces what it held before; an empty list clears it.
 * `validitySeconds`: how long the relay may keep and send it, from when it
 * took it. `holdSeconds`: the relay sends nothing before this many seconds
 * after it took it (a maintenance window on the agent); 0 for none.
 */
export interface DeadmanDeposit {
  validitySeconds: number;
  holdSeconds: number;
  items: DeadmanItem[];
}

/** stored: held (or cleared, for an empty list). invalid: malformed or over this relay's limits. rate_limited, full: the previous deposit stays. disabled: no dead man's switch here. */
export type DepositOutcome = 'stored' | 'invalid' | 'rate_limited' | 'full' | 'disabled';
export const DEPOSIT_OUTCOMES: readonly DepositOutcome[] = ['stored', 'invalid', 'rate_limited', 'full', 'disabled'];
/** The largest Deposit frame payload either side accepts. Each relay has a smaller limit of its own (items, message size). */
export const MAX_DEPOSIT_FRAME = 128 * 1024;
/** The longest validity a deposit may ask for: DEADMAN_MAX_VALIDITY_MS in seconds. */
export const MAX_DEPOSIT_VALIDITY_SECONDS = 27 * 3600;
const GRACES = [10, 15, 30, 60];

export function encodeDeposit(id: number, deposit: DeadmanDeposit): Uint8Array {
  const items = deposit.items.map((i) => ({ t: i.token, o: i.platform, k: i.kid, m: i.message, ...(i.lang ? { l: i.lang } : {}), g: i.graceMinutes }));
  return encodeFrame(FrameType.Deposit, id, encoder.encode(JSON.stringify({ x: deposit.validitySeconds, h: deposit.holdSeconds, d: items })));
}

/** The relay's side: the deposit, or null when it is not one (the relay then answers `invalid`). */
export function decodeDeposit(payload: Uint8Array): DeadmanDeposit | null {
  if (payload.length > MAX_DEPOSIT_FRAME) {
    return null;
  }
  try {
    const raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload)) as Record<string, unknown> | null;
    const { x, h, d } = raw ?? {};
    const whole = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= max;
    if (!whole(x, MAX_DEPOSIT_VALIDITY_SECONDS) || x === 0 || !whole(h, MAX_DEPOSIT_VALIDITY_SECONDS) || h >= x || !Array.isArray(d)) {
      return null;
    }
    const items: DeadmanItem[] = [];
    for (const entry of d as unknown[]) {
      const { t, o, k, m, l, g } = (entry ?? {}) as Record<string, unknown>;
      if (
        !isPushToken(t) ||
        (o !== 'ios' && o !== 'android') ||
        typeof k !== 'string' ||
        !/^[A-Za-z0-9_-]{16}$/.test(k) ||
        typeof m !== 'string' ||
        !/^[A-Za-z0-9_-]{66,4000}$/.test(m) ||
        typeof g !== 'number' ||
        !GRACES.includes(g)
      ) {
        return null;
      }
      items.push({ token: t, platform: o, kid: k, message: m, ...(l === 'de' || l === 'en' ? { lang: l } : {}), graceMinutes: g });
    }
    return { validitySeconds: x, holdSeconds: h, items };
  } catch {
    return null;
  }
}

export function encodeDepositResult(id: number, outcome: DepositOutcome): Uint8Array {
  return encodeFrame(FrameType.DepositResult, id, encoder.encode(JSON.stringify({ s: outcome })));
}

/** The agent's side; anything it does not know reads as `invalid`. */
export function decodeDepositResult(payload: Uint8Array): DepositOutcome {
  try {
    const s = (JSON.parse(new TextDecoder().decode(payload)) as { s?: unknown } | null)?.s;
    return DEPOSIT_OUTCOMES.includes(s as DepositOutcome) ? (s as DepositOutcome) : 'invalid';
  } catch {
    return 'invalid';
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
 * The relay's origin as both sides put it into the proof: `http(s)://host[:port]`,
 * lowercase, default port left out, `ws`/`wss` read as `http`/`https`. The
 * agent uses the URL it dialled, the relay its configured public URL, so a
 * proof made for one relay does not register at another (security review L3:
 * a hostile relay could otherwise forward another relay's challenge to an
 * agent connected to it and register the agent's id there).
 */
export function relayOrigin(url: string): string {
  const parsed = new URL(url.trim());
  const scheme = { 'ws:': 'http:', 'wss:': 'https:', 'http:': 'http:', 'https:': 'https:' }[parsed.protocol];
  if (!scheme || !parsed.hostname) {
    throw new Error('a relay URL is http(s) or ws(s) with a host');
  }
  const port = parsed.port && !((scheme === 'http:' && parsed.port === '80') || (scheme === 'https:' && parsed.port === '443')) ? `:${parsed.port}` : '';
  return `${scheme}//${parsed.hostname.toLowerCase()}${port}`;
}

/**
 * The key the proof is made with. Hashed with a label, the relay's origin
 * (length-prefixed) and both public keys rather than using the raw DH output:
 * the relay picks the "ephemeral" key, and a hostile relay could pick a
 * device's Noise ephemeral key from a message 1 it carried. It would then
 * learn a labelled hash of that call's `es` value, which is useless for
 * opening it (that needs `es` itself).
 */
function proofKey(shared: Uint8Array, relayEphemeral: Uint8Array, agentPublic: Uint8Array, origin: string): Uint8Array {
  const originBytes = encoder.encode(relayOrigin(origin));
  if (originBytes.length > 0xffff) {
    throw new Error('relay origin too long');
  }
  return blake2b(concat(encoder.encode(RELAY_LABEL), Uint8Array.of(originBytes.length >> 8, originBytes.length & 0xff), originBytes, shared, relayEphemeral, agentPublic), { dkLen: 32 });
}

function proofMac(key: Uint8Array, nonce: Uint8Array): Uint8Array {
  return hmac(blake2b, key, concat(encoder.encode(RELAY_LABEL), nonce)).subarray(0, 32);
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

  /** True when the Proof payload comes from the holder of the private key whose public key hashes to `agentId`, made for this relay's `origin`. */
  verify(proof: Uint8Array, agentId: string, origin: string): boolean {
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
    let key: Uint8Array;
    try {
      key = proofKey(shared, this.ephemeral.publicKey, agentPublic, origin);
    } catch {
      return false; // a misconfigured origin never verifies
    }
    return constantTimeEqual(proofMac(key, this.nonce), proof.subarray(32));
  }
}

/** The agent's side: the Proof frame answering a Challenge payload from the relay at `origin` (the URL the agent dialled). */
export function answerChallenge(agent: KeyPair, challenge: Uint8Array, origin: string): Uint8Array {
  if (challenge.length !== 64) {
    throw new RelayFrameError('challenge must be 64 bytes');
  }
  const nonce = challenge.subarray(0, 32);
  const relayEphemeral = challenge.subarray(32);
  const shared = x25519.getSharedSecret(agent.secretKey, relayEphemeral);
  const mac = proofMac(proofKey(shared, relayEphemeral, agent.publicKey, origin), nonce);
  return encodeFrame(FrameType.Proof, 0, concat(agent.publicKey, mac));
}
