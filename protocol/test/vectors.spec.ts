import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openRequest, sealRequest } from '../src/envelope.js';
import { keyPairFromSecret } from '../src/noise.js';

/**
 * Fixed inputs, fixed bytes on the wire: test/vectors.json, also printed in
 * docs/PROTOCOL.md. Another implementation reproduces these exactly.
 * Regenerate (only after a deliberate protocol change) with
 * UPDATE_VECTORS=1 npx vitest run test/vectors.spec.ts
 */
const file = new URL('./vectors.json', import.meta.url);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'hex'));
const fill = (start: number) => new Uint8Array(32).map((_, i) => (start + i) & 0xff);

interface Vector {
  name: string;
  deviceStaticSecret: string;
  deviceEphemeralSecret: string;
  agentStaticSecret: string;
  agentEphemeralSecret: string;
  request: { method: 'GET' | 'POST'; path: string; body?: unknown; time: number };
  requestBody: string;
  response: { status: number; time: number; body: string };
  responseBody: string;
}

function build(name: string, request: Vector['request'], response: Vector['response'], seed: number): Vector {
  const v = {
    name,
    deviceStaticSecret: hex(fill(seed)),
    deviceEphemeralSecret: hex(fill(seed + 0x40)),
    agentStaticSecret: hex(fill(seed + 0x80)),
    agentEphemeralSecret: hex(fill(seed + 0xc0)),
    request,
    response,
  };
  const agent = keyPairFromSecret(bytes(v.agentStaticSecret));
  const sealed = sealRequest(keyPairFromSecret(bytes(v.deviceStaticSecret)), agent.publicKey, request, keyPairFromSecret(bytes(v.deviceEphemeralSecret)));
  const opened = openRequest(agent, sealed.body, keyPairFromSecret(bytes(v.agentEphemeralSecret)));
  const responseBody = opened.respond(response.status, new TextEncoder().encode(response.body), response.time);
  return { ...v, requestBody: hex(sealed.body), responseBody: hex(responseBody) };
}

const expected: Vector[] = [
  build('GET /status', { method: 'GET', path: '/status', time: 1795000000000 }, { status: 200, time: 1795000000150, body: '{"light":"green"}' }, 0x01),
  build('POST /pair', { method: 'POST', path: '/pair', body: { code: 'K7QM2XRT9C', name: 'iPhone, Safari' }, time: 1795000060000 }, { status: 201, time: 1795000060020, body: '{"deviceId":"3f1c","cluster":"homelab"}' }, 0x11),
];

if (process.env['UPDATE_VECTORS']) {
  writeFileSync(file, JSON.stringify(expected, null, 2) + '\n');
}

const noise = createRequire(import.meta.url)('noise-protocol') as {
  initialize(pattern: string, initiator: boolean, prologue: Buffer, s?: unknown): unknown;
  readMessage: ((state: unknown, message: Buffer, out: Buffer) => unknown) & { bytes: number };
};

describe('test vectors', () => {
  const stored = JSON.parse(readFileSync(file, 'utf8')) as Vector[];

  it('are reproduced byte for byte', () => {
    expect(expected).toEqual(stored);
  });

  for (const vector of stored) {
    it(`${vector.name}: message 1 opens with libsodium as well`, () => {
      const agent = keyPairFromSecret(bytes(vector.agentStaticSecret));
      const responder = noise.initialize('IK', false, Buffer.from('kubernanny-e2e/1'), {
        publicKey: Buffer.from(agent.publicKey),
        secretKey: Buffer.from(agent.secretKey),
      });
      const message1 = Buffer.from(vector.requestBody, 'hex').subarray(1);
      const payload = Buffer.alloc(message1.length);
      noise.readMessage(responder, message1, payload);
      const wire = JSON.parse(payload.subarray(0, noise.readMessage.bytes).toString()) as { m: string; p: string; t: number };
      expect(wire.m).toBe(vector.request.method);
      expect(wire.p).toBe(vector.request.path);
      expect(wire.t).toBe(vector.request.time);
    });
  }
});
