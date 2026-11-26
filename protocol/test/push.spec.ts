import { readFileSync, writeFileSync } from 'node:fs';

import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { CipherSuite, HkdfSha256 } from '@hpke/core';
import { DhkemX25519HkdfSha256 } from '@hpke/dhkem-x25519';
import { describe, expect, it } from 'vitest';

import { toBase64Url } from '../src/keys.js';
import { generateKeyPair, keyPairFromSecret } from '../src/noise.js';
import { DEADMAN_GRACE_MINUTES, deadmanPushContent, isDeadman } from '../src/push.js';
import {
  decodePushContent,
  decodePushStatus,
  encodePushContent,
  isStatusOnly,
  MAX_PUSH_PLAINTEXT,
  openPush,
  PUSH_INFO,
  PUSH_STATUS_ONLY,
  pushKeyId,
  sealPush,
  statusPushContent,
} from '../src/push.js';
import {
  decodeDeposit,
  decodeDepositResult,
  DEPOSIT_OUTCOMES,
  encodeDeposit,
  encodeDepositResult,
  MAX_DEPOSIT_VALIDITY_SECONDS,
} from '../src/relay.js';
import {
  decodeFrame,
  decodePushRequest,
  decodePushResult,
  encodePushRequest,
  encodePushResult,
  FrameType,
} from '../src/relay.js';

/**
 * Fixed keys, fixed bytes: test/push-vectors.json, printed in docs/PROTOCOL.md
 * and read by the native copies (app/native/push) and the app's spec.
 * Regenerate only after a deliberate change with
 * UPDATE_VECTORS=1 npx vitest run test/push.spec.ts
 */
const file = new URL('./push-vectors.json', import.meta.url);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'hex'));
const fill = (start: number) => new Uint8Array(32).map((_, i) => (start + i) & 0xff);
const text = new TextEncoder();

interface PushVector {
  name: string;
  agentStaticSecret: string;
  agentStaticPublic: string;
  pushSecret: string;
  pushPublic: string;
  ephemeralSecret: string;
  keyId: string;
  plaintext: string;
  message: string;
}

function build(name: string, plaintext: string, seed: number): PushVector {
  const agent = keyPairFromSecret(fill(seed + 0x80));
  const push = keyPairFromSecret(fill(seed + 0x20));
  const ephemeral = keyPairFromSecret(fill(seed + 0x60));
  return {
    name,
    agentStaticSecret: hex(agent.secretKey),
    agentStaticPublic: hex(agent.publicKey),
    pushSecret: hex(push.secretKey),
    pushPublic: hex(push.publicKey),
    ephemeralSecret: hex(ephemeral.secretKey),
    keyId: pushKeyId(push.publicKey),
    plaintext,
    message: hex(sealPush(agent, push.publicKey, text.encode(plaintext), ephemeral)),
  };
}

const expected: PushVector[] = [
  build('status', '{"t":"homelab: 2 problems","b":"🔴 default/api: CrashLoopBackOff","p":5,"s":1795000000000}', 0x01),
  build(
    'minimal',
    '{"t":"homelab: new problems","b":"1 critical. Details in Kubernanny.","p":5,"s":1795000060000}',
    0x31,
  ),
  build(
    'widget-status',
    '{"t":"homelab: 2 problems","b":"🔴 default/api: CrashLoopBackOff","p":5,"s":1795000120000,"w":{"l":"red","c":1,"n":1,"a":1795000110000,"i":[{"s":"c","t":"default/api: CrashLoopBackOff"},{"s":"w","t":"Certificate shop.example expires in 9 days"}]}}',
    0x51,
  ),
  build(
    'status-only',
    '{"t":"","b":"","p":0,"s":1795003600000,"w":{"l":"yellow","c":0,"n":1,"a":1795003590000,"i":[{"s":"w","t":"Certificate shop.example expires in 9 days"}]}}',
    0x71,
  ),
  build(
    'deadman',
    '{"t":"homelab: Kubernanny is silent","b":"No word from Kubernanny for 15 min. Check the cluster or the agent.","p":3,"s":1795000000000,"d":{"u":1795010800000,"g":15}}',
    0x91,
  ),
];

if (process.env['UPDATE_VECTORS']) {
  writeFileSync(file, JSON.stringify(expected, null, 2) + '\n');
}

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});

async function hpkeKeyPair(secret: Uint8Array, publicKey: Uint8Array): Promise<CryptoKeyPair> {
  return {
    privateKey: await suite.kem.importKey('raw', secret.slice().buffer, false),
    publicKey: await suite.kem.importKey('raw', publicKey.slice().buffer, true),
  };
}

