/**
 * Noise_IK_25519_ChaChaPoly_BLAKE2b, revision 34 of the Noise specification
 * (https://noiseprotocol.org/noise.html), and nothing else: one pattern, one
 * cipher suite, no PSK, no rekey. Small on purpose, so it can be read in one
 * sitting and checked against the specification line by line.
 *
 *   IK:
 *     <- s
 *     ...
 *     -> e, es, s, ss
 *     <- e, ee, se
 *
 * The primitives come from the audited @noble libraries. The test suite runs
 * this implementation against an independent one built on libsodium
 * (`noise-protocol`) in both roles.
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { hmac } from '@noble/hashes/hmac.js';

export const PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_BLAKE2b';
export const DHLEN = 32;
export const HASHLEN = 64;
export const TAGLEN = 16;
/** Largest Noise message (section 3). */
export const MAX_MESSAGE = 65535;

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

const encoder = new TextEncoder();
const EMPTY = new Uint8Array(0);

export function generateKeyPair(): KeyPair {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function keyPairFromSecret(secretKey: Uint8Array): KeyPair {
  if (secretKey.length !== DHLEN) {
    throw new Error('secret key must be 32 bytes');
  }
  return { secretKey: secretKey.slice(), publicKey: x25519.getPublicKey(secretKey) };
}

/** DH(); noble refuses low-order points (an all-zero result), which aborts the handshake. */
function dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(secretKey, publicKey);
}

function hash(...parts: Uint8Array[]): Uint8Array {
  const h = blake2b.create({ dkLen: HASHLEN });
  for (const part of parts) {
    h.update(part);
  }
  return h.digest();
}

/** HKDF() of section 4.3 with HMAC-BLAKE2b, two outputs. */
function hkdf(chainingKey: Uint8Array, inputKeyMaterial: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(blake2b, chainingKey, inputKeyMaterial);
  const output1 = hmac(blake2b, tempKey, Uint8Array.of(1));
  const output2 = hmac(blake2b, tempKey, concat(output1, Uint8Array.of(2)));
  return [output1, output2];
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 96-bit nonce: 32 zero bits, then n as 64-bit little-endian (section 12.3). */
function nonce(n: number): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, BigInt(n), true);
  return out;
}

/** CipherState (section 5.1). Messages per request are few, so n never nears 2^64-1. */
export class CipherState {
  private n = 0;

  constructor(private k: Uint8Array | null = null) {}

  hasKey(): boolean {
    return this.k !== null;
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (!this.k) {
      return plaintext;
    }
    const out = chacha20poly1305(this.k, nonce(this.n), ad).encrypt(plaintext);
    this.n++;
    return out;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (!this.k) {
      return ciphertext;
    }
    // Throws on a bad tag; n is only advanced on success (section 5.1).
    const out = chacha20poly1305(this.k, nonce(this.n), ad).decrypt(ciphertext);
    this.n++;
    return out;
  }
}

/** SymmetricState (section 5.2). */
class SymmetricState {
  private ck: Uint8Array;
  h: Uint8Array;
  private cipher = new CipherState();

  constructor() {
    const name = encoder.encode(PROTOCOL_NAME);
    this.h = new Uint8Array(HASHLEN);
    this.h.set(name); // shorter than HASHLEN: padded with zeros
    this.ck = this.h.slice();
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, tempK] = hkdf(this.ck, inputKeyMaterial);
    this.ck = ck;
    this.cipher = new CipherState(tempK.slice(0, 32));
  }

  mixHash(data: Uint8Array): void {
    this.h = hash(this.h, data);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf(this.ck, EMPTY);
    return [new CipherState(k1.slice(0, 32)), new CipherState(k2.slice(0, 32))];
  }
}

export interface Transport {
  /** Encrypts what this side sends. */
  send: CipherState;
  /** Decrypts what this side receives. */
  receive: CipherState;
  /** The handshake hash, unique per handshake (section 11.2). */
  handshakeHash: Uint8Array;
}

function initialize(prologue: Uint8Array, responderStatic: Uint8Array): SymmetricState {
  const state = new SymmetricState();
  state.mixHash(prologue);
  state.mixHash(responderStatic); // pre-message "<- s"
  return state;
}

function checkKey(key: Uint8Array, what: string): void {
  if (!(key instanceof Uint8Array) || key.length !== DHLEN) {
    throw new Error(`${what} must be 32 bytes`);
  }
}

