import {
  answerChallenge,
  DeadmanDeposit,
  decodeDepositResult,
  decodeFrame,
  decodePushResult,
  encodeDeposit,
  encodePushRequest,
  encodeReply,
  FrameType,
  generateKeyPair,
  KeyPair,
  relayAgentId,
  toBase64Url,
} from '@kubernanny/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentObjectCore,
  AgentObjectState,
  HibernatableSocket,
  MAX_PENDING_PER_OBJECT,
} from '../cloudflare/src/agent-object';
import { durableTokenGate, TokenLimiterCore } from '../cloudflare/src/token-limiter';
import type { PushSender, TokenGate } from '../src/core/push';

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
  stored = new Map<string, unknown>();
  writes = 0;
  alarm: number | null = null;
  heard = new Map<HibernatableSocket, number>();
  storage = {
    setAlarm: async (at: number) => {
      this.alarm = at;
    },
    deleteAlarm: async () => {
      this.alarm = null;
    },
    get: async <T>(key: string) => structuredClone(this.stored.get(key)) as T | undefined,
    put: async <T>(key: string, value: T) => {
      this.writes++;
      this.stored.set(key, structuredClone(value));
    },
  };
  acceptWebSocket(socket: HibernatableSocket): void {
    this.sockets.push(socket as FakeSocket);
  }
  getWebSockets(): HibernatableSocket[] {
    return [...this.sockets];
  }
  setWebSocketAutoResponse(): void {}
  getWebSocketAutoResponseTimestamp(socket: HibernatableSocket): Date | null {
    const at = this.heard.get(socket);
    return at === undefined ? null : new Date(at);
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
  const wake = (env: Record<string, string> = {}, send?: PushSender, tokens?: TokenGate) =>
    new AgentObjectCore(
      state,
      { RELAY_REGISTER_TIMEOUT_MS: '3000', ...env },
      {
        newSocketPair: () => {
          last = new FakeSocket(state);
          return [{}, last];
        },
        autoResponse: () => null,
        upgradeResponse: () => new Response(null, { status: 200 }),
      },
      send,
      tokens,
    );

  const connect = async () => {
    await object.fetch(new Request(`https://relay/v1/agents/${agentId}/ws`), 'connect', agentId);
    return last;
  };
  const prove = async (socket: FakeSocket, keys = agent, origin = 'wss://relay') => {
    const challenge = decodeFrame(socket.sent[0] as Uint8Array);
    await object.webSocketMessage(socket, answerChallenge(keys, challenge.payload, origin).slice().buffer);
  };
  const call = (body: Uint8Array) =>
    object.fetch(new Request(`https://relay/v1/agents/${agentId}/e2e`, { method: 'POST', body }), 'call', agentId);

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
    await object.webSocketMessage(
      socket,
      encodeReply(forwarded.callId, 301, new TextEncoder().encode('<b>'))[0]!.slice().buffer,
    );
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 'RELAY_BAD_AGENT_RESPONSE' });
  });

  it('times out unproven sockets with an in-memory timer, never a storage write (review L2)', async () => {
    await connect();
    await vi.advanceTimersByTimeAsync(1000);
    await connect();
    await vi.advanceTimersByTimeAsync(2100);
    expect(state.sockets).toHaveLength(1); // the first timed out, the second is due at 4000
    await vi.advanceTimersByTimeAsync(1000);
    expect(state.sockets).toHaveLength(0);
    expect(state.writes).toBe(0);
  });

  it('closes an unproven socket left from a hibernation at the next connect, and refuses its late proof', async () => {
    const stale = await connect();
    object = wake(); // the timer is gone with the old instance
    vi.setSystemTime(5000);
    await prove(stale);
    expect(stale.closed).toBe(4002);
    const other = await connect();
    expect(state.sockets).toEqual([other]);
  });

  it('refuses a proof made for another relay (review L3)', async () => {
    const socket = await connect();
    await prove(socket, agent, 'wss://hostile.example');
    expect(socket.closed).toBe(4001);
  });

  it('marks a replaced socket as no longer registered, and calls go to the newest (review L1)', async () => {
    const first = await connect();
    await prove(first);
    vi.setSystemTime(10);
    const second = await connect();
    await prove(second);
    expect(first.closed).toBe(4003);
    expect((first.deserializeAttachment() as { session: { phase: string } }).session.phase).toBe('ended');
    const pending = call(Uint8Array.of(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(decodeFrame(second.sent.at(-1) as Uint8Array).type).toBe(FrameType.Call);
    void pending;
  });

  it('answers an offline agent without reading the body, and stops reading a chunked body past the limit (review M2)', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(16 * 1024));
      },
    });
    const offline = await object.fetch(
      new Request(`https://relay/v1/agents/${agentId}/e2e`, {
        method: 'POST',
        body: endless,
        duplex: 'half',
      } as RequestInit),
      'call',
      agentId,
    );
    expect(await offline.json()).toEqual({ code: 'RELAY_AGENT_OFFLINE' });
    expect(pulled).toBeLessThanOrEqual(1);
    const socket = await connect();
    await prove(socket);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(16 * 1024));
      },
    });
    pulled = 0;
    const large = await object.fetch(
      new Request(`https://relay/v1/agents/${agentId}/e2e`, { method: 'POST', body, duplex: 'half' } as RequestInit),
      'call',
      agentId,
    );
    expect(await large.json()).toEqual({ code: 'RELAY_TOO_LARGE' });
    expect(pulled).toBeLessThan(10);
  });

  it('gives each calling address only its share of the agent buckets (review M1)', async () => {
    object = wake({ RELAY_CALL_BURST: '4', RELAY_CALLS_PER_MINUTE: '4', RELAY_MAX_CONCURRENT: '100' });
    const socket = await connect();
    await prove(socket);
    const from = (ip: string) =>
      object.fetch(
        new Request(`https://relay/v1/agents/${agentId}/e2e`, {
          method: 'POST',
          body: Uint8Array.of(1),
          headers: { 'cf-connecting-ip': ip },
        }),
        'call',
        agentId,
      );
    void from('6.6.6.6');
    await vi.advanceTimersByTimeAsync(0);
    expect((await from('6.6.6.6')).status).toBe(429);
    void from('7.7.7.7');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent.map((m) => decodeFrame(m as Uint8Array)).filter((f) => f.type === FrameType.Call)).toHaveLength(
      2,
    );
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

  describe('native push', () => {
    const fcm = JSON.stringify({
      client_email: 'r@p.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----',
      project_id: 'kubernanny-test',
    });
    const push = (id: number) =>
      encodePushRequest(id, {
        token: 'device-token-0123456789:APA91b',
        platform: 'ios',
        kid: 'AbCdEfGhIjKlMnOp',
        message: toBase64Url(new Uint8Array(80)),
      });
    const ready = (socket: FakeSocket) =>
      JSON.parse(new TextDecoder().decode(decodeFrame(socket.sent[1] as Uint8Array).payload)) as { push: boolean };
    const results = (socket: FakeSocket) =>
      socket.sent
        .filter((m) => typeof m !== 'string')
        .map((m) => decodeFrame(m as Uint8Array))
        .filter((f) => f.type === FrameType.PushResult)
        .map((f) => decodePushResult(f.payload));

    it('is off without a service account: Ready says so and pushes are refused', async () => {
      const socket = await connect();
      await prove(socket);
      expect(ready(socket).push).toBe(false);
      await object.webSocketMessage(socket, push(1).slice().buffer);
      expect(results(socket)).toEqual(['disabled']);
    });

    it('is off with RELAY_PUSH=off even with a service account, and never calls FCM', async () => {
      const send = vi.fn(async () => 'sent' as const);
      object = wake({ FCM_SERVICE_ACCOUNT: fcm, RELAY_PUSH: 'off' }, send);
      const socket = await connect();
      await prove(socket);
      expect(ready(socket).push).toBe(false);
      await object.webSocketMessage(socket, push(1).slice().buffer);
      expect(results(socket)).toEqual(['disabled']);
      expect(send).not.toHaveBeenCalled();
    });

    it('keeps the push allowance across a reconnect, in storage (review M3)', async () => {
      const env = { FCM_SERVICE_ACCOUNT: fcm, RELAY_PUSH_BURST: '1', RELAY_PUSHES_PER_HOUR: '1' };
      const send = vi.fn(async () => 'sent' as const);
      object = wake(env, send);
      const first = await connect();
      await prove(first);
      await object.webSocketMessage(first, push(1).slice().buffer);
      await vi.advanceTimersByTimeAsync(0);
      object = wake(env, send);
      const second = await connect();
      await prove(second);
      await object.webSocketMessage(second, push(2).slice().buffer);
      await vi.advanceTimersByTimeAsync(0);
      expect(results(second)).toEqual(['rate_limited']);
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('asks the per-token gate (the token limiter object on Cloudflare)', async () => {
      const limiterState = new FakeState();
      const limiter = new TokenLimiterCore(limiterState.storage, { RELAY_PUSHES_PER_TOKEN_PER_HOUR: '6' }, () =>
        Date.now(),
      );
      const tokens: TokenGate = { take: async () => (await limiter.fetch()).status === 204 };
      const send = vi.fn(async () => 'sent' as const);
      object = wake({ FCM_SERVICE_ACCOUNT: fcm }, undefined, tokens);
      void send;
      const socket = await connect();
      await prove(socket);
      // The real FCM client would be used; the gate refuses the second push before it gets there.
      expect(await tokens.take('x')).toBe(true);
      expect(await tokens.take('x')).toBe(false);
      expect(limiterState.stored.has('bucket')).toBe(true);
    });

    it('keeps status pushes in an object of their own, with the status budget', async () => {
      const limiter = new TokenLimiterCore(new FakeState().storage, { RELAY_PUSHES_PER_TOKEN_PER_HOUR: '60' }, () =>
        Date.now(),
      );
      const take = async (path: string) => (await limiter.fetch({ url: `https://token-limiter${path}` })).status;
      expect(await take('/take-status')).toBe(204);
      expect(await take('/take-status')).toBe(429); // 2 per hour: burst 1
      const names: string[] = [];
      const gate = durableTokenGate({
        idFromName: (name) => (names.push(name), name),
        get: () => ({
          fetch: async (url: string) => new Response(null, { status: url.endsWith('/take-status') ? 204 : 429 }),
        }),
      });
      expect(await gate.take('device-token-0123456789abc', true)).toBe(true);
      expect(await gate.take('device-token-0123456789abc')).toBe(false);
      expect(names[0]).toMatch(/^status:/);
      expect(names[1]).not.toMatch(/^status:/);
    });

    it('delivers with a service account, and keeps the agent push budget across a hibernation', async () => {
      const env = { FCM_SERVICE_ACCOUNT: fcm, RELAY_PUSH_BURST: '1', RELAY_PUSHES_PER_HOUR: '1' };
      const send = vi.fn(async () => 'sent' as const);
      object = wake(env, send);
      const socket = await connect();
      await prove(socket);
      expect(ready(socket).push).toBe(true);
      expect(ready(socket).statusPush).toBe(true);
      await object.webSocketMessage(socket, push(1).slice().buffer);
      await vi.advanceTimersByTimeAsync(0);
      object = wake(env, send);
      await object.webSocketMessage(socket, push(2).slice().buffer);
      await vi.advanceTimersByTimeAsync(0);
      expect(results(socket)).toEqual(['sent', 'rate_limited']);
      expect(send).toHaveBeenCalledTimes(1);
    });
  });

  describe("dead man's switch", () => {
    const fcm = JSON.stringify({
      client_email: 'r@x.iam.gserviceaccount.com',
      private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
      project_id: 'kubernanny-test',
    });
    const MIN = 60_000;
    const held: DeadmanDeposit = {
      validitySeconds: 3 * 3600,
      holdSeconds: 0,
      items: [
        {
          token: 'device-token-0123456789:APA91b',
          platform: 'ios',
          kid: 'AbCdEfGhIjKlMnOp',
          message: toBase64Url(new Uint8Array(120)),
          graceMinutes: 15,
        },
      ],
    };
    const readyOf = (socket: FakeSocket) =>
      JSON.parse(new TextDecoder().decode(decodeFrame(socket.sent[1] as Uint8Array).payload)) as Record<
        string,
        unknown
      >;
    const depositResults = (socket: FakeSocket) =>
      socket.sent
        .filter((m): m is Uint8Array => typeof m !== 'string')
        .map((m) => decodeFrame(m))
        .filter((f) => f.type === FrameType.DepositResult)
        .map((f) => decodeDepositResult(f.payload));
    const setup = async (env: Record<string, string> = {}) => {
      const send = vi.fn<PushSender>(async () => 'sent');
      object = wake({ FCM_SERVICE_ACCOUNT: fcm, ...env }, send);
      const socket = await connect();
      await prove(socket);
      await object.webSocketMessage(socket, encodeDeposit(1, held).slice().buffer);
      await vi.advanceTimersByTimeAsync(0);
      return { send, socket };
    };

    it('says deadman in Ready, stores the deposit and checks on the agent every 5 minutes while it is connected', async () => {
      const { socket } = await setup();
      expect(readyOf(socket).deadman).toBe(true);
      expect(depositResults(socket)).toEqual(['stored']);
      expect(state.stored.get('deadman')).toMatchObject({
        items: [{ kid: 'AbCdEfGhIjKlMnOp', graceMs: 15 * MIN }],
        lostAt: null,
      });
      expect(state.alarm).toBe(5 * MIN);
    });

    it('is off with RELAY_DEADMAN=off and without push', async () => {
      object = wake(
        { FCM_SERVICE_ACCOUNT: fcm, RELAY_DEADMAN: 'off' },
        vi.fn<PushSender>(async () => 'sent'),
      );
      const socket = await connect();
      await prove(socket);
      expect(readyOf(socket).deadman).toBe(false);
      await object.webSocketMessage(socket, encodeDeposit(1, held).slice().buffer);
      await vi.advanceTimersByTimeAsync(0);
      expect(depositResults(socket)).toEqual(['disabled']);
    });

    it('fires once after the grace when the socket closes, across a hibernation, and reports it on the next Ready', async () => {
      const { send, socket } = await setup();
      state.heard.set(socket, 2 * MIN);
      vi.setSystemTime(3 * MIN);
      await object.webSocketClose(socket);
      expect(state.alarm).toBe(17 * MIN); // last heard + 15 min
      vi.setSystemTime(17 * MIN);
      object = wake({ FCM_SERVICE_ACCOUNT: fcm }, send);
      await object.alarm();
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]![0]).toMatchObject({ kid: 'AbCdEfGhIjKlMnOp', platform: 'ios' });
      expect(send.mock.calls[0]![0].silent).toBeUndefined();
      await object.alarm();
      expect(send).toHaveBeenCalledTimes(1);
      vi.setSystemTime(40 * MIN);
      const again = await connect();
      await prove(again);
      expect(readyOf(again).deadmanFired).toEqual({ k: ['AbCdEfGhIjKlMnOp'], m: 38 * MIN });
    });

    it('notices an agent that vanished without a close (no heartbeat past the idle timeout)', async () => {
      const { send, socket } = await setup();
      state.heard.set(socket, MIN);
      vi.setSystemTime(5 * MIN);
      await object.alarm();
      expect(socket.closed).toBe(4008);
      expect(state.alarm).toBe(16 * MIN);
      vi.setSystemTime(16 * MIN);
      await object.alarm();
      expect(send).toHaveBeenCalledTimes(1);
    });

    it('a handover within seconds sends nothing; the replaced socket does not arm it', async () => {
      const { send, socket } = await setup();
      const next = await connect();
      await prove(next); // the old socket is replaced
      await object.webSocketClose(socket);
      expect((state.stored.get('deadman') as { lostAt: number | null }).lostAt).toBeNull();
      await object.webSocketClose(next);
      vi.setSystemTime(5_000);
      const third = await connect();
      await prove(third);
      expect(readyOf(third).deadmanFired).toBeUndefined();
      vi.setSystemTime(60 * MIN);
      state.heard.set(third, 60 * MIN - 20_000); // its heartbeat
      await object.alarm();
      expect(send).not.toHaveBeenCalled();
      expect(state.alarm).toBe(65 * MIN);
    });

    it('never fires an expired deposit', async () => {
      const { send, socket } = await setup();
      await object.webSocketClose(socket);
      vi.setSystemTime(4 * 3600_000);
      await object.alarm();
      expect(send).not.toHaveBeenCalled();
      expect(state.alarm).toBeNull();
    });
  });
});