describe('push sealing', () => {
  const agent = generateKeyPair();
  const push = generateKeyPair();
  const plaintext = text.encode('{"t":"x","b":"y","p":3,"s":1}');

  it('opens with the push key and the pinned agent key', () => {
    expect(openPush(push, agent.publicKey, sealPush(agent, push.publicKey, plaintext))).toEqual(plaintext);
  });

  it('uses a fresh ephemeral key per message', () => {
    expect(hex(sealPush(agent, push.publicKey, plaintext))).not.toBe(hex(sealPush(agent, push.publicKey, plaintext)));
  });

  it('refuses a changed byte anywhere', () => {
    const sealed = sealPush(agent, push.publicKey, plaintext);
    for (const index of [1, 20, 33, sealed.length - 1]) {
      const tampered = sealed.slice();
      tampered[index]! ^= 1;
      expect(() => openPush(push, agent.publicKey, tampered)).toThrow();
    }
  });

  it('refuses a message from anyone but the pinned agent (mode_auth)', () => {
    const relay = generateKeyPair();
    expect(() => openPush(push, agent.publicKey, sealPush(relay, push.publicKey, plaintext))).toThrow();
  });

  it('refuses another device push key, another version and short input', () => {
    const sealed = sealPush(agent, push.publicKey, plaintext);
    expect(() => openPush(generateKeyPair(), agent.publicKey, sealed)).toThrow();
    const v2 = sealed.slice();
    v2[0] = 2;
    expect(() => openPush(push, agent.publicKey, v2)).toThrow(/version/);
    expect(() => openPush(push, agent.publicKey, sealed.subarray(0, 40))).toThrow();
  });

  it('caps the plaintext', () => {
    expect(() => sealPush(agent, push.publicKey, new Uint8Array(MAX_PUSH_PLAINTEXT + 1))).toThrow();
  });

  it('agrees with @hpke/core (RFC 9180) both ways', async () => {
    const recipientPair = await hpkeKeyPair(push.secretKey, push.publicKey);
    const senderPair = await hpkeKeyPair(agent.secretKey, agent.publicKey);
    const ours = sealPush(agent, push.publicKey, plaintext);
    const recipient = await suite.createRecipientContext({
      recipientKey: recipientPair,
      enc: ours.slice(1, 33).buffer,
      senderPublicKey: senderPair.publicKey,
      info: PUSH_INFO.slice().buffer,
    });
    expect(new Uint8Array(await recipient.open(ours.slice(33).buffer))).toEqual(plaintext);

    const sender = await suite.createSenderContext({
      recipientPublicKey: recipientPair.publicKey,
      senderKey: senderPair,
      info: PUSH_INFO.slice().buffer,
    });
    const theirs = new Uint8Array([
      1,
      ...new Uint8Array(sender.enc),
      ...new Uint8Array(await sender.seal(plaintext.slice().buffer)),
    ]);
    expect(openPush(push, agent.publicKey, theirs)).toEqual(plaintext);
  });
});

