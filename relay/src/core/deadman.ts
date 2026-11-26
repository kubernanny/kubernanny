import {
  DeadmanDeposit,
  DeadmanItem,
  DepositOutcome,
  PushOutcome,
  PushRequest,
  pushTokenDigest,
} from '@kubernanny/protocol';

import { BucketState, TokenBucket } from './limits';

/**
 * The dead man's switch on the relay (docs/RELAY.md, "Dead man's switch").
 *
 * The agent deposits, over its registered WebSocket, one sealed push per
 * device that asked for it: "Kubernanny has not been heard from for N
 * minutes". The relay cannot read it. When the agent's connection is gone
 * and no connection of the same agent id comes back within a device's grace,
 * the relay sends that device's message, once. When the agent registers
 * again afterwards, its Ready names the key ids that went out and how long
 * the agent was away, so the agent can say it is back.
 *
 * Plain data and pure functions, so the Node relay (timers, memory) and the
 * Worker's Durable Object (an alarm, storage) run exactly the same rules.
 * Never holds more than one deposit per agent id; a deposit replaces the
 * previous one and expires after its validity, so a relay cannot send a
 * stale one forever (the phone also refuses one past the window sealed into
 * it).
 */
export interface DeadmanConfig {
  /** On only where native push is on, and RELAY_DEADMAN=off turns it off even then. */
  enabled: boolean;
  /** Messages one agent may deposit (one per device). */
  maxItems: number;
  /** The longest sealed message (base64url characters) a deposit may carry. */
  maxMessageChars: number;
  /** Deposits per agent and hour (token bucket, a third of it as burst). */
  depositsPerHour: number;
  /** Deposited bytes the whole relay holds at once (Node; a Worker holds one deposit per object). */
  maxTotalBytes: number;
}

export const DEFAULT_DEADMAN = {
  maxItems: 8,
  maxMessageChars: 1024,
  depositsPerHour: 30,
  maxTotalBytes: 16 * 1024 * 1024,
} as const;

/** One deposited message as the relay keeps it. The token is needed to send it; it is never logged. */
export interface HeldItem {
  token: string;
  platform: 'ios' | 'android';
  kid: string;
  message: string;
  lang?: 'en' | 'de';
  graceMs: number;
}

export interface DeadmanState {
  items: HeldItem[];
  /** When the relay took the deposit, and until when it may send any of it (relay clock, ms). */
  storedAt: number;
  expiresAt: number;
  /** Nothing is sent before this (a maintenance window on the agent). */
  holdUntil: number;
  /** When this agent was last heard on a connection that is gone; null while one is registered. */
  lostAt: number | null;
  /** Key ids sent since `lostAt`: each once per absence. */
  sent: string[];
  /** What the next Ready reports: the key ids sent and when the agent went away; null when nothing went out. */
  fired: { kids: string[]; lostAt: number } | null;
  /** The deposit allowance (survives reconnects, like the push allowance). */
  bucket?: BucketState;
}

export function emptyDeadman(): DeadmanState {
  return { items: [], storedAt: 0, expiresAt: 0, holdUntil: 0, lostAt: null, sent: [], fired: null };
}

/**
 * RELAY_DEADMAN (`off` disables; default on wherever native push is on),
 * RELAY_DEADMAN_MAX_DEPOSITS, RELAY_DEADMAN_MAX_BYTES (one sealed message,
 * base64url), RELAY_DEADMAN_DEPOSITS_PER_HOUR, RELAY_DEADMAN_MAX_TOTAL_BYTES.
 */
export function parseDeadmanConfig(env: Record<string, string | undefined>, pushEnabled: boolean): DeadmanConfig {
  const switchValue = (env['RELAY_DEADMAN'] ?? '').trim().toLowerCase();
  if (!['', 'on', 'off', 'true', 'false', '1', '0'].includes(switchValue)) {
    throw new Error(`RELAY_DEADMAN must be on or off, got "${env['RELAY_DEADMAN']}"`);
  }
  const num = (name: string, fallback: number, min = 1) => {
    const value = env[name] === undefined || env[name] === '' ? fallback : Number(env[name]);
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`${name} must be a whole number of at least ${min}, got "${env[name]}"`);
    }
    return value;
  };
  return {
    enabled: pushEnabled && !['off', 'false', '0'].includes(switchValue),
    maxItems: num('RELAY_DEADMAN_MAX_DEPOSITS', DEFAULT_DEADMAN.maxItems),
    // A message is at least 66 characters (version, ephemeral key, tag); the agent's are about 300.
    maxMessageChars: num('RELAY_DEADMAN_MAX_BYTES', DEFAULT_DEADMAN.maxMessageChars, 128),
    depositsPerHour: num('RELAY_DEADMAN_DEPOSITS_PER_HOUR', DEFAULT_DEADMAN.depositsPerHour),
    maxTotalBytes: num('RELAY_DEADMAN_MAX_TOTAL_BYTES', DEFAULT_DEADMAN.maxTotalBytes),
  };
}

/** The bytes a state holds, for the relay-wide cap (tokens and messages; the rest is small). */
export function heldBytes(state: DeadmanState): number {
  return state.items.reduce((sum, i) => sum + i.token.length + i.message.length + 64, 0);
}

function bucketOf(state: DeadmanState, config: DeadmanConfig, now: number): TokenBucket {
  return new TokenBucket(
    Math.max(1, Math.ceil(config.depositsPerHour / 3)),
    config.depositsPerHour / 3_600_000,
    now,
    state.bucket,
  );
}

/**
 * Takes a deposit (null: the frame did not parse). `room`: the bytes the
 * relay may still hold beyond this agent's current deposit (Infinity on a
 * Worker). A refused deposit leaves the previous one in place.
 */
