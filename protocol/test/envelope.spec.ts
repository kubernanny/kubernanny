import { describe, expect, it } from 'vitest';

import {
  MAX_CHUNK,
  openRequest,
  peekEphemeral,
  PROLOGUE,
  ProtocolError,
  sealRequest,
  validPath,
  VERSION,
} from '../src/envelope.js';
import { fingerprint, fromBase64Url, parsePublicKey, toBase64Url } from '../src/keys.js';
import { concat, generateKeyPair, Initiator } from '../src/noise.js';

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

function roundTrip(body: Uint8Array, status = 200) {
  const device = generateKeyPair();
  const agent = generateKeyPair();
  const sealed = sealRequest(device, agent.publicKey, { method: 'GET', path: '/status', time: 1000 });
  const opened = openRequest(agent, sealed.body);
  return { device, agent, sealed, opened, response: opened.respond(status, body, 2000) };
}

describe('envelope', () => {
  it('carries a request and its answer', () => {
    const device = generateKeyPair();
    const agent = generateKeyPair();
    const sealed = sealRequest(device, agent.publicKey, {
      method: 'POST',
      path: '/actions/restart',
      body: { issue: 'x', index: 0 },
      time: 1234,
    });
    const opened = openRequest(agent, sealed.body);
    expect(opened.devicePublicKey).toEqual(device.publicKey);
    expect(opened.request).toEqual({
      method: 'POST',
      path: '/actions/restart',
      body: { issue: 'x', index: 0 },
      time: 1234,
    });
    const answer = sealed.open(opened.respond(201, json({ done: 'ok' }), 5678));
    expect(answer.status).toBe(201);
    expect(answer.time).toBe(5678);
    expect(JSON.parse(text(answer.body))).toEqual({ done: 'ok' });
  });

  it('carries the optional language and drops one it does not know', () => {
    const device = generateKeyPair();
    const agent = generateKeyPair();
    const sealed = sealRequest(device, agent.publicKey, { method: 'GET', path: '/status', time: 1, language: 'en' });
    expect(openRequest(agent, sealed.body).request).toEqual({
      method: 'GET',
      path: '/status',
      time: 1,
      language: 'en',
    });
    // A newer app may know more languages: the request still goes through, without one.
    const raw = (wire: unknown) =>
      concat(Uint8Array.of(VERSION), new Initiator(device, agent.publicKey, PROLOGUE).writeMessage1(json(wire)));
    expect(openRequest(agent, raw({ m: 'GET', p: '/status', t: 1, l: 'fr' })).request).toEqual({
      method: 'GET',
      path: '/status',
      time: 1,
    });
    expect(openRequest(agent, raw({ m: 'GET', p: '/status', t: 1, l: 7 })).request).toEqual({
      method: 'GET',
      path: '/status',
      time: 1,
    });
    expect(openRequest(agent, raw({ m: 'GET', p: '/status', t: 1, l: 'de' })).request.language).toBe('de');
    // The sending side only sends what it knows.
    expect(() =>
      sealRequest(device, agent.publicKey, { method: 'GET', path: '/status', time: 1, language: 'fr' as 'en' }),
    ).toThrow(ProtocolError);
  });

  it('splits large bodies into frames and joins them again', () => {
    const big = new Uint8Array(MAX_CHUNK * 3 + 17).map((_, i) => i % 251);
    const { sealed, response } = roundTrip(big);
    expect(sealed.open(response).body).toEqual(big);
  });

  it('handles an empty body and a body of exactly one chunk', () => {
    for (const size of [0, 1, MAX_CHUNK, MAX_CHUNK + 1]) {
      const body = new Uint8Array(size).fill(7);
      const { sealed, response } = roundTrip(body);
      expect(sealed.open(response).body).toEqual(body);
    }
  });

  it('detects a cut-off response', () => {
    const big = new Uint8Array(MAX_CHUNK * 2 + 5);
    const { sealed, response } = roundTrip(big);
    // Drop the last frame: everything before it is still well-formed.
    const withoutLast = response.subarray(0, response.length - (2 + 5 + 1 + 16));
    expect(() => sealed.open(withoutLast)).toThrow(expect.objectContaining({ code: 'E2E_TRUNCATED' }));
  });

  it('detects any flipped bit of the response', () => {
    const { response } = roundTrip(json({ ok: true }));
    for (let i = 1; i < response.length; i += 5) {
      const fresh = roundTrip(json({ ok: true }));
      const tampered = fresh.response.slice();
      tampered[i]! ^= 0x80;
      expect(() => fresh.sealed.open(tampered)).toThrow();
    }
  });

  it('refuses a response from another agent', () => {
    const device = generateKeyPair();
    const agent = generateKeyPair();
    const sealed = sealRequest(device, agent.publicKey, { method: 'GET', path: '/status', time: 0 });
    // An impostor cannot even read message 1 ...
    expect(() => openRequest(generateKeyPair(), sealed.body)).toThrow(ProtocolError);
    // ... and a response to a different request does not open this one.
    const other = sealRequest(device, agent.publicKey, { method: 'GET', path: '/status', time: 0 });
    const otherResponse = openRequest(agent, other.body).respond(200, json({}), 0);
    expect(() => sealed.open(otherResponse)).toThrow(ProtocolError);
  });

  it('opens a response only once', () => {
    const { sealed, response } = roundTrip(json({}));
    sealed.open(response);
    expect(() => sealed.open(response)).toThrow(ProtocolError);
  });

  it('refuses an unknown version', () => {
    const { sealed, agent } = roundTrip(json({}));
    const body = sealed.body.slice();
    body[0] = 2;
    expect(() => openRequest(agent, body)).toThrow(/version/);
  });

  it('exposes the ephemeral key for the replay cache', () => {
    const { sealed, opened } = roundTrip(json({}));
    expect(peekEphemeral(sealed.body)).toEqual(opened.ephemeral);
    expect(peekEphemeral(new Uint8Array(5))).toBeNull();
  });

  it('accepts only routable paths', () => {
    for (const ok of [
      '/status',
      '/history?hours=24',
      '/devices/0b6f5a4e-0d4e-4a37-9d73-2d5f6f1c1e0b',
      '/logs?issue=pods%2Fdefault&index=0',
    ]) {
      expect(validPath(ok)).toBe(true);
    }
    for (const bad of [
      'status',
      '//evil',
      '/../healthz',
      '/a/./b',
      '/%2e%2e/x',
      '/a%2fb',
      '/a b',
      '/x#y',
      '/a\\b',
      '/' + 'a'.repeat(2048),
    ]) {
      expect(validPath(bad)).toBe(false);
    }
    const agent = generateKeyPair();
    expect(() => sealRequest(generateKeyPair(), agent.publicKey, { method: 'GET', path: '/../x', time: 0 })).toThrow(
      ProtocolError,
    );
    expect(() =>
      sealRequest(generateKeyPair(), agent.publicKey, { method: 'PUT' as 'GET', path: '/x', time: 0 }),
    ).toThrow(ProtocolError);
  });
});

describe('keys', () => {
  it('round-trips base64url of every length', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
      const encoded = toBase64Url(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString('base64url'));
      expect(fromBase64Url(encoded)).toEqual(bytes);
    }
  });

  it('refuses malformed base64url and wrong key sizes', () => {
    expect(() => fromBase64Url('ab+c')).toThrow();
    expect(() => fromBase64Url('abcde')).toThrow();
    expect(() => fromBase64Url('AB')).toThrow(/canonical/);
    expect(() => parsePublicKey(toBase64Url(new Uint8Array(31)))).toThrow();
  });

  it('prints a stable fingerprint', () => {
    expect(fingerprint(new Uint8Array(32))).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect(fingerprint(new Uint8Array(32))).toBe(fingerprint(new Uint8Array(32)));
    expect(fingerprint(new Uint8Array(32))).not.toBe(fingerprint(new Uint8Array(32).fill(1)));
  });
});