describe('push content', () => {
  it('round-trips and shortens a long body to fit', () => {
    const content = { t: 'homelab: 40 problems', b: '🔴 a very long line\n'.repeat(400), p: 5, s: 1795000000000 };
    const encoded = encodePushContent(content);
    expect(encoded.length).toBeLessThanOrEqual(MAX_PUSH_PLAINTEXT);
    const decoded = decodePushContent(encoded);
    expect(decoded.t).toBe(content.t);
    expect(decoded.b.endsWith('…')).toBe(true);
    expect(content.b.startsWith(decoded.b.slice(0, -1))).toBe(true);
  });

  it('refuses a title that cannot fit', () => {
    expect(() => encodePushContent({ t: 'x'.repeat(3000), b: 'y', p: 3, s: 1 })).toThrow();
  });

  it('carries the widget status and keeps it in key order', () => {
    const w = {
      l: 'red' as const,
      c: 1,
      n: 2,
      a: 1795000000000,
      i: [{ s: 'c' as const, t: 'default/api: CrashLoopBackOff' }],
    };
    const encoded = encodePushContent({ t: 'homelab: 1 problem', b: 'x', p: 5, s: 1795000000001, w });
    expect(new TextDecoder().decode(encoded)).toBe(
      '{"t":"homelab: 1 problem","b":"x","p":5,"s":1795000000001,"w":{"l":"red","c":1,"n":2,"a":1795000000000,"i":[{"s":"c","t":"default/api: CrashLoopBackOff"}]}}',
    );
    expect(decodePushContent(encoded).w).toEqual(w);
  });

  it('reads content without a status (older agents) and drops a malformed one', () => {
    expect(decodePushContent(text.encode('{"t":"a","b":"b","p":3,"s":1}')).w).toBeUndefined();
    for (const w of [
      '{"l":"pink","c":0,"n":0,"a":null}',
      '{"l":"red","c":-1,"n":0,"a":null}',
      '{"l":"red","c":0,"n":0,"a":null,"i":[{"s":"x","t":"a"}]}',
      '{"l":"red","c":0,"n":0,"a":null,"i":[1,2,3,4]}',
      '"red"',
    ]) {
      const decoded = decodePushContent(text.encode(`{"t":"a","b":"b","p":3,"s":1,"w":${w}}`));
      expect(decoded.w).toBeUndefined();
      expect(decoded.t).toBe('a');
    }
    expect(decodePushStatus({ l: 'green', c: 0, n: 0, a: null })).toEqual({ l: 'green', c: 0, n: 0, a: null });
  });

  it('leaves the status out rather than fail when the title takes the room', () => {
    const encoded = encodePushContent({
      t: 'x'.repeat(1990),
      b: 'y',
      p: 3,
      s: 1,
      w: { l: 'red', c: 1, n: 0, a: 1, i: [{ s: 'c', t: 'z'.repeat(100) }] },
    });
    expect(encoded.length).toBeLessThanOrEqual(MAX_PUSH_PLAINTEXT);
    expect(decodePushContent(encoded).w).toBeUndefined();
  });

  it('a status push has no text, priority 0, and keeps its status', () => {
    const status = { l: 'green' as const, c: 0, n: 0, a: 1795003590000 };
    const content = statusPushContent(status, 1795003600000);
    expect(content).toEqual({ t: '', b: '', p: PUSH_STATUS_ONLY, s: 1795003600000, w: status });
    const decoded = decodePushContent(encodePushContent(content));
    expect(isStatusOnly(decoded)).toBe(true);
    expect(decoded.w).toEqual(status);
    expect(isStatusOnly({ t: 'x', b: 'y', p: 2, s: 1 })).toBe(false);
  });

  it('refuses content that is not push content', () => {
    expect(() => decodePushContent(text.encode('{"t":1}'))).toThrow();
  });
});

describe('push frames on the relay socket', () => {
  const request = {
    token: 'f'.repeat(30) + ':APA91b',
    platform: 'ios' as const,
    kid: 'AbCdEfGhIjKlMnOp',
    message: toBase64Url(new Uint8Array(80)),
  };

  it('round-trip', () => {
    const frame = decodeFrame(encodePushRequest(7, request));
    expect(frame.type).toBe(FrameType.Push);
    expect(frame.callId).toBe(7);
    expect(decodePushRequest(frame.payload)).toEqual(request);
    expect(decodePushResult(decodeFrame(encodePushResult(7, 'unregistered')).payload)).toBe('unregistered');
  });

  it('carry the silent flag as "q": 1, and only that value', () => {
    const silent = { ...request, silent: true };
    const payload = decodeFrame(encodePushRequest(8, silent)).payload;
    expect(JSON.parse(new TextDecoder().decode(payload)).q).toBe(1);
    expect(decodePushRequest(payload)).toEqual(silent);
    expect(JSON.parse(new TextDecoder().decode(decodeFrame(encodePushRequest(9, request)).payload)).q).toBeUndefined();
    const enc = (v: unknown) => text.encode(JSON.stringify(v));
    expect(
      decodePushRequest(enc({ t: request.token, o: 'ios', k: request.kid, m: request.message, q: true })),
    ).toBeNull();
    expect(decodePushRequest(enc({ t: request.token, o: 'ios', k: request.kid, m: request.message, q: 0 }))).toBeNull();
  });

  it('refuse malformed requests and read unknown results as failed', () => {
    const enc = (v: unknown) => text.encode(JSON.stringify(v));
    expect(decodePushRequest(enc({ t: 'short', o: 'ios', k: request.kid, m: request.message }))).toBeNull();
    expect(decodePushRequest(enc({ t: request.token, o: 'web', k: request.kid, m: request.message }))).toBeNull();
    expect(decodePushRequest(enc({ t: request.token, o: 'ios', k: 'x', m: request.message }))).toBeNull();
    expect(decodePushRequest(text.encode('not json'))).toBeNull();
    expect(decodePushResult(text.encode('{"s":"exploded"}'))).toBe('failed');
  });
});

