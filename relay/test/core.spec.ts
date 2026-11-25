import { FrameType, MAX_SEALED_REQUEST, RelayClose, decodeFrame, encodeFrame, encodeReply, generateKeyPair, relayAgentId } from '@kubernanny/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLink, LinkSocket } from '../src/core/agent-link';
import { checkAgentReply, corsHeaders, parseRoute, pathOf, registrationOrigin, relayError, toBytes } from '../src/core/http';
import { BudgetHolder, ByteBudget, CallerLimiter, DEFAULT_LIMITS, RelayLimits, TokenBucket, clientAddress, parseLimits } from '../src/core/limits';
import { Admission } from '../src/core/admission';
import { parsePushConfig } from '../src/core/push';
import { endSession, newestRegistered, openSession, proveSession, registrationExpired } from '../src/core/session';
import { answerChallenge } from '@kubernanny/protocol';

describe('limits', () => {
  it('has fair-use defaults and reads RELAY_* overrides', () => {
    expect(parseLimits({})).toEqual(DEFAULT_LIMITS);
    const limits = parseLimits({ RELAY_MAX_AGENTS: '5', RELAY_CALL_TIMEOUT_MS: '1000', CORS_ORIGINS: 'https://a.example, capacitor://localhost' });
    expect(limits.maxAgents).toBe(5);
    expect(limits.callTimeoutMs).toBe(1000);
    expect(limits.corsOrigins).toEqual(['https://a.example', 'capacitor://localhost']);
  });

  it('fails on nonsense and never takes requests larger than one Noise message', () => {
    expect(() => parseLimits({ RELAY_MAX_AGENTS: 'many' })).toThrow(/RELAY_MAX_AGENTS/);
    expect(() => parseLimits({ RELAY_MAX_CONCURRENT: '0' })).toThrow(/positive/);
    expect(parseLimits({ RELAY_MAX_REQUEST_BYTES: '10000000' }).maxRequestBytes).toBe(MAX_SEALED_REQUEST);
  });

  it('refills a token bucket over time and lets a large charge go negative', () => {
    const bucket = new TokenBucket(2, 1 / 1000, 0);
    expect(bucket.take(1, 0)).toBe(true);
    expect(bucket.take(1, 0)).toBe(true);
    expect(bucket.take(1, 0)).toBe(false);
    expect(bucket.take(10, 1000)).toBe(true);
    expect(bucket.take(1, 5000)).toBe(false);
    expect(bucket.take(1, 20_000)).toBe(true);
  });
});

describe('token bucket state', () => {
  it('continues from a saved state instead of starting full', () => {
    const bucket = new TokenBucket(2, 1 / 1000, 0);
    bucket.take(5, 0);
    const restored = new TokenBucket(2, 1 / 1000, 1000, bucket.state());
    expect(restored.take(1, 1000)).toBe(false); // -3 + 1 refilled
    expect(restored.take(1, 4000)).toBe(true);
  });

  it('never restores more than the capacity, and ignores a broken state', () => {
    expect(new TokenBucket(2, 0, 0, { tokens: 100, at: 0 }).state().tokens).toBe(2);
    expect(new TokenBucket(2, 0, 0, { tokens: Number.NaN, at: 0 }).state().tokens).toBe(2);
  });
});

describe('routes and CORS', () => {
  const id = relayAgentId(generateKeyPair().publicKey);

  it('knows exactly three routes, and only real agent ids', () => {
    expect(parseRoute(`/v1/agents/${id}/e2e`)).toEqual({ kind: 'call', agentId: id });
    expect(parseRoute(`/v1/agents/${id}/ws`)).toEqual({ kind: 'connect', agentId: id });
    expect(parseRoute('/healthz')).toEqual({ kind: 'health' });
    expect(parseRoute('/v1/agents/short/e2e')).toBeNull();
    expect(parseRoute(`/v1/agents/${id}/e2e/x`)).toBeNull();
    expect(parseRoute(`/v2/agents/${id}/e2e`)).toBeNull();
  });

  it('answers with plain JSON codes', () => {
    expect(relayError('RELAY_AGENT_OFFLINE')).toEqual({ status: 503, body: '{"code":"RELAY_AGENT_OFFLINE"}' });
    expect(relayError('RELAY_TOO_LARGE').status).toBe(413);
    expect(relayError('RELAY_RATE_LIMITED').status).toBe(429);
    expect(relayError('RELAY_TIMEOUT').status).toBe(504);
  });

  it('allows any origin by default and only listed ones otherwise', () => {
    expect(corsHeaders('https://x.example', ['*'])['access-control-allow-origin']).toBe('*');
    expect(corsHeaders('capacitor://localhost', ['capacitor://localhost'])['access-control-allow-origin']).toBe('capacitor://localhost');
    expect(corsHeaders('https://evil.example', ['capacitor://localhost'])['access-control-allow-origin']).toBeUndefined();
  });
});

