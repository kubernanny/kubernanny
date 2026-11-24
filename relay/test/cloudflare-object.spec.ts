import { FrameType, KeyPair, answerChallenge, decodeFrame, encodeReply, generateKeyPair, relayAgentId } from '@kubernanny/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentObjectCore, AgentObjectState, HibernatableSocket, MAX_PENDING_PER_OBJECT } from '../cloudflare/src/agent-object';

/** A Workers WebSocket, as far as the object uses it. */
class FakeSocket implements HibernatableSocket {
  sent: (Uint8Array | string)[] = [];
  closed: number | null = null;
  private attachment: unknown = null;
  constructor(private readonly state: FakeState) {}
  send(message: ArrayBuffer | Uint8Array | string): void {
    this.sent.push(typeof message === 'string' ? message : new Uint8Array(message as ArrayBuffer).slice());
  }
  close(code?: number): void {
    this.closed = code ?? 1000;
    this.state.sockets = this.state.sockets.filter((s) => s !== this);
  }
  serializeAttachment(value: unknown): void {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

class FakeState implements AgentObjectState {
  sockets: FakeSocket[] = [];
  alarm: number | null = null;
  storage = {
    setAlarm: async (time: number) => {
      this.alarm = time;
    },
    getAlarm: async () => this.alarm,
  };
  acceptWebSocket(socket: HibernatableSocket): void {
    this.sockets.push(socket as FakeSocket);
  }
  getWebSockets(): HibernatableSocket[] {
    return [...this.sockets];
  }
  setWebSocketAutoResponse(): void {}
  getWebSocketAutoResponseTimestamp(): Date | null {
    return null;
  }
}

describe('Cloudflare agent object', () => {
  let state: FakeState;
  let object: AgentObjectCore;
  let last: FakeSocket;
  const agent: KeyPair = generateKeyPair();
  const agentId = relayAgentId(agent.publicKey);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    state = new FakeState();
    object = wake();
  });
  afterEach(() => vi.useRealTimers());

  /** A new core on the same state and sockets: what the runtime does when the object wakes from hibernation. */
  const wake = (env: Record<string, string> = {}) =>
    new AgentObjectCore(state, { RELAY_REGISTER_TIMEOUT_MS: '3000', ...env }, {
      newSocketPair: () => {
        last = new FakeSocket(state);
        return [{}, last];
      },
      autoResponse: () => null,
      upgradeResponse: () => new Response(null, { status: 200 }),
    });

  const connect = async () => {
    await object.fetch(new Request(`https://relay/v1/agents/${agentId}/ws`), 'connect', agentId);
    return last;
  };
  const prove = async (socket: FakeSocket, keys = agent) => {
    const challenge = decodeFrame(socket.sent[0] as Uint8Array);
    await object.webSocketMessage(socket, answerChallenge(keys, challenge.payload).slice().buffer);
  };
  const call = (body: Uint8Array) => object.fetch(new Request(`https://relay/v1/agents/${agentId}/e2e`, { method: 'POST', body }), 'call', agentId);

  it('registers with the proof and forwards a call', async () => {
    const socket = await connect();
    await prove(socket);
    expect(decodeFrame(socket.sent[1] as Uint8Array).type).toBe(FrameType.Ready);
    const pending = call(Uint8Array.of(1, 2));
    await vi.advanceTimersByTimeAsync(0);
    const forwarded = decodeFrame(socket.sent[2] as Uint8Array);
    for (const frame of encodeReply(forwarded.callId, 200, Uint8Array.of(9))) {
      await object.webSocketMessage(socket, frame.slice().buffer);
    }
    const res = await pending;
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(Uint8Array.of(9));
  });

  it('does not let a wrong key in, and gives no second try on the socket', async () => {
    const socket = await connect();
    await prove(socket, generateKeyPair());
    expect(socket.closed).toBe(4001);
    expect(state.sockets).toHaveLength(0);
  });

  it('turns an odd agent status into 502 (hardening)', async () => {
    const socket = await connect();
    await prove(socket);
    const pending = call(Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(0);
    const forwarded = decodeFrame(socket.sent[2] as Uint8Array);
    await object.webSocketMessage(socket, encodeReply(forwarded.callId, 301, new TextEncoder().encode('<b>'))[0]!.slice().buffer);
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 'RELAY_BAD_AGENT_RESPONSE' });
  });

  it('never moves the registration alarm later when another socket connects (review H2)', async () => {
    await connect();
    expect(state.alarm).toBe(3000);
    vi.setSystemTime(1000);
    await connect();
    expect(state.alarm).toBe(3000);
    vi.setSystemTime(3000);
    await object.alarm();
    expect(state.sockets).toHaveLength(1); // the first timed out, the second is due at 4000
    expect(state.alarm).toBe(4000);
  });

  it('keeps at most a few unproven sockets per agent id, and a real agent still gets in (review H2)', async () => {
    for (let i = 0; i < 20; i++) {
      await connect();
    }
    expect(state.sockets.length).toBeLessThanOrEqual(MAX_PENDING_PER_OBJECT);
    const socket = await connect();
    await prove(socket);
    expect(decodeFrame(socket.sent[1] as Uint8Array).type).toBe(FrameType.Ready);
  });

  it('keeps its rate limits across a hibernation (review: the buckets reset on every wake-up)', async () => {
    const env = { RELAY_CALL_BURST: '2', RELAY_CALLS_PER_MINUTE: '1' };
    object = wake(env);
    const socket = await connect();
    await prove(socket);
    const answered = async () => {
      const pending = call(Uint8Array.of(1));
      await vi.advanceTimersByTimeAsync(0);
      const forwarded = decodeFrame(socket.sent.at(-1) as Uint8Array);
      if (forwarded.type === FrameType.Call) {
        for (const frame of encodeReply(forwarded.callId, 200, Uint8Array.of(9))) {
          await object.webSocketMessage(socket, frame.slice().buffer);
        }
      }
      return (await pending).status;
    };
    expect(await answered()).toBe(200);
    object = wake(env);
    expect(await answered()).toBe(200);
    object = wake(env);
    expect(await answered()).toBe(429);
    vi.setSystemTime(60_000);
    object = wake(env);
    expect(await answered()).toBe(200);
  });
});
