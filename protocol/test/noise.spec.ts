import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { generateKeyPair, Initiator, Responder } from '../src/noise.js';
import { cipherKey } from './cipher-key.js';

/** The independent implementation: emilbayes/noise-protocol on libsodium. */
const noise = createRequire(import.meta.url)('noise-protocol') as {
  initialize(pattern: string, initiator: boolean, prologue: Buffer, s?: unknown, e?: unknown, rs?: Buffer): unknown;
  writeMessage: ((state: unknown, payload: Buffer, out: Buffer) => { tx: Buffer; rx: Buffer } | undefined) & {
    bytes: number;
  };
  readMessage: ((state: unknown, message: Buffer, out: Buffer) => { tx: Buffer; rx: Buffer } | undefined) & {
    bytes: number;
  };
  keygen(): { publicKey: Buffer; secretKey: Buffer };
};

const prologue = new TextEncoder().encode('kubernanny-e2e/1');
const payload = (text: string) => new TextEncoder().encode(text);

function sodiumKeys(): {
  pair: { publicKey: Buffer; secretKey: Buffer };
  mine: { publicKey: Uint8Array; secretKey: Uint8Array };
} {
  const pair = noise.keygen();
  // libsodium stores the 32-byte scalar as secret key, like noble.
  return { pair, mine: { publicKey: new Uint8Array(pair.publicKey), secretKey: new Uint8Array(pair.secretKey) } };
}

describe('Noise IK against libsodium (noise-protocol)', () => {
  for (let round = 0; round < 20; round++) {
    it(`our initiator, their responder (${round})`, () => {
      const device = generateKeyPair();
      const agent = sodiumKeys();
      const initiator = new Initiator(device, agent.mine.publicKey, prologue);
      const responder = noise.initialize('IK', false, Buffer.from(prologue), agent.pair);

      const m1 = initiator.writeMessage1(payload(`request ${round}`));
      const p1 = Buffer.alloc(m1.length);
      noise.readMessage(responder, Buffer.from(m1), p1);
      expect(p1.subarray(0, noise.readMessage.bytes).toString()).toBe(`request ${round}`);

      const m2 = Buffer.alloc(200);
      const split = noise.writeMessage(responder, Buffer.from(`answer ${round}`), m2)!;
      const { payload: p2, transport } = initiator.readMessage2(
        new Uint8Array(m2.subarray(0, noise.writeMessage.bytes)),
      );
      expect(new TextDecoder().decode(p2)).toBe(`answer ${round}`);
      // Same Split() outputs. noise-protocol names them from the side that
      // finished the handshake (writer: tx = c1), so compare c1 and c2 directly.
      expect(Buffer.from(cipherKey(transport.send)!)).toEqual(split.tx.subarray(0, 32));
      expect(Buffer.from(cipherKey(transport.receive)!)).toEqual(split.rx.subarray(0, 32));
    });

    it(`their initiator, our responder (${round})`, () => {
      const device = sodiumKeys();
      const agent = generateKeyPair();
      const initiator = noise.initialize(
        'IK',
        true,
        Buffer.from(prologue),
        device.pair,
        null,
        Buffer.from(agent.publicKey),
      );
      const responder = new Responder(agent, prologue);

      const m1 = Buffer.alloc(300);
      noise.writeMessage(initiator, Buffer.from(`request ${round}`), m1);
      const read = responder.readMessage1(new Uint8Array(m1.subarray(0, noise.writeMessage.bytes)));
      expect(read.initiatorStatic).toEqual(device.mine.publicKey);
      expect(new TextDecoder().decode(read.payload)).toBe(`request ${round}`);

      const { message, transport } = responder.writeMessage2(payload(`answer ${round}`));
      const p2 = Buffer.alloc(message.length);
      const split = noise.readMessage(initiator, Buffer.from(message), p2)!;
      expect(p2.subarray(0, noise.readMessage.bytes).toString()).toBe(`answer ${round}`);
      // Reader side: noise-protocol's rx = c1 (initiator to responder), tx = c2.
      expect(Buffer.from(cipherKey(transport.receive)!)).toEqual(split.rx.subarray(0, 32));
      expect(Buffer.from(cipherKey(transport.send)!)).toEqual(split.tx.subarray(0, 32));
    });
  }

  it('fails when the initiator pinned another responder key', () => {
    const device = generateKeyPair();
    const initiator = new Initiator(device, generateKeyPair().publicKey, prologue);
    const responder = new Responder(generateKeyPair(), prologue);
    expect(() => responder.readMessage1(initiator.writeMessage1(payload('x')))).toThrow();
  });

  it('fails on a different prologue', () => {
    const agent = generateKeyPair();
    const initiator = new Initiator(generateKeyPair(), agent.publicKey, payload('kubernanny-e2e/2'));
    expect(() => new Responder(agent, prologue).readMessage1(initiator.writeMessage1(payload('x')))).toThrow();
  });

  it('fails on any flipped bit of message 1', () => {
    const agent = generateKeyPair();
    const m1 = new Initiator(generateKeyPair(), agent.publicKey, prologue).writeMessage1(payload('hello'));
    for (let i = 0; i < m1.length; i += 7) {
      const tampered = m1.slice();
      tampered[i]! ^= 0x01;
      expect(() => new Responder(agent, prologue).readMessage1(tampered)).toThrow();
    }
  });

  it('refuses a low-order point as ephemeral key', () => {
    const agent = generateKeyPair();
    const m1 = new Initiator(generateKeyPair(), agent.publicKey, prologue).writeMessage1(payload('hello'));
    m1.fill(0, 0, 32);
    expect(() => new Responder(agent, prologue).readMessage1(m1)).toThrow();
  });
});