describe('AgentLink', () => {
  let sent: Uint8Array[];
  let closed: number[];
  let socket: LinkSocket;
  let now: number;
  const limits: RelayLimits = { ...DEFAULT_LIMITS, maxConcurrent: 2, callBurst: 3, callsPerMinute: 60, maxResponseBytes: 1000, callTimeoutMs: 1000 };

  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    closed = [];
    now = 0;
    socket = { send: (b, done) => (sent.push(b), done?.()), close: (code) => closed.push(code) };
  });
  afterEach(() => vi.useRealTimers());

  const link = (overrides: Partial<RelayLimits> = {}) => new AgentLink(socket, { ...limits, ...overrides }, { now: () => now });
  const lastCall = () => decodeFrame(sent.at(-1)!);

  it('forwards the body and resolves with the reassembled reply', async () => {
    const l = link();
    const pending = l.call(Uint8Array.of(1, 2, 3));
    const call = lastCall();
    expect(call.type).toBe(FrameType.Call);
    expect(call.payload).toEqual(Uint8Array.of(1, 2, 3));
    const body = new Uint8Array(700).map((_, i) => i & 0xff);
    for (const frame of encodeReply(call.callId, 200, body, 256)) {
      l.onFrame(decodeFrame(frame));
    }
    expect(await pending).toEqual({ kind: 'reply', status: 200, body });
    expect(l.inFlight).toBe(0);
  });

  it('keeps calls apart by id, answered in any order', async () => {
    const l = link();
    const a = l.call(Uint8Array.of(1));
    const idA = lastCall().callId;
    const b = l.call(Uint8Array.of(2));
    const idB = lastCall().callId;
    expect(idA).not.toBe(idB);
    const limited = new TextEncoder().encode('{"code":"E2E_RATE_LIMITED"}');
    l.onFrame(decodeFrame(encodeReply(idB, 429, limited)[0]!));
    l.onFrame(decodeFrame(encodeReply(idA, 200, Uint8Array.of(65))[0]!));
    expect(await a).toEqual({ kind: 'reply', status: 200, body: Uint8Array.of(65) });
    expect(await b).toEqual({ kind: 'reply', status: 429, body: limited });
  });

  it('refuses past the concurrency cap and the call rate', async () => {
    const l = link();
    void l.call(Uint8Array.of(1));
    void l.call(Uint8Array.of(1));
    expect(await l.call(Uint8Array.of(1))).toEqual({ kind: 'error', code: 'RELAY_RATE_LIMITED' });
    const r = link({ maxConcurrent: 100 });
    for (let i = 0; i < 3; i++) {
      void r.call(Uint8Array.of(1));
    }
    expect(await r.call(Uint8Array.of(1))).toEqual({ kind: 'error', code: 'RELAY_RATE_LIMITED' });
    now += 1000; // one call per second refills
    expect(r.call(Uint8Array.of(1))).not.toBeNull();
    expect(r.inFlight).toBe(4);
  });

  it('refuses an oversized request without sending it', async () => {
    expect(await link().call(new Uint8Array(70_000))).toEqual({ kind: 'error', code: 'RELAY_TOO_LARGE' });
    expect(sent).toHaveLength(0);
  });

  it('times out, tells the agent, and drops the late answer', async () => {
    const l = link();
    const pending = l.call(Uint8Array.of(1));
    const id = lastCall().callId;
    vi.advanceTimersByTime(1000);
    expect(await pending).toEqual({ kind: 'error', code: 'RELAY_TIMEOUT' });
    expect(decodeFrame(sent.at(-1)!)).toEqual({ type: FrameType.Cancel, callId: id, payload: new Uint8Array(0) });
    l.onFrame(decodeFrame(encodeReply(id, 200, Uint8Array.of(1))[0]!));
    expect(l.inFlight).toBe(0);
  });

  it('stops an answer larger than the limit and cancels it', async () => {
    const l = link();
    const pending = l.call(Uint8Array.of(1));
    const id = lastCall().callId;
    l.onFrame(decodeFrame(encodeFrame(FrameType.ReplyChunk, id, new Uint8Array(1001))));
    expect(await pending).toEqual({ kind: 'error', code: 'RELAY_RESPONSE_TOO_LARGE' });
    expect(lastCall().type).toBe(FrameType.Cancel);
  });

  it('closes the socket on a malformed reply and fails every waiting call', async () => {
    const l = link();
    const a = l.call(Uint8Array.of(1));
    const id = lastCall().callId;
    const b = l.call(Uint8Array.of(1));
    l.onFrame({ type: FrameType.ReplyEnd, callId: id, payload: Uint8Array.of(0) });
    expect(closed).toEqual([RelayClose.Protocol]);
    expect(await a).toEqual({ kind: 'error', code: 'RELAY_AGENT_OFFLINE' });
    expect(await b).toEqual({ kind: 'error', code: 'RELAY_AGENT_OFFLINE' });
    expect(await l.call(Uint8Array.of(1))).toEqual({ kind: 'error', code: 'RELAY_AGENT_OFFLINE' });
  });

  it('charges response bytes to the hourly budget', async () => {
    const l = link({ bytesPerHour: 100, maxConcurrent: 10, callBurst: 10 });
    const pending = l.call(Uint8Array.of(1));
    l.onFrame(decodeFrame(encodeReply(lastCall().callId, 200, new Uint8Array(500))[0]!));
    await pending;
    expect(await l.call(Uint8Array.of(1))).toEqual({ kind: 'error', code: 'RELAY_RATE_LIMITED' });
  });
});