/**
 * The initiator: the app. Knows the agent's static key from the pairing.
 * `ephemeral` is only ever passed by the test vectors.
 */
export class Initiator {
  private readonly state: SymmetricState;
  private readonly e: KeyPair;

  constructor(
    private readonly s: KeyPair,
    private readonly rs: Uint8Array,
    prologue: Uint8Array,
    ephemeral?: KeyPair,
  ) {
    checkKey(rs, 'responder static key');
    this.state = initialize(prologue, rs);
    this.e = ephemeral ?? generateKeyPair();
  }

  /** -> e, es, s, ss, then the payload. */
  writeMessage1(payload: Uint8Array): Uint8Array {
    const st = this.state;
    st.mixHash(this.e.publicKey);
    st.mixKey(dh(this.e.secretKey, this.rs));
    const encryptedStatic = st.encryptAndHash(this.s.publicKey);
    st.mixKey(dh(this.s.secretKey, this.rs));
    const encryptedPayload = st.encryptAndHash(payload);
    return checkLength(concat(this.e.publicKey, encryptedStatic, encryptedPayload));
  }

  /** <- e, ee, se, then the payload; returns it with the transport keys. */
  readMessage2(message: Uint8Array): { payload: Uint8Array; transport: Transport } {
    if (message.length < DHLEN + TAGLEN || message.length > MAX_MESSAGE) {
      throw new Error('message 2 has a wrong length');
    }
    const st = this.state;
    const re = message.subarray(0, DHLEN);
    st.mixHash(re);
    st.mixKey(dh(this.e.secretKey, re));
    st.mixKey(dh(this.s.secretKey, re));
    const payload = st.decryptAndHash(message.subarray(DHLEN));
    const [initiatorToResponder, responderToInitiator] = st.split();
    return { payload, transport: { send: initiatorToResponder, receive: responderToInitiator, handshakeHash: st.h } };
  }
}

/** The responder: the agent. Learns the initiator's static key from message 1. */
export class Responder {
  private readonly state: SymmetricState;
  private re: Uint8Array | null = null;
  private rs: Uint8Array | null = null;

  constructor(
    private readonly s: KeyPair,
    prologue: Uint8Array,
  ) {
    this.state = initialize(prologue, s.publicKey);
  }

  /** <- e, es, s, ss: returns the initiator's static key and the payload. */
  readMessage1(message: Uint8Array): { initiatorStatic: Uint8Array; ephemeral: Uint8Array; payload: Uint8Array } {
    if (message.length < DHLEN + DHLEN + TAGLEN + TAGLEN || message.length > MAX_MESSAGE) {
      throw new Error('message 1 has a wrong length');
    }
    const st = this.state;
    const re = message.slice(0, DHLEN);
    st.mixHash(re);
    st.mixKey(dh(this.s.secretKey, re));
    const rs = st.decryptAndHash(message.subarray(DHLEN, DHLEN + DHLEN + TAGLEN));
    st.mixKey(dh(this.s.secretKey, rs));
    const payload = st.decryptAndHash(message.subarray(DHLEN + DHLEN + TAGLEN));
    this.re = re;
    this.rs = rs;
    return { initiatorStatic: rs, ephemeral: re, payload };
  }

  /** -> e, ee, se, then the payload; returns the message with the transport keys. */
  writeMessage2(payload: Uint8Array, ephemeral?: KeyPair): { message: Uint8Array; transport: Transport } {
    if (!this.re || !this.rs) {
      throw new Error('message 1 has not been read');
    }
    const st = this.state;
    const e = ephemeral ?? generateKeyPair();
    st.mixHash(e.publicKey);
    st.mixKey(dh(e.secretKey, this.re));
    st.mixKey(dh(e.secretKey, this.rs));
    const encryptedPayload = st.encryptAndHash(payload);
    const [initiatorToResponder, responderToInitiator] = st.split();
    return {
      message: checkLength(concat(e.publicKey, encryptedPayload)),
      transport: { send: responderToInitiator, receive: initiatorToResponder, handshakeHash: st.h },
    };
  }
}

function checkLength(message: Uint8Array): Uint8Array {
  if (message.length > MAX_MESSAGE) {
    throw new Error('Noise message longer than 65535 bytes');
  }
  return message;
}