describe('push vectors', () => {
  const stored = JSON.parse(readFileSync(file, 'utf8')) as PushVector[];

  it('are reproduced byte for byte', () => {
    expect(expected).toEqual(stored);
  });

  for (const vector of stored) {
    it(`${vector.name}: opens with @hpke/core as well`, async () => {
      const message = bytes(vector.message);
      const recipientPair = await hpkeKeyPair(bytes(vector.pushSecret), bytes(vector.pushPublic));
      const senderPublic = await suite.kem.importKey('raw', bytes(vector.agentStaticPublic).buffer, true);
      const recipient = await suite.createRecipientContext({
        recipientKey: recipientPair,
        enc: message.slice(1, 33).buffer,
        senderPublicKey: senderPublic,
        info: PUSH_INFO.slice().buffer,
      });
      expect(new TextDecoder().decode(await recipient.open(message.slice(33).buffer))).toBe(vector.plaintext);
    });
  }
});

describe("dead man's switch messages", () => {
  it('encode in key order and decode with their descriptor', () => {
    const content = deadmanPushContent(
      'homelab: Kubernanny is silent',
      'No word from Kubernanny for 15 min. Check the cluster or the agent.',
      1795000000000,
      1795010800000,
      15,
    );
    const bytes = encodePushContent(content);
    expect(new TextDecoder().decode(bytes)).toBe(expected.find((v) => v.name === 'deadman')!.plaintext);
    const decoded = decodePushContent(bytes);
    expect(isDeadman(decoded)).toBe(true);
    expect(decoded.d).toEqual({ u: 1795010800000, g: 15 });
    expect(isDeadman(decodePushContent(text.encode('{"t":"x","b":"y","p":3,"s":1}')))).toBe(false);
  });

  it('refuse a message whose descriptor does not parse, instead of showing it as an ordinary push', () => {
    for (const d of ['{"u":1}', '{"u":1,"g":20}', '{"u":"soon","g":15}', '[]', 'null']) {
      expect(() => decodePushContent(text.encode(`{"t":"x","b":"y","p":3,"s":1,"d":${d}}`))).toThrow();
    }
    expect(DEADMAN_GRACE_MINUTES).toEqual([10, 15, 30, 60]);
  });
});

describe('deposit frames', () => {
  const item = {
    token: 'cXVpdGUtYS10b2tlbg:APA91bHPRgkF-test_token',
    platform: 'ios' as const,
    kid: 'LbUGLxX9BNGEjdbP',
    message: 'A'.repeat(200),
    lang: 'de' as const,
    graceMinutes: 30,
  };

  it('round-trip, an empty list included', () => {
    for (const deposit of [
      { validitySeconds: 10800, holdSeconds: 0, items: [item] },
      { validitySeconds: 10800, holdSeconds: 3600, items: [] },
    ]) {
      const frame = decodeFrame(encodeDeposit(9, deposit));
      expect(frame.type).toBe(FrameType.Deposit);
      expect(frame.callId).toBe(9);
      expect(decodeDeposit(frame.payload)).toEqual(deposit);
    }
  });

  it('refuse anything malformed', () => {
    const enc = (v: unknown) => text.encode(JSON.stringify(v));
    const wire = { t: item.token, o: 'ios', k: item.kid, m: item.message, g: 30 };
    expect(decodeDeposit(enc({ x: 10800, h: 0, d: [wire] }))).not.toBeNull();
    expect(decodeDeposit(enc({ x: 10800, h: 0, d: [{ ...wire, g: 20 }] }))).toBeNull();
    expect(decodeDeposit(enc({ x: 10800, h: 0, d: [{ ...wire, k: 'x' }] }))).toBeNull();
    expect(decodeDeposit(enc({ x: 10800, h: 0, d: [{ ...wire, o: 'web' }] }))).toBeNull();
    expect(decodeDeposit(enc({ x: 0, h: 0, d: [] }))).toBeNull();
    expect(decodeDeposit(enc({ x: MAX_DEPOSIT_VALIDITY_SECONDS + 1, h: 0, d: [] }))).toBeNull();
    expect(decodeDeposit(enc({ x: 3600, h: 3600, d: [] }))).toBeNull();
    expect(decodeDeposit(enc({ x: 3600, h: 0, d: {} }))).toBeNull();
    expect(decodeDeposit(text.encode('nope'))).toBeNull();
  });

  it('results round-trip; unknown ones read as invalid', () => {
    for (const outcome of DEPOSIT_OUTCOMES) {
      expect(decodeDepositResult(decodeFrame(encodeDepositResult(3, outcome)).payload)).toBe(outcome);
    }
    expect(decodeDepositResult(text.encode('{"s":"eaten"}'))).toBe('invalid');
  });
});