describe('security review regressions (relay core)', () => {
  const text = (s: string) => new TextEncoder().encode(s);

  it('C1: refuses request targets that are not a plain path instead of parsing them as URLs', () => {
    expect(pathOf('http://[')).toBeNull();
    expect(pathOf('http://a:99999/v1')).toBeNull();
    expect(pathOf('%')).toBeNull();
    expect(pathOf(undefined)).toBeNull();
    expect(pathOf('/v1/agents/x/ws?y=1')).toBe('/v1/agents/x/ws');
    expect(pathOf(`/${'a'.repeat(3000)}`)).toBeNull();
  });

  it('hardening: passes on only 200 or a plain E2E refusal, rebuilt by the relay', () => {
    expect(checkAgentReply(200, Uint8Array.of(1))).toEqual({ status: 200, body: Uint8Array.of(1) });
    expect(checkAgentReply(429, text('{"code":"E2E_RATE_LIMITED","x":"<script>"}'))).toEqual({ status: 429, body: text('{"code":"E2E_RATE_LIMITED"}') });
    for (const status of [100, 101, 204, 301, 304, 401, 500]) {
      expect(checkAgentReply(status, text('{"code":"E2E_X"}'))).toBeNull();
    }
    expect(checkAgentReply(400, text('<script>alert(1)</script>'))).toBeNull();
    expect(checkAgentReply(400, text('{"code":"<b>"}'))).toBeNull();
    expect(checkAgentReply(503, new Uint8Array(1000))).toBeNull();
  });

  it('H2: reads the client address from a trusted proxy header only when configured', () => {
    const headers = { 'x-forwarded-for': '6.6.6.6, 10.0.0.1', 'cf-connecting-ip': '7.7.7.7' };
    expect(clientAddress(headers, '10.0.0.9', '')).toBe('10.0.0.9');
    expect(clientAddress(headers, '10.0.0.9', 'x-forwarded-for')).toBe('10.0.0.1');
    expect(clientAddress(headers, '10.0.0.9', 'cf-connecting-ip')).toBe('7.7.7.7');
    expect(clientAddress({}, '10.0.0.9', 'cf-connecting-ip')).toBe('10.0.0.9');
    expect(() => parseLimits({ TRUST_PROXY: 'x-anything' })).toThrow(/TRUST_PROXY/);
    expect(parseLimits({}).registerTimeoutMs).toBeLessThanOrEqual(3000);
  });
});

