import {
  DeadmanDeposit,
  decodeDepositResult,
  decodeFrame,
  encodeDeposit,
  FrameType,
  PushRequest,
  toBase64Url,
} from '@kubernanny/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentLink, LinkSocket } from '../src/core/agent-link';
import {
  agentBack,
  agentLost,
  DeadmanConfig,
  DEFAULT_DEADMAN,
  depositInto,
  dueItems,
  emptyDeadman,
  expire,
  markSent,
  nextWake,
  parseDeadmanConfig,
} from '../src/core/deadman';
import { DEFAULT_LIMITS } from '../src/core/limits';
import { DeadmanRegistry } from '../src/deadman-registry';

const MIN = 60_000;
const config: DeadmanConfig = { enabled: true, ...DEFAULT_DEADMAN };
const item = (kid: string, graceMinutes = 15, token = `dGVzdC10b2tlbi1mb3ItZmNt:${kid}`) => ({
  token,
  platform: 'android' as const,
  kid,
  message: toBase64Url(new Uint8Array(200).fill(7)),
  graceMinutes,
});
const deposit = (items = [item('AAAAAAAAAAAAAAAA')], validitySeconds = 3 * 3600, holdSeconds = 0): DeadmanDeposit => ({
  validitySeconds,
  holdSeconds,
  items,
});

describe('dead man configuration', () => {
  it('is on wherever push is on, RELAY_DEADMAN=off turns it off, limits come from the environment', () => {
    expect(parseDeadmanConfig({}, true)).toMatchObject({
      enabled: true,
      maxItems: 8,
      maxMessageChars: 1024,
      depositsPerHour: 30,
    });
    expect(parseDeadmanConfig({}, false).enabled).toBe(false);
    expect(parseDeadmanConfig({ RELAY_DEADMAN: 'off' }, true).enabled).toBe(false);
    expect(parseDeadmanConfig({ RELAY_DEADMAN_MAX_DEPOSITS: '3', RELAY_DEADMAN_MAX_BYTES: '512' }, true)).toMatchObject(
      { maxItems: 3, maxMessageChars: 512 },
    );
    expect(() => parseDeadmanConfig({ RELAY_DEADMAN: 'maybe' }, true)).toThrow(/RELAY_DEADMAN/);
    expect(() => parseDeadmanConfig({ RELAY_DEADMAN_MAX_BYTES: '10' }, true)).toThrow(/RELAY_DEADMAN_MAX_BYTES/);
  });
});

