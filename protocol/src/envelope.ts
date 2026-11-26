/**
 * How one API call travels between app and agent: a fresh Noise IK handshake
 * per request, carried in one HTTP POST and its response. See docs/PROTOCOL.md.
 *
 *   request body:  0x01 | message 1 (payload: the request as JSON)
 *   response body: 0x01 | u16 len | message 2 (payload: status and agent time)
 *                       | u16 len | frame | u16 len | frame ...
 *
 * A frame is a transport message whose plaintext is one flag byte (bit 0 set
 * on the last frame) and up to MAX_CHUNK bytes of the response body. The last
 * frame must carry the flag, so a cut-off response is detected; nonces count
 * up, so frames cannot be reordered or dropped.
 */
import { CipherState, concat, Initiator, KeyPair, MAX_MESSAGE, Responder, TAGLEN } from './noise.js';

export const VERSION = 1;
/** Mixed into every handshake, binding it to this protocol and version. */
export const PROLOGUE = new TextEncoder().encode('kubernanny-e2e/1');
/** Largest response body chunk per frame. */
export const MAX_CHUNK = MAX_MESSAGE - TAGLEN - 1;
/** Largest response body accepted by `openResponse` (the agent caps its own responses lower). */
export const MAX_RESPONSE_BODY = 32 * 1024 * 1024;
/** Largest request payload: what fits next to e, s and two tags in message 1. */
export const MAX_REQUEST_PAYLOAD = MAX_MESSAGE - 32 - 48 - TAGLEN;
/** Largest sealed request on the wire: the version byte and one Noise message. Every hop may refuse anything larger. */
export const MAX_SEALED_REQUEST = 1 + MAX_MESSAGE;
const LAST = 1;

export type Method = 'GET' | 'POST' | 'DELETE';
const METHODS: readonly Method[] = ['GET', 'POST', 'DELETE'];

/** The languages the agent answers in. */
export type Language = 'en' | 'de';
export const LANGUAGES: readonly Language[] = ['en', 'de'];

export interface InnerRequest {
  method: Method;
  /** Path below /api, with its query: "/history?hours=24". */
  path: string;
  /** JSON body of a POST. */
  body?: unknown;
  /** The sender's clock, ms since the epoch: the agent refuses requests outside its window. */
  time: number;
  /**
   * The app's UI language for the texts in the answer (issue titles, causes,
   * error messages). Optional: without it the agent answers in its own default.
   * A value the receiver does not know is dropped, not refused, so a newer app
   * with more languages still talks to an older agent.
   */
  language?: Language;
}

export interface InnerResponse {
  status: number;
  /** The agent's clock when it answered; lets the app correct its own. */
  time: number;
  /** The response body, usually JSON text. */
  body: Uint8Array;
}