describe('security review regressions (H1: memory held for answers)', () => {
  let sent: Uint8Array[];
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
  });
  afterEach(() => vi.useRealTimers());
  const socket: LinkSocket = { send: (b, done) => (sent.push(b), done?.()), close: () => undefined };
  const limits: RelayLimits = { ...DEFAULT_LIMITS, maxResponseBytes: 1000, maxConcurrent: 8, callBurst: 100 };
  const text = (s: string) => new TextEncoder().encode(s);
  const chunk = (callId: number, n: number) => decodeFrame(encodeFrame(FrameType.ReplyChunk, callId, new Uint8Array(n)));

  it('caps answer bytes held across all agents, and gives them back when a call ends', async () => {
    const budget = new ByteBudget(1500);
    const a = new AgentLink(socket, limits, { parent: budget });
    const b = new AgentLink(socket, limits, { parent: budget });
    const pa = a.call(Uint8Array.of(1));
    const ida = decodeFrame(sent.at(-1)!).callId;
    const pb = b.call(Uint8Array.of(1));
    const idb = decodeFrame(sent.at(-1)!).callId;
    a.onFrame(chunk(ida, 900));
    b.onFrame(chunk(idb, 900)); // never sent ReplyEnd: would be held until the timeout
    expect(await pb).toEqual({ kind: 'error', code: 'RELAY_BUSY' });
    expect(decodeFrame(sent.at(-1)!).type).toBe(FrameType.Cancel);
    expect(budget.inUse).toBe(900);
    vi.advanceTimersByTime(limits.callTimeoutMs);
    expect(await pa).toEqual({ kind: 'error', code: 'RELAY_TIMEOUT' });
    expect(budget.inUse).toBe(0);
  });

  it('stops an answer mid-stream when the agent byte budget runs out', async () => {
    const link = new AgentLink(socket, { ...limits, bytesPerHour: 500 }, { now: () => 0 });
    const pending = link.call(Uint8Array.of(1));
    const id = decodeFrame(sent.at(-1)!).callId;
    link.onFrame(chunk(id, 600));
    link.onFrame(chunk(id, 10));
    expect(await pending).toEqual({ kind: 'error', code: 'RELAY_RATE_LIMITED' });
  });

  it('refuses an answer with a status the relay does not pass on', async () => {
    const link = new AgentLink(socket, limits);
    const pending = link.call(Uint8Array.of(1));
    link.onFrame(decodeFrame(encodeReply(decodeFrame(sent.at(-1)!).callId, 301, text('x'))[0]!));
    expect(await pending).toEqual({ kind: 'error', code: 'RELAY_BAD_AGENT_RESPONSE' });
  });

  it('keeps the worst case per agent within the documented sizing', () => {
    expect(DEFAULT_LIMITS.maxConcurrent * DEFAULT_LIMITS.maxResponseBytes).toBeLessThanOrEqual(DEFAULT_LIMITS.maxInflightBytes);
    expect(DEFAULT_LIMITS.maxInflightBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
  });
});