describe('dead man rules', () => {
  it('stores a deposit, replaces it with the next one, and refuses what is over the limits', () => {
    let { state, outcome } = depositInto(emptyDeadman(), deposit(), config, 0);
    expect(outcome).toBe('stored');
    expect(state.items).toHaveLength(1);
    expect(state.expiresAt).toBe(3 * 3600_000);
    ({ state, outcome } = depositInto(
      state,
      deposit([item('BBBBBBBBBBBBBBBB'), item('CCCCCCCCCCCCCCCC', 60)]),
      config,
      1000,
    ));
    expect(outcome).toBe('stored');
    expect(state.items.map((i) => i.kid)).toEqual(['BBBBBBBBBBBBBBBB', 'CCCCCCCCCCCCCCCC']);
    expect(depositInto(state, null, config, 2000).outcome).toBe('invalid');
    expect(
      depositInto(state, deposit(Array.from({ length: 9 }, (_, i) => item(`${i}`.padEnd(16, 'x')))), config, 2000)
        .outcome,
    ).toBe('invalid');
    expect(
      depositInto(state, deposit([item('AAAAAAAAAAAAAAAA'), item('AAAAAAAAAAAAAAAA')]), config, 2000).outcome,
    ).toBe('invalid');
    expect(
      depositInto(state, deposit([{ ...item('DDDDDDDDDDDDDDDD'), message: 'A'.repeat(1025) }]), config, 2000).outcome,
    ).toBe('invalid');
    expect(depositInto(state, deposit(), { ...config, enabled: false }, 2000).outcome).toBe('disabled');
    // A refused deposit keeps the previous one.
    const larger = deposit([item('EEEEEEEEEEEEEEEE'), item('FFFFFFFFFFFFFFFF'), item('GGGGGGGGGGGGGGGG')]);
    expect(depositInto(state, larger, config, 2000, 0).outcome).toBe('full');
    expect(depositInto(state, larger, config, 2000, 0).state.items).toHaveLength(2);
  });

  it('limits deposits per hour, and the allowance outlives a reconnect (it is in the state)', () => {
    let state = emptyDeadman();
    const outcomes = Array.from({ length: 12 }, () => {
      const r = depositInto(state, deposit(), config, 0);
      state = r.state;
      return r.outcome;
    });
    expect(outcomes.filter((o) => o === 'stored')).toHaveLength(10);
    expect(outcomes.at(-1)).toBe('rate_limited');
    state = agentBack(agentLost(state, 0), 1).state;
    expect(depositInto(state, deposit(), config, 1).outcome).toBe('rate_limited');
    expect(depositInto(state, deposit(), config, 3 * MIN).outcome).toBe('stored');
  });

  it('sends each message once its grace has passed since the agent was last heard, within the validity', () => {
    let state = depositInto(
      emptyDeadman(),
      deposit([item('AAAAAAAAAAAAAAAA', 10), item('BBBBBBBBBBBBBBBB', 30)]),
      config,
      0,
    ).state;
    expect(dueItems(state, 20 * MIN)).toEqual([]); // still connected
    state = agentLost(state, 5 * MIN);
    expect(nextWake(state)).toBe(15 * MIN);
    expect(dueItems(state, 14 * MIN)).toEqual([]);
    const first = dueItems(state, 15 * MIN);
    expect(first.map((i) => i.kid)).toEqual(['AAAAAAAAAAAAAAAA']);
    state = markSent(state, first);
    expect(dueItems(state, 16 * MIN)).toEqual([]);
    expect(nextWake(state)).toBe(35 * MIN);
    state = markSent(state, dueItems(state, 35 * MIN));
    const { state: back, fired } = agentBack(state, 65 * MIN);
    expect(fired).toEqual({ k: ['AAAAAAAAAAAAAAAA', 'BBBBBBBBBBBBBBBB'], m: 60 * MIN });
    expect(back.lostAt).toBeNull();
    expect(agentBack(back, 70 * MIN).fired).toBeNull();
  });

  it('a second report of the same absence keeps the first time; a return before the grace sends and reports nothing', () => {
    let state = agentLost(depositInto(emptyDeadman(), deposit(), config, 0).state, MIN);
    state = agentLost(state, 9 * MIN);
    expect(state.lostAt).toBe(MIN);
    const { state: back, fired } = agentBack(state, 10 * MIN);
    expect(fired).toBeNull();
    expect(dueItems(back, 60 * MIN)).toEqual([]);
  });

  it('waits out a hold (a maintenance window on the agent) before the grace starts', () => {
    const state = agentLost(
      depositInto(emptyDeadman(), deposit([item('AAAAAAAAAAAAAAAA', 15)], 6 * 3600, 3600), config, 0).state,
      MIN,
    );
    expect(dueItems(state, 70 * MIN)).toEqual([]);
    expect(nextWake(state)).toBe(75 * MIN);
    expect(dueItems(state, 75 * MIN)).toHaveLength(1);
  });

  it('never sends an expired deposit, and forgets it', () => {
    const state = agentLost(
      depositInto(emptyDeadman(), deposit([item('AAAAAAAAAAAAAAAA', 60)], 1800), config, 0).state,
      0,
    );
    expect(nextWake(state)).toBe(30 * MIN);
    expect(dueItems(state, 61 * MIN)).toEqual([]);
    expect(expire(state, 30 * MIN).items).toEqual([]);
  });

  it('an empty deposit clears what was held', () => {
    let state = depositInto(emptyDeadman(), deposit(), config, 0).state;
    state = depositInto(state, deposit([]), config, 1).state;
    expect(state.items).toEqual([]);
    expect(nextWake(agentLost(state, 2))).toBeNull();
  });
});

