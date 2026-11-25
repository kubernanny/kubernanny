import { isAgentId, relayOrigin } from '@kubernanny/protocol';

/**
 * Refusals by the relay itself, as plain JSON `{ "code": … }` like the
 * agent's own plain refusals. Codes are a client contract: add, never rename.
 */
export const RELAY_ERRORS = {
  RELAY_BAD_REQUEST: 400,
  RELAY_NOT_FOUND: 404,
  RELAY_TOO_LARGE: 413,
  RELAY_RATE_LIMITED: 429,
  /** The agent's answer is larger than the relay carries. */
  RELAY_RESPONSE_TOO_LARGE: 502,
  /** The agent answered with a status or body the relay does not pass on (only 200 or a plain E2E refusal). */
  RELAY_BAD_AGENT_RESPONSE: 502,
  /** The relay is holding as many answers in memory as it may; try again shortly. */
  RELAY_BUSY: 503,
  /** No agent with this id is connected (or it dropped during the call). */
  RELAY_AGENT_OFFLINE: 503,
  /** The relay has as many agents as it takes. */
  RELAY_FULL: 503,
  RELAY_TIMEOUT: 504,
} as const;

export type RelayErrorCode = keyof typeof RELAY_ERRORS;

export function relayError(code: RelayErrorCode): { status: number; body: string } {
  return { status: RELAY_ERRORS[code], body: JSON.stringify({ code }) };
}

/**
 * The path of a request target, or null. Only the origin form ("/path?query")
 * is accepted: an absolute form ("http://[") is refused here instead of
 * being handed to `new URL()`, which throws on it.
 */
export function pathOf(target: string | undefined): string | null {
  if (!target || !target.startsWith('/') || target.length > 2048) {
    return null;
  }
  const end = target.search(/[?#]/);
  return end === -1 ? target : target.slice(0, end);
}

/** Plain refusals the agent itself sends (docs/PROTOCOL.md); the only non-200 statuses the relay passes on. */
export const AGENT_PLAIN_STATUSES: readonly number[] = [400, 413, 429, 503];

/**
 * What the relay passes on from an agent: 200 with the sealed bytes, or one
 * of the agent's plain refusals rebuilt as `{"code":"E2E_…"}`. Anything else
 * (an odd status, HTML, a redirect) is null: the caller answers 502, so an
 * agent, or someone registered as one, cannot make the relay answer
 * whatever it likes.
 */
export function checkAgentReply(status: number, body: Uint8Array): { status: number; body: Uint8Array } | null {
  if (status === 200) {
    return { status, body };
  }
  if (!AGENT_PLAIN_STATUSES.includes(status) || body.length > 256) {
    return null;
  }
  let code: unknown;
  try {
    code = (JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)) as { code?: unknown } | null)?.code;
  } catch {
    return null;
  }
  if (typeof code !== 'string' || !/^E2E_[A-Z_]{1,40}$/.test(code)) {
    return null;
  }
  return { status, body: new TextEncoder().encode(JSON.stringify({ code })) };
}

export type Route = { kind: 'call'; agentId: string } | { kind: 'connect'; agentId: string } | { kind: 'health' };

/**
 * The relay's routes:
 *   POST /v1/agents/{agentId}/e2e   a sealed call, from the app
 *   GET  /v1/agents/{agentId}/ws    the agent's WebSocket
 *   GET  /healthz
 * Anything else, or an id that is not one, is null.
 */
export function parseRoute(pathname: string): Route | null {
  if (pathname === '/healthz') {
    return { kind: 'health' };
  }
  const match = /^\/v1\/agents\/([^/]+)\/(e2e|ws)$/.exec(pathname);
  if (!match || !isAgentId(match[1]!)) {
    return null;
  }
  return { kind: match[2] === 'e2e' ? 'call' : 'connect', agentId: match[1]! };
}

/**
 * CORS for the app's web build and WebViews. `*` is the default and safe:
 * calls carry no cookie or credential (the device proves itself inside the
 * sealed body), and every answer is ciphertext for one device.
 */
export function corsHeaders(origin: string | null | undefined, allowed: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
  };
  if (allowed.includes('*')) {
    headers['access-control-allow-origin'] = '*';
  } else if (origin && allowed.includes(origin)) {
    headers['access-control-allow-origin'] = origin;
    headers['vary'] = 'origin';
  }
  return headers;
}

/** The first characters of an id, for logs: enough to tell agents apart, not enough to address one. */
export function idPrefix(agentId: string): string {
  return agentId.slice(0, 8);
}

/** A WebSocket or HTTP message as bytes: a view, not a copy, where the input allows it. */
export function toBytes(data: ArrayBuffer | ArrayBufferView | readonly ArrayBufferView[]): Uint8Array {
  if (Array.isArray(data)) {
    const parts = data as readonly ArrayBufferView[];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(new Uint8Array(part.buffer, part.byteOffset, part.byteLength), offset);
      offset += part.byteLength;
    }
    return out;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  const view = data as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * The origin the relay checks registration proofs against (review L3). The
 * configured public URL (RELAY_PUBLIC_URL) always wins. Without one, the
 * request's Host header is used only for a loopback host (local runs and
 * tests): anywhere else the header is chosen by whoever connects, and a
 * hostile relay forwarding an agent's proof would simply send the Host it
 * needs. Null: refuse the connection.
 */
export function registrationOrigin(configured: string | null, host: string | undefined): string | null {
  if (configured) {
    return configured;
  }
  if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i.test(host)) {
    return null;
  }
  return relayOrigin(`http://${host}`);
}
