import { FrameType, REPLY_CHUNK, answerChallenge, decodeFrame, encodeFrame, encodeReply, generateKeyPair, relayAgentId } from '@kubernanny/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { RunningRelay, startRelay } from '../src/bootstrap';

/**
 * The security re-review's residuals: nobody may take the whole answer
 * budget (R1) or all agent slots (R2) from one or two addresses. Client
 * addresses come from x-forwarded-for, so one test machine plays many hosts.
 */
describe('fair shares between client addresses', () => {
  let relay: RunningRelay | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    sockets.splice(0).forEach((s) => s.terminate());
    await relay?.close();
    relay = null;
    for (const key of Object.keys(process.env).filter((k) => k.startsWith('RELAY_') || k === 'TRUST_PROXY')) {
      delete process.env[key];
    }
  });

  async function start(env: Record<string, string>) {
    Object.assign(process.env, { TRUST_PROXY: 'x-forwarded-for', ...env });
    relay = await startRelay({ port: 0, metricsPort: 0, logger: false });
  }

  type OnCall = (ws: WebSocket, callId: number) => void;
  /** A self-made agent from `address`: 'ok' with its id, or how it was refused or closed. */
  function register(address: string, onCall: OnCall = () => undefined): Promise<{ result: string; id: string }> {
    const keys = generateKeyPair();
    const id = relayAgentId(keys.publicKey);
    const ws = new WebSocket(`ws://127.0.0.1:${relay!.port}/v1/agents/${id}/ws`, { headers: { 'x-forwarded-for': address } });
    sockets.push(ws);
    return new Promise((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve({ result: `refused ${res.statusCode}`, id }));
      ws.on('close', (code) => resolve({ result: `closed ${code}`, id }));
      ws.on('error', () => undefined);
      ws.on('message', (data: Buffer, binary: boolean) => {
        if (!binary) {
          return;
        }
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.type === FrameType.Challenge) {
          ws.send(answerChallenge(keys, frame.payload));
        } else if (frame.type === FrameType.Ready) {
          resolve({ result: 'ok', id });
        } else if (frame.type === FrameType.Call) {
          onCall(ws, frame.callId);
        }
      });
    });
  }

  const call = (id: string) => fetch(`http://127.0.0.1:${relay!.port}/v1/agents/${id}/e2e`, { method: 'POST', body: 'x' });

  it('R1: hogs from two addresses cannot starve a legitimate agent, and lose their hold when they stall', async () => {
    await start({ RELAY_MAX_INFLIGHT_BYTES: String(8 * 1024 * 1024) }); // a share of 2 MiB per agent and per address
    const hog: OnCall = (ws, callId) => {
      for (let c = 0; c < 4; c++) {
        ws.send(encodeFrame(FrameType.ReplyChunk, callId, new Uint8Array(REPLY_CHUNK))); // 1 MiB, never finished
      }
    };
    const hogs = [await register('6.6.6.1', hog), await register('6.6.6.1', hog), await register('6.6.6.2', hog), await register('6.6.6.2', hog)];
    const legit = await register('7.7.7.7', (ws, callId) => encodeReply(callId, 200, new Uint8Array(8000)).forEach((f) => ws.send(f)));
    const started = Date.now();
    const hogCalls = hogs.flatMap((h) => [call(h.id), call(h.id), call(h.id), call(h.id)]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const res = await call(legit.id);
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(8000);
    const statuses = await Promise.all(hogCalls.map((p) => p.then((r) => r.status)));
    expect(statuses.every((s) => s === 503 || s === 504)).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000); // stalled answers end at the progress timeout, not the 25 s call timeout
  });

  it('R1: a legitimate agent behind the same address as the hogs still gets its small answer through', async () => {
    await start({ RELAY_MAX_INFLIGHT_BYTES: String(8 * 1024 * 1024) });
    const hog: OnCall = (ws, callId) => {
      for (let c = 0; c < 4; c++) {
        ws.send(encodeFrame(FrameType.ReplyChunk, callId, new Uint8Array(REPLY_CHUNK)));
      }
    };
    const hogs = [await register('6.6.6.1', hog), await register('6.6.6.1', hog)];
    const legit = await register('6.6.6.1', (ws, callId) => encodeReply(callId, 200, new Uint8Array(8000)).forEach((f) => ws.send(f)));
    const hogCalls = hogs.flatMap((h) => [call(h.id), call(h.id), call(h.id), call(h.id)]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    for (let i = 0; i < 3; i++) {
      expect((await call(legit.id)).status).toBe(200);
    }
    await Promise.all(hogCalls);
  });

  it('R2: one address gets only its share of agent slots', async () => {
    await start({ RELAY_MAX_AGENTS_PER_IP: '4' });
    for (let i = 0; i < 4; i++) {
      expect((await register('6.6.6.6')).result).toBe('ok');
    }
    expect((await register('6.6.6.6')).result).toBe('refused 503');
    expect((await register('7.7.7.7')).result).toBe('ok');
  });

  it('R2: when the relay is full, the address holding the most gives way to a newcomer', async () => {
    await start({ RELAY_MAX_AGENTS: '6', RELAY_MAX_AGENTS_PER_IP: '4' });
    const a = [];
    for (let i = 0; i < 4; i++) {
      a.push(register('6.6.6.6'));
      await a.at(-1);
    }
    expect((await register('7.7.7.1')).result).toBe('ok');
    expect((await register('7.7.7.2')).result).toBe('ok');
    expect((await register('7.7.7.3')).result).toBe('ok'); // one of 6.6.6.6's four is closed for it
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sockets.slice(0, 4).filter((s) => s.readyState === WebSocket.OPEN)).toHaveLength(3);
    expect((await register('6.6.6.6')).result).toBe('refused 503'); // it would hold the most again
  });
});