export class ProtocolError extends Error {
  constructor(
    readonly code:
      'E2E_VERSION' | 'E2E_MALFORMED' | 'E2E_HANDSHAKE' | 'E2E_REQUEST' | 'E2E_TRUNCATED' | 'E2E_TOO_LARGE',
    message: string,
  ) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** A path the agent will route: below /api, no traversal, no fragment, printable ASCII. */
export function validPath(path: string): boolean {
  return (
    typeof path === 'string' &&
    path.length <= 2048 &&
    /^\/[A-Za-z0-9\-._~/%?=&:,+]*$/.test(path) &&
    !path.startsWith('//') &&
    !path
      .split('?')[0]!
      .split('/')
      .some((segment) => segment === '..' || segment === '.' || /%2e|%2f|%5c/i.test(segment))
  );
}

function encodeRequest(request: InnerRequest): Uint8Array {
  if (
    !METHODS.includes(request.method) ||
    !validPath(request.path) ||
    !Number.isFinite(request.time) ||
    (request.language !== undefined && !LANGUAGES.includes(request.language))
  ) {
    throw new ProtocolError('E2E_REQUEST', 'invalid request');
  }
  const wire: Record<string, unknown> = { m: request.method, p: request.path, t: Math.round(request.time) };
  if (request.body !== undefined) {
    wire['b'] = request.body;
  }
  if (request.language !== undefined) {
    wire['l'] = request.language;
  }
  const bytes = encoder.encode(JSON.stringify(wire));
  if (bytes.length > MAX_REQUEST_PAYLOAD) {
    throw new ProtocolError('E2E_TOO_LARGE', 'request too large');
  }
  return bytes;
}

function decodeRequest(bytes: Uint8Array): InnerRequest {
  let wire: unknown;
  try {
    wire = JSON.parse(decoder.decode(bytes));
  } catch {
    throw new ProtocolError('E2E_REQUEST', 'request is not JSON');
  }
  const w = wire as { m?: unknown; p?: unknown; t?: unknown; b?: unknown; l?: unknown };
  if (
    typeof wire !== 'object' ||
    wire === null ||
    !METHODS.includes(w.m as Method) ||
    typeof w.p !== 'string' ||
    !validPath(w.p) ||
    typeof w.t !== 'number' ||
    !Number.isFinite(w.t)
  ) {
    throw new ProtocolError('E2E_REQUEST', 'invalid request');
  }
  return {
    method: w.m as Method,
    path: w.p,
    time: w.t,
    ...(w.b !== undefined ? { body: w.b } : {}),
    ...(LANGUAGES.includes(w.l as Language) ? { language: w.l as Language } : {}),
  };
}

function u16(length: number): Uint8Array {
  return Uint8Array.of(length >> 8, length & 0xff);
}

/** Splits `0x01 | (u16 len | bytes)*` into its parts. */
function readFrames(body: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  let offset = 1;
  while (offset < body.length) {
    if (offset + 2 > body.length) {
      throw new ProtocolError('E2E_MALFORMED', 'cut-off length');
    }
    const length = (body[offset]! << 8) | body[offset + 1]!;
    offset += 2;
    if (length === 0 || offset + length > body.length) {
      throw new ProtocolError('E2E_MALFORMED', 'cut-off frame');
    }
    frames.push(body.subarray(offset, offset + length));
    offset += length;
  }
  return frames;
}

function checkVersion(body: Uint8Array): void {
  if (body.length === 0 || body[0] !== VERSION) {
    throw new ProtocolError('E2E_VERSION', 'unknown protocol version');
  }
}

export interface SealedRequest {
  /** The HTTP request body. */
  body: Uint8Array;
  /** Decrypts and authenticates the HTTP response body; throws on anything wrong. */
  open(responseBody: Uint8Array): InnerResponse;
}

/** App side: one request to the agent whose public key was pinned at pairing. */
export function sealRequest(
  device: KeyPair,
  agentPublicKey: Uint8Array,
  request: InnerRequest,
  ephemeral?: KeyPair,
): SealedRequest {
  const initiator = new Initiator(device, agentPublicKey, PROLOGUE, ephemeral);
  const message1 = initiator.writeMessage1(encodeRequest(request));
  let used = false;
  return {
    body: concat(Uint8Array.of(VERSION), message1),
    open(responseBody: Uint8Array): InnerResponse {
      if (used) {
        throw new ProtocolError('E2E_HANDSHAKE', 'response already opened');
      }
      used = true;
      checkVersion(responseBody);
      const [message2, ...frames] = readFrames(responseBody);
      if (!message2) {
        throw new ProtocolError('E2E_MALFORMED', 'no handshake message');
      }
      let head: { s?: unknown; t?: unknown };
      let receive: CipherState;
      try {
        const { payload, transport } = initiator.readMessage2(message2);
        receive = transport.receive;
        head = JSON.parse(decoder.decode(payload)) as { s?: unknown; t?: unknown };
      } catch {
        throw new ProtocolError('E2E_HANDSHAKE', 'response not from the pinned agent');
      }
      if (!Number.isInteger(head.s) || typeof head.t !== 'number') {
        throw new ProtocolError('E2E_MALFORMED', 'invalid response head');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      let last = false;
      for (const frame of frames) {
        if (last) {
          throw new ProtocolError('E2E_MALFORMED', 'data after the last frame');
        }
        let plain: Uint8Array;
        try {
          plain = receive.decryptWithAd(new Uint8Array(0), frame);
        } catch {
          throw new ProtocolError('E2E_HANDSHAKE', 'frame failed authentication');
        }
        if (plain.length === 0 || (plain[0]! & ~LAST) !== 0) {
          throw new ProtocolError('E2E_MALFORMED', 'invalid frame flags');
        }
        last = (plain[0]! & LAST) === LAST;
        size += plain.length - 1;
        if (size > MAX_RESPONSE_BODY) {
          throw new ProtocolError('E2E_TOO_LARGE', 'response too large');
        }
        chunks.push(plain.subarray(1));
      }
      if (!last) {
        throw new ProtocolError('E2E_TRUNCATED', 'response cut off');
      }
      return { status: head.s as number, time: head.t, body: concat(...chunks) };
    },
  };
}

export interface OpenedRequest {
  /** The device's static public key, authenticated by the handshake. */
  devicePublicKey: Uint8Array;
  /** The device's ephemeral key: unique per request, the replay cache's key. */
  ephemeral: Uint8Array;
  request: InnerRequest;
  /** Encrypts the answer to exactly this request; call once. */
  respond(status: number, body: Uint8Array, time: number): Uint8Array;
}

/** The ephemeral key of a request body, before any cryptography: lets the agent drop replays cheaply. */
export function peekEphemeral(body: Uint8Array): Uint8Array | null {
  return body.length >= 33 && body[0] === VERSION ? body.subarray(1, 33) : null;
}

/** Agent side: authenticates the sender and decrypts its request. */
export function openRequest(agent: KeyPair, body: Uint8Array, ephemeral?: KeyPair): OpenedRequest {
  checkVersion(body);
  const responder = new Responder(agent, PROLOGUE);
  let message: { initiatorStatic: Uint8Array; ephemeral: Uint8Array; payload: Uint8Array };
  try {
    message = responder.readMessage1(body.subarray(1));
  } catch {
    throw new ProtocolError('E2E_HANDSHAKE', 'handshake failed');
  }
  const request = decodeRequest(message.payload);
  let used = false;
  return {
    devicePublicKey: message.initiatorStatic,
    ephemeral: message.ephemeral,
    request,
    respond(status: number, responseBody: Uint8Array, time: number): Uint8Array {
      if (used) {
        throw new Error('respond() called twice');
      }
      used = true;
      const head = encoder.encode(JSON.stringify({ s: status, t: Math.round(time) }));
      const { message: message2, transport } = responder.writeMessage2(head, ephemeral);
      const parts: Uint8Array[] = [Uint8Array.of(VERSION), u16(message2.length), message2];
      let offset = 0;
      do {
        const chunk = responseBody.subarray(offset, offset + MAX_CHUNK);
        offset += chunk.length;
        const flags = offset >= responseBody.length ? LAST : 0;
        const frame = transport.send.encryptWithAd(new Uint8Array(0), concat(Uint8Array.of(flags), chunk));
        parts.push(u16(frame.length), frame);
      } while (offset < responseBody.length);
      return concat(...parts);
    },
  };
}