describe('security re-review regressions (R1: fair shares of the answer budget)', () => {
  let sent: Uint8Array[];
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
  });
  afterEach(() => vi.useRealTimers());
  const socket: LinkSocket = { send: (b, done) => (sent.push(b), done?.()), close: () => undefined };
  const chunk = (callId: number, n: number) => decodeFrame(encodeFrame(FrameType.ReplyChunk, callId, new Uint8Array(n)));
  const lastId = () => decodeFrame(sent.at(-1)!).callId;

  it('nests budgets: a reservation must fit the agent, its address and the relay', () => {
    const total = new ByteBudget(100);
    const address = new ByteBudget(60, total);
    expect(address.reserve(50)).toBe(true);
    expect(address.reserve(20)).toBe(false);
    expect(total.inUse).toBe(50);
    address.release(50);
    expect(total.inUse).toBe(0);
  });

  it('gives one agent only its share of the relay budget', async () => {
    const limits: RelayLimits = { ...DEFAULT_LIMITS, maxInflightBytes: 4000, inflightShare: 0.25, maxResponseBytes: 1000, maxConcurrent: 8, callBurst: 100 };
    const total = new ByteBudget(limits.maxInflightBytes);
    const hog = new AgentLink(socket, limits, { parent: total });
    const first = hog.call(Uint8Array.of(1));
    const firstId = lastId();
    const calls = [first, hog.call(Uint8Array.of(1))];
    const ids = [firstId, lastId()];
    hog.onFrame(chunk(ids[0]!, 900));
    hog.onFrame(chunk(ids[1]!, 900)); // 1800 > its share of 1000
    expect(await calls[1]).toEqual({ kind: 'error', code: 'RELAY_BUSY' });
    expect(total.inUse).toBe(900);
    void calls[0];
  });

  it('makes the largest unfinished answer give way to a smaller one', async () => {
    const total = new ByteBudget(2000);
    const limits: RelayLimits = { ...DEFAULT_LIMITS, maxInflightBytes: 2000, inflightShare: 1, maxResponseBytes: 2000, callBurst: 100 };
    const hog = new AgentLink(socket, limits, { parent: total });
    const legit = new AgentLink(socket, limits, { parent: total });
    const held = hog.call(Uint8Array.of(1));
    hog.onFrame(chunk(lastId(), 1900));
    const small = legit.call(Uint8Array.of(1));
    legit.onFrame(decodeFrame(encodeReply(lastId(), 200, new Uint8Array(500))[0]!));
    expect(await small).toEqual({ kind: 'reply', status: 200, body: new Uint8Array(500) });
    expect(await held).toEqual({ kind: 'error', code: 'RELAY_BUSY' });
    expect(total.inUse).toBe(0);
  });

  it('cancels an answer that stops making progress, and gives its bytes back', async () => {
    const total = new ByteBudget(DEFAULT_LIMITS.maxInflightBytes);
    const link = new AgentLink(socket, DEFAULT_LIMITS, { parent: total });
    const pending = link.call(Uint8Array.of(1));
    const id = lastId();
    link.onFrame(chunk(id, 1000));
    expect(total.inUse).toBe(1000);
    vi.advanceTimersByTime(DEFAULT_LIMITS.progressTimeoutMs);
    expect(await pending).toEqual({ kind: 'error', code: 'RELAY_TIMEOUT' });
    expect(decodeFrame(sent.at(-1)!)).toMatchObject({ type: FrameType.Cancel, callId: id });
    expect(total.inUse).toBe(0);
  });

  it('ends a started answer at the stream timeout even if parts keep trickling in', async () => {
    const link = new AgentLink(socket, DEFAULT_LIMITS);
    const pending = link.call(Uint8Array.of(1));
    const id = lastId();
    for (let t = 0; t < DEFAULT_LIMITS.streamTimeoutMs; t += 2000) {
      link.onFrame(chunk(id, 10));
      vi.advanceTimersByTime(2000);
    }
    expect(await pending).toEqual({ kind: 'error', code: 'RELAY_TIMEOUT' });
  });

  it('keeps the slow wait for an agent that has not started answering', async () => {
    const link = new AgentLink(socket, DEFAULT_LIMITS);
    const pending = link.call(Uint8Array.of(1));
    const id = lastId();
    vi.advanceTimersByTime(DEFAULT_LIMITS.callTimeoutMs - 1000);
    link.onFrame(decodeFrame(encodeReply(id, 200, Uint8Array.of(7))[0]!));
    expect(await pending).toEqual({ kind: 'reply', status: 200, body: Uint8Array.of(7) });
  });
});