export function depositInto(
  state: DeadmanState,
  deposit: DeadmanDeposit | null,
  config: DeadmanConfig,
  now: number,
  room = Infinity,
): { state: DeadmanState; outcome: DepositOutcome } {
  if (!config.enabled) {
    return { state, outcome: 'disabled' };
  }
  if (
    !deposit ||
    deposit.items.length > config.maxItems ||
    deposit.items.some((i) => i.message.length > config.maxMessageChars) ||
    new Set(deposit.items.map((i) => i.kid)).size !== deposit.items.length
  ) {
    return { state, outcome: 'invalid' };
  }
  const bucket = bucketOf(state, config, now);
  if (!bucket.takeExact(1, now)) {
    return { state: { ...state, bucket: bucket.state() }, outcome: 'rate_limited' };
  }
  const items = deposit.items.map(held);
  const next: DeadmanState = {
    ...state,
    items,
    storedAt: now,
    expiresAt: items.length > 0 ? now + deposit.validitySeconds * 1000 : 0,
    holdUntil: now + deposit.holdSeconds * 1000,
    bucket: bucket.state(),
  };
  if (heldBytes(next) - heldBytes(state) > room) {
    return { state: { ...state, bucket: bucket.state() }, outcome: 'full' };
  }
  return { state: next, outcome: 'stored' };
}

function held(item: DeadmanItem): HeldItem {
  return {
    token: item.token,
    platform: item.platform,
    kid: item.kid,
    message: item.message,
    ...(item.lang ? { lang: item.lang } : {}),
    graceMs: item.graceMinutes * 60_000,
  };
}

/** The agent's connection is gone, last heard at `heardAt`. A second report of the same absence keeps the first time. */
export function agentLost(state: DeadmanState, heardAt: number): DeadmanState {
  return state.lostAt === null ? { ...state, lostAt: heardAt, sent: [] } : state;
}

/**
 * A connection of this agent registered: nothing more is sent, and what went
 * out during the absence is handed to the Ready frame (once) as key ids and
 * how long the agent was away.
 */
export function agentBack(
  state: DeadmanState,
  now: number,
): { state: DeadmanState; fired: { k: string[]; m: number } | null } {
  const fired = state.fired ? { k: state.fired.kids, m: Math.max(0, now - state.fired.lostAt) } : null;
  return { state: { ...state, lostAt: null, sent: [], fired: null }, fired };
}

/** The messages to send now: the agent is away, past each grace (and the hold), within the deposit's validity, not sent yet. */
export function dueItems(state: DeadmanState, now: number): HeldItem[] {
  if (state.lostAt === null || now >= state.expiresAt) {
    return [];
  }
  const from = Math.max(state.lostAt, state.holdUntil);
  return state.items.filter((i) => !state.sent.includes(i.kid) && now >= from + i.graceMs);
}

/** Records messages handed on (whatever FCM said: each is tried once per absence). */
export function markSent(state: DeadmanState, items: readonly HeldItem[]): DeadmanState {
  if (items.length === 0 || state.lostAt === null) {
    return state;
  }
  const kids = items.map((i) => i.kid);
  const firedKids = [...new Set([...(state.fired?.kids ?? []), ...kids])];
  return {
    ...state,
    sent: [...state.sent, ...kids],
    fired: { kids: firedKids, lostAt: state.fired?.lostAt ?? state.lostAt },
  };
}

/** Forgets an expired deposit. */
export function expire(state: DeadmanState, now: number): DeadmanState {
  return state.items.length > 0 && now >= state.expiresAt
    ? { ...state, items: [], storedAt: 0, expiresAt: 0, holdUntil: 0 }
    : state;
}

/** When something next has to happen: a message falls due, or the deposit expires; null for nothing. */
export function nextWake(state: DeadmanState): number | null {
  if (state.items.length === 0) {
    return null;
  }
  if (state.lostAt === null) {
    return state.expiresAt;
  }
  const from = Math.max(state.lostAt, state.holdUntil);
  const due = state.items.filter((i) => !state.sent.includes(i.kid)).map((i) => from + i.graceMs);
  return Math.min(state.expiresAt, ...due);
}

/** Whether a state has anything left to remember (a deposit, or a report for the next Ready, or an allowance in use). */
export function isIdle(state: DeadmanState, config: DeadmanConfig, now: number): boolean {
  return (
    state.items.length === 0 &&
    state.fired === null &&
    (state.bucket === undefined || bucketOf(state, config, now).isFull(now))
  );
}

/** What fires a deposited message: the same sender as a Push frame, with the agent's push allowance in front of it. */
export interface DeadmanFire {
  send: (push: PushRequest) => Promise<PushOutcome>;
  /** The agent's own push allowance (AgentPushPolicy), asked and charged for each message like a push; absent: none. */
  allows?: (digest: string, now: number) => boolean;
  charge?: (digest: string, now: number) => void;
}

/**
 * Sends the due messages, each as a visible push (the shape of an alert: it
 * is meant to be seen, and Android's normal priority would hold it for a
 * Doze window). Past the agent's push allowance a message is skipped but
 * still counts as sent: it is never retried in a loop.
 */
export async function fireDue(items: readonly HeldItem[], fire: DeadmanFire, now: number): Promise<PushOutcome[]> {
  return Promise.all(
    items.map(async (item) => {
      const digest = pushTokenDigest(item.token);
      if (fire.allows && !fire.allows(digest, now)) {
        return 'rate_limited' as const;
      }
      fire.charge?.(digest, now);
      try {
        return await fire.send({
          token: item.token,
          platform: item.platform,
          kid: item.kid,
          message: item.message,
          ...(item.lang ? { lang: item.lang } : {}),
        });
      } catch {
        return 'failed' as const;
      }
    }),
  );
}
