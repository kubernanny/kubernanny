import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '../src/noise.js';
import { fromBase64Url } from '../src/keys.js';
import { blake2b } from '@noble/hashes/blake2.js';
import {
  FrameType,
  RegistrationChallenge,
  RelayFrameError,
  answerChallenge,
  decodeFrame,
  decodeReplyEnd,
  encodeFrame,
  encodeReply,
  isAgentId,
  relayAgentId,
} from '../src/relay.js';

describe('relay agent id', () => {
  it('is base64url of BLAKE2b-256 over the public key, 43 characters', () => {
    const { publicKey } = generateKeyPair();
    const id = relayAgentId(publicKey);
    expect(id).toHaveLength(43);
    expect(isAgentId(id)).toBe(true);
    expect(fromBase64Url(id)).toEqual(blake2b(publicKey, { dkLen: 32 }));
  });

  it('is fixed for the test-vector agent key', () => {
    const key = Uint8Array.from(Buffer.from('883186b800b41d5cf0429695da9b3cc4f328ebcd184a6e482fa578c103f06c77', 'hex'));
    expect(relayAgentId(key)).toBe('o7oXZcDvJEDDJobQgsCp8flX2LO88EMA3CUTU5SqYok');
  });

  it('refuses anything that is not a canonical 32-byte id', () => {
    const id = relayAgentId(generateKeyPair().publicKey);
    expect(isAgentId(id.slice(1))).toBe(false);
    expect(isAgentId(`${id}A`)).toBe(false);
    expect(isAgentId(`${id.slice(0, 42)}B`)).toBe(false); // non-zero padding bits
    expect(isAgentId(`${id.slice(0, 10)}/${id.slice(11)}`)).toBe(false);
    expect(isAgentId('../../../etc/passwd/aaaaaaaaaaaaaaaaaaaaaaaa')).toBe(false);
  });
});

describe('relay frames', () => {
  it('round-trips type, call id and payload', () => {
    const frame = encodeFrame(FrameType.Call, 0xfedcba98, Uint8Array.of(1, 2, 3));
    expect(Array.from(frame.subarray(0, 5))).toEqual([0x01, 0xfe, 0xdc, 0xba, 0x98]);
    expect(decodeFrame(frame)).toEqual({ type: FrameType.Call, callId: 0xfedcba98, payload: Uint8Array.of(1, 2, 3) });
  });

  it('reads a frame at an offset inside a larger buffer', () => {
    const buffer = new Uint8Array(20);
    buffer.set(encodeFrame(FrameType.Cancel, 7), 10);
    expect(decodeFrame(buffer.subarray(10, 15))).toEqual({ type: FrameType.Cancel, callId: 7, payload: new Uint8Array(0) });
  });

  it('refuses short frames and bad call ids', () => {
    expect(() => decodeFrame(Uint8Array.of(1, 0, 0))).toThrow(RelayFrameError);
    expect(() => encodeFrame(FrameType.Call, -1)).toThrow(RelayFrameError);
    expect(() => encodeFrame(FrameType.Call, 2 ** 32)).toThrow(RelayFrameError);
  });

  it('splits a large reply into chunks and ends with the status', () => {
    const body = new Uint8Array(1000).map((_, i) => i & 0xff);
    const frames = encodeReply(9, 200, body, 300).map(decodeFrame);
    expect(frames.map((f) => f.type)).toEqual([FrameType.ReplyChunk, FrameType.ReplyChunk, FrameType.ReplyChunk, FrameType.ReplyEnd]);
    expect(frames.every((f) => f.callId === 9)).toBe(true);
    const end = decodeReplyEnd(frames[3]!.payload);
    expect(end.status).toBe(200);
    const joined = new Uint8Array([...frames.slice(0, 3).flatMap((f) => Array.from(f.payload)), ...end.last]);
    expect(joined).toEqual(body);
  });

  it('sends a small or empty reply as one end frame', () => {
    const frames = encodeReply(1, 429, new Uint8Array(0)).map(decodeFrame);
    expect(frames).toHaveLength(1);
    expect(decodeReplyEnd(frames[0]!.payload)).toEqual({ status: 429, last: new Uint8Array(0) });
    expect(() => decodeReplyEnd(Uint8Array.of(0))).toThrow(RelayFrameError);
    expect(() => decodeReplyEnd(Uint8Array.of(0, 42))).toThrow(RelayFrameError);
  });
});

describe('registration proof', () => {
  function register(agent = generateKeyPair()) {
    const challenge = new RegistrationChallenge();
    const sent = decodeFrame(challenge.frame());
    expect(sent.type).toBe(FrameType.Challenge);
    const proof = decodeFrame(answerChallenge(agent, sent.payload));
    expect(proof.type).toBe(FrameType.Proof);
    return { agent, challenge, proof: proof.payload, id: relayAgentId(agent.publicKey) };
  }

  it('passes for the key behind the id', () => {
    const { challenge, proof, id } = register();
    expect(challenge.verify(proof, id)).toBe(true);
  });

  it('fails for another key claiming the id', () => {
    const victim = generateKeyPair();
    const { challenge, proof } = register(generateKeyPair());
    expect(challenge.verify(proof, relayAgentId(victim.publicKey))).toBe(false);
  });

  it('fails for the victim public key with a proof made without its private key', () => {
    const victim = generateKeyPair();
    const challenge = new RegistrationChallenge();
    const attacker = generateKeyPair();
    const forged = decodeFrame(answerChallenge(attacker, decodeFrame(challenge.frame()).payload)).payload.slice();
    forged.set(victim.publicKey, 0);
    expect(challenge.verify(forged, relayAgentId(victim.publicKey))).toBe(false);
  });

  it('fails for a proof under the wrong id', () => {
    const { challenge, proof } = register();
    expect(challenge.verify(proof, relayAgentId(generateKeyPair().publicKey))).toBe(false);
  });

  it('fails for a proof replayed from an earlier registration', () => {
    const { agent, proof, id } = register();
    const fresh = new RegistrationChallenge();
    expect(fresh.verify(proof, id)).toBe(false);
    // The genuine agent still gets in on the fresh challenge.
    const again = new RegistrationChallenge();
    expect(again.verify(decodeFrame(answerChallenge(agent, decodeFrame(again.frame()).payload)).payload, id)).toBe(true);
  });

  it('verifies only once per challenge', () => {
    const { challenge, proof, id } = register();
    expect(challenge.verify(proof, id)).toBe(true);
    expect(challenge.verify(proof, id)).toBe(false);
  });

  it('fails for a tampered or short proof', () => {
    const { challenge, proof, id } = register();
    const tampered = proof.slice();
    tampered[63] ^= 1;
    expect(challenge.verify(tampered, id)).toBe(false);
    expect(new RegistrationChallenge().verify(proof.subarray(0, 63), id)).toBe(false);
  });

  it('is deterministic for a fixed nonce and ephemeral key', () => {
    const agent = generateKeyPair();
    const nonce = new Uint8Array(32).fill(7);
    const secret = new Uint8Array(32).fill(9);
    const a = answerChallenge(agent, decodeFrame(new RegistrationChallenge(nonce, secret).frame()).payload);
    const b = answerChallenge(agent, decodeFrame(new RegistrationChallenge(nonce, secret).frame()).payload);
    expect(a).toEqual(b);
  });
});