describe('second security review (relay core)', () => {
  let sent: Uint8Array[];
  let buffered: number;
  let open: boolean;
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    buffered = 0;
    open = true;
  });
  afterEach(() => vi.useRealTimers());
  const socket = (): LinkSocket => ({ send: (b, done) => (sent.push(b), done?.()), close: () => undefined, bufferedAmount: () => buffered, isOpen: () => open });
  const calls = () => sent.map(decodeFrame).filter((f) => f.type === FrameType.Call);

  it('H1: refuses calls with RELAY_BUSY while the agent does not read what it was sent', async () => {
    const link = new AgentLink(socket(), { ...DEFAULT_LIMITS, callBurst: 10_000, callsPerMinute: 1_000_000, maxConcurrent: 4 });
    const body = new Uint8Array(64 * 1024);
    void link.call(body);
    buffered = DEFAULT_LIMITS.maxSocketBufferBytes; // what the socket says it still holds for the agent
    expect(await link.call(body)).toEqual({ kind: 'error', code: 'RELAY_BUSY' });
    expect(calls()).toHaveLength(1);
  });

  it('H1: counts request bytes in the budgets until the call is answered or times out', async () => {
    const total = new ByteBudget(DEFAULT_LIMITS.maxInflightBytes);
    const link = new AgentLink(socket(), DEFAULT_LIMITS, { parent: total });
    const pending = link.call(new Uint8Array(1000));
    expect(total.inUse).toBe(1000);
    vi.advanceTimersByTime(DEFAULT_LIMITS.callTimeoutMs);
    expect(await pending).toEqual({ kind: 'error', code: 'RELAY_TIMEOUT' });
    expect(total.inUse).toBe(0);
    const answered = link.call(new Uint8Array(1000));
    link.onFrame(decodeFrame(encodeReply(calls().at(-1)!.callId, 200, new Uint8Array(10))[0]!));
    await answered;
    expect(total.inUse).toBe(0);
  });

  it('H1: a call frame the socket still queues holds its bytes, even after the call timed out', async () => {
    const total = new ByteBudget(DEFAULT_LIMITS.maxInflightBytes);
    const callbacks: (() => void)[] = [];
    const slow: LinkSocket = { send: (_b, done) => void (done && callbacks.push(done)), close: () => undefined };
    const flush = () => callbacks.splice(0).forEach((done) => done());
    const link = new AgentLink(slow, DEFAULT_LIMITS, { parent: total });
    const pending = link.call(new Uint8Array(1000));
    expect(total.inUse).toBe(2005); // the request, and its frame in the queue
    vi.advanceTimersByTime(DEFAULT_LIMITS.callTimeoutMs);
    await pending;
    expect(total.inUse).toBe(1005);
    flush();
    expect(total.inUse).toBe(0);
  });

  it('H1: call ids are random, so an agent cannot answer calls it never read', async () => {
    const link = new AgentLink(socket(), { ...DEFAULT_LIMITS, maxConcurrent: 64, callBurst: 64 });
    for (let i = 0; i < 32; i++) {
      void link.call(Uint8Array.of(1));
    }
    const ids = calls().map((f) => f.callId);
    expect(new Set(ids).size).toBe(32);
    const sequential = ids.slice(1).filter((id, i) => id === ids[i]! + 1).length;
    expect(sequential).toBeLessThan(3);
    // The old sequential guess (2, 3, …) answers nothing.
    for (let id = 1; id < 40; id++) {
      link.onFrame(decodeFrame(encodeReply(id, 200, Uint8Array.of(1))[0]!));
    }
    expect(link.inFlight).toBe(32 - ids.filter((id) => id < 40).length);
  });

  it('M1: one calling address gets only its share of the agent buckets, and junk never drives a bucket negative', async () => {
    const limits: RelayLimits = { ...DEFAULT_LIMITS, callBurst: 8, callsPerMinute: 8, callerShare: 0.25, maxConcurrent: 100 };
    const link = new AgentLink(socket(), limits, { now: () => 0 });
    expect(await Promise.race([link.call(Uint8Array.of(1), 'junk'), Promise.resolve('pending')])).toBe('pending');
    void link.call(Uint8Array.of(1), 'junk');
    expect(await link.call(Uint8Array.of(1), 'junk')).toEqual({ kind: 'error', code: 'RELAY_RATE_LIMITED' });
    expect(await Promise.race([link.call(Uint8Array.of(1), 'owner'), Promise.resolve('pending')])).toBe('pending');
    const bucket = new TokenBucket(10, 0, 0);
    expect(bucket.takeExact(11, 0)).toBe(false);
    expect(bucket.state().tokens).toBe(10);
    const callers = new CallerLimiter(limits, 2);
    callers.charge('a', 1, 0);
    callers.charge('b', 1, 0);
    callers.charge('c', 1, 0);
    expect(callers.size).toBe(2);
  });

  it('counts IPv6 callers per /64: rotating addresses neither gets a fresh share nor pushes other callers out', () => {
    const limits: RelayLimits = { ...DEFAULT_LIMITS, callBurst: 10, callsPerMinute: 10, callerShare: 0.5 };
    const callers = new CallerLimiter(limits, 256);
    callers.charge('203.0.113.7', 1, 0);
    // 5 calls of the /64's share of 5, each from another address of it.
    for (let i = 0; i < 5; i++) {
      expect(callers.allows(`2001:db8:1:2::${(i + 1).toString(16)}`, 1, 0)).toBe(true);
      callers.charge(`2001:db8:1:2:${i}::1`, 1, 0);
    }
    expect(callers.allows('2001:db8:1:2:ffff:ffff:ffff:ffff', 1, 0)).toBe(false);
    for (let i = 0; i < 1_000; i++) {
      callers.charge(`2001:db8:1:2::${i.toString(16)}`, 1, 0);
    }
    // One entry for the whole /64, so the IPv4 caller is still remembered (and still has its share).
    expect(callers.size).toBe(2);
    expect(callers.allows('203.0.113.7', 1, 0)).toBe(true);
    // Another /64 is another caller.
    expect(callers.allows('2001:db8:1:3::1', 1, 0)).toBe(true);
  });

  it('L4: a refused byte check leaves the call bucket untouched', async () => {
    const limits: RelayLimits = { ...DEFAULT_LIMITS, callBurst: 1, callsPerMinute: 1, bytesPerHour: 10 };
    const link = new AgentLink(socket(), limits, { now: () => 0 });
    expect(await link.call(new Uint8Array(100))).toEqual({ kind: 'error', code: 'RELAY_RATE_LIMITED' });
    expect(await Promise.race([link.call(Uint8Array.of(1)), Promise.resolve('pending')])).toBe('pending');
  });

  it('L4: evicts only when the reservation then succeeds at every level', () => {
    const parent = new ByteBudget(100);
    const child = new ByteBudget(100, parent);
    const evicted: string[] = [];
    const holder = (name: string, bytes: number): BudgetHolder => {
      const h: BudgetHolder = { evict: () => (evicted.push(name), child.release(bytes, h)) };
      return h;
    };
    expect(child.reserve(40, holder('big', 40))).toBe(true);
    expect(parent.reserve(55)).toBe(true); // held by nobody: cannot be evicted
    expect(child.reserve(50, holder('larger', 50))).toBe(false); // big is smaller than the request: no victim
    expect(evicted).toEqual([]);
    expect(child.reserve(10, holder('small', 10))).toBe(true); // big gives way, and the parent has room after it
    expect(evicted).toEqual(['big']);
  });

  it('L5: a closing socket gets RELAY_AGENT_OFFLINE at once, without a send', async () => {
    const link = new AgentLink(socket(), DEFAULT_LIMITS);
    open = false;
    expect(await link.call(Uint8Array.of(1))).toEqual({ kind: 'error', code: 'RELAY_AGENT_OFFLINE' });
    expect(sent).toHaveLength(0);
  });
});