describe('the Node relay registry', () => {
  let sent: PushRequest[];
  let connected: Set<string>;
  let registry: DeadmanRegistry;
  const metrics = {
    deadmanDeposits: 0,
    events: [] as string[],
    deadmanEvent(e: string) {
      this.events.push(e);
    },
  };
  const admission = {
    existingPushPolicy: () => null,
    pushGate: () => ({ allows: () => true, charge: () => undefined }),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    sent = [];
    connected = new Set(['agent']);
    metrics.deadmanDeposits = 0;
    registry = new DeadmanRegistry(
      config,
      async (push) => (sent.push(push), 'sent'),
      admission,
      metrics,
      () => undefined,
      (id) => connected.has(id),
    );
  });
  afterEach(() => vi.useRealTimers());

  it('fires after the grace when the agent stays away, and reports it on the next registration', async () => {
    expect(registry.deposit('agent', deposit([item('AAAAAAAAAAAAAAAA', 15)]))).toBe('stored');
    expect(metrics.deadmanDeposits).toBe(1);
    connected.delete('agent');
    registry.lost('agent', Date.now());
    await vi.advanceTimersByTimeAsync(15 * MIN - 1);
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kid: 'AAAAAAAAAAAAAAAA', platform: 'android' });
    expect(sent[0]!.silent).toBeUndefined(); // a visible push
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(sent).toHaveLength(1); // once
    connected.add('agent');
    expect(registry.back('agent')).toEqual({ k: ['AAAAAAAAAAAAAAAA'], m: 75 * MIN });
  });

  it('a rollout hands the connection over within seconds: nothing is sent', async () => {
    registry.deposit('agent', deposit([item('AAAAAAAAAAAAAAAA', 10)]));
    connected.delete('agent');
    registry.lost('agent', Date.now());
    await vi.advanceTimersByTimeAsync(5_000);
    connected.add('agent');
    expect(registry.back('agent')).toBeNull();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(sent).toHaveLength(0);
  });

  it('caps what the whole relay holds and forgets idle states of agents that left', () => {
    const small = new DeadmanRegistry(
      { ...config, maxTotalBytes: 500 },
      null,
      admission,
      metrics,
      () => undefined,
      () => false,
    );
    expect(small.deposit('a', deposit())).toBe('stored');
    expect(small.deposit('b', deposit())).toBe('full');
    expect(small.deposit('a', deposit([]))).toBe('stored');
    expect(small.heldBytes).toBe(0);
    vi.setSystemTime(2 * 3600_000);
    small.sweep();
    expect(small.state('a')).toBeNull();
  });
});

describe('AgentLink and Deposit frames', () => {
  const socket = () => {
    const frames: Uint8Array[] = [];
    const s: LinkSocket = { send: (bytes) => frames.push(bytes), close: () => undefined };
    return { s, frames };
  };

  it('answers disabled and says deadman: false without a switch', async () => {
    const { s, frames } = socket();
    const link = new AgentLink(s, DEFAULT_LIMITS);
    expect(link.info().deadman).toBe(false);
    link.onFrame(decodeFrame(encodeDeposit(4, deposit())));
    await vi.waitFor(() => expect(frames).toHaveLength(1));
    const frame = decodeFrame(frames[0]!);
    expect(frame.type).toBe(FrameType.DepositResult);
    expect(decodeDepositResult(frame.payload)).toBe('disabled');
  });

  it('hands deposits on in order and answers each id once; a malformed one reaches the switch as null', async () => {
    const { s, frames } = socket();
    const seen: (DeadmanDeposit | null)[] = [];
    const link = new AgentLink(s, DEFAULT_LIMITS, {
      deadman: { deposit: async (d) => (seen.push(d), d ? 'stored' : 'invalid') },
    });
    expect(link.info().deadman).toBe(true);
    link.onFrame(decodeFrame(encodeDeposit(1, deposit())));
    link.onFrame({ type: FrameType.Deposit, callId: 2, payload: new TextEncoder().encode('{"x":1}') });
    await vi.waitFor(() => expect(frames).toHaveLength(2));
    expect(frames.map((f) => [decodeFrame(f).callId, decodeDepositResult(decodeFrame(f).payload)])).toEqual([
      [1, 'stored'],
      [2, 'invalid'],
    ]);
    expect(seen[1]).toBeNull();
  });
});