describe('registration sessions (shared by the Node relay and the Worker)', () => {
  const keys = generateKeyPair();
  const agentId = relayAgentId(keys.publicKey);

  it('registers once with a proof for this relay, and ends on a wrong origin', () => {
    const { session, challenge } = openSession(agentId, 'https://relay.example', 0);
    const proof = answerChallenge(keys, decodeFrame(challenge).payload, 'wss://relay.example');
    const done = proveSession(session, proof, 5);
    expect(done.outcome).toEqual({ ok: true });
    expect(done.session).toMatchObject({ phase: 'registered', registeredAt: 5 });
    expect(proveSession(done.session, proof, 6).outcome).toBeNull();
    const other = openSession(agentId, 'https://relay.example', 0);
    const elsewhere = proveSession(other.session, answerChallenge(keys, decodeFrame(other.challenge).payload, 'wss://other.example'), 1);
    expect(elsewhere.outcome).toMatchObject({ ok: false, close: RelayClose.ProofFailed });
    expect(elsewhere.session.phase).toBe('ended');
  });

  it('L1: the newest registration wins, and an ended one never counts', () => {
    const a = { session: { phase: 'registered' as const, agentId, since: 0, registeredAt: 10 } };
    const b = { session: { phase: 'registered' as const, agentId, since: 5, registeredAt: 20 } };
    expect(newestRegistered([b, a], (x) => x.session)).toBe(b);
    expect(newestRegistered([{ session: endSession(b.session) }, a], (x) => x.session)).toBe(a);
    expect(registrationExpired(openSession(agentId, 'https://r', 0).session, 3000, 3000)).toBe(true);
  });

  it('L3: takes the configured origin, else only a loopback Host', () => {
    expect(registrationOrigin('https://relay.example', 'evil.example')).toBe('https://relay.example');
    expect(registrationOrigin(null, '127.0.0.1:8080')).toBe('http://127.0.0.1:8080');
    expect(registrationOrigin(null, 'relay.example')).toBeNull();
    expect(registrationOrigin(null, undefined)).toBeNull();
  });

  it('has one toBytes for every message shape', () => {
    expect(toBytes(Uint8Array.of(1, 2).buffer)).toEqual(Uint8Array.of(1, 2));
    expect(toBytes([Uint8Array.of(1), Uint8Array.of(2, 3)])).toEqual(Uint8Array.of(1, 2, 3));
    expect(toBytes(Uint8Array.of(9, 8).subarray(1))).toEqual(Uint8Array.of(8));
  });
});

describe('Admission (per-address rules of the Node relay)', () => {
  const push = parsePushConfig({});
  const limits: RelayLimits = { ...DEFAULT_LIMITS, maxAgentsPerIp: 2, maxPendingPerIp: 1, maxAgents: 3 };

  it('caps pending and registered connections per address, and names the largest address when full', () => {
    const admission = new Admission<string>(limits, null, 0);
    expect(admission.refuseConnect('a', 0)).toBeNull();
    admission.addPending('a');
    expect(admission.refuseConnect('a', 0)).toBe('full');
    admission.removePending('a');
    admission.join('a', 'a1');
    admission.join('a', 'a2');
    expect(admission.refuseConnect('a', 2)).toBe('full');
    admission.join('b', 'b1');
    expect(admission.largest()).toEqual(['a1', 2]);
    expect(admission.refuseConnect('c', 3)).toBeNull(); // a newcomer may displace one of a's
    admission.leave('a', 'a1');
    admission.leave('a', 'a2');
    expect(admission.agentsOf('a')).toBe(0);
  });

  it('M3: keeps an agent id push allowance across a reconnect for an hour, then forgets it', () => {
    const admission = new Admission<string>(limits, { ...push, enabled: true, agentBurst: 2 }, 0);
    const first = admission.pushPolicy('id', 0)!;
    first.charge('t', 0);
    first.charge('t', 0);
    admission.pushPolicyLeft('id', 0);
    expect(admission.pushPolicy('id', 1000)).toBe(first);
    expect(first.allows('t', 1000)).toBe(false);
    admission.pushPolicyLeft('id', 1000);
    admission.prune(1000 + 3_600_000);
    expect(admission.rememberedPushPolicies).toBe(0);
  });

  it('M3: bounds pushes per address and for the whole relay', () => {
    const admission = new Admission<string>(limits, { ...push, enabled: true, addressPerHour: 6, relayPerHour: 12 }, 0);
    admission.join('a', 'a1');
    admission.join('b', 'b1');
    const a = admission.pushGate('a');
    const b = admission.pushGate('b');
    expect(a.allows(0)).toBe(true);
    a.charge(0); // burst of a sixth: 1 for the address
    expect(a.allows(0)).toBe(false);
    b.charge(0); // the relay's burst of 2 is now used up as well
    admission.join('c', 'c1');
    expect(admission.pushGate('c').allows(0)).toBe(false);
  });
});
