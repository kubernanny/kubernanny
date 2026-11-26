import {
  DeadmanDeposit,
  decodeDeposit,
  decodePushRequest,
  decodeReplyEnd,
  DepositOutcome,
  encodeDepositResult,
  encodeFrame,
  encodePushResult,
  Frame,
  FrameType,
  pushTokenDigest,
  RelayClose,
  RelayFrameError,
  RelayLimitsInfo,
} from '@kubernanny/protocol';

import { checkAgentReply, RelayErrorCode } from './http';
import { BucketState, BudgetHolder, ByteBudget, CallerLimiter, RelayLimits, shareBytes, TokenBucket } from './limits';
import { PushSender } from './push';
import { AgentPushPolicy } from './push-policy';

/** What a link needs from a WebSocket; the Node `ws` socket and a Workers WebSocket both fit with a small adapter. */
export interface LinkSocket {
  /** `sent`, when given, is called once the bytes have left the relay's queue (`ws`: the send callback) or could not be sent. */
  send(bytes: Uint8Array, sent?: () => void): void;
  close(code: number, reason: string): void;
  /** Bytes queued for the agent and not yet taken by it (`ws`); absent where the platform does not tell (Workers). */
  bufferedAmount?(): number;
  /** False once the socket is closing or closed: calls then get RELAY_AGENT_OFFLINE at once (review L5). */
  isOpen?(): boolean;
}

/** The state of a link's rate limits, to carry them over a Durable Object's hibernation. */
export interface LinkRates {
  calls: BucketState;
  bytes: BucketState;
}

/** A limit above the agent's own, asked before a push is charged anywhere (the Node relay: its address and the relay as a whole). */
export interface PushGate {
  allows(now: number): boolean;
  charge(now: number): void;
}

/** Native push for this agent: where Push frames go, and this agent's allowance (kept by agent id, across connections). */
export interface LinkPush {
  send: PushSender;
  policy: AgentPushPolicy;
  gate?: PushGate;
  maxInFlight: number;
  /** Called when a push has ended, after its allowance was charged (a Durable Object saves it then). */
  done?: () => void;
}

/** The dead man's switch for this agent (core/deadman.ts): where a Deposit frame goes. */
export interface LinkDeadman {
  /** `null`: the frame did not parse (answered `invalid` after the platform had its say, e.g. charging the allowance). */
  deposit(deposit: DeadmanDeposit | null): DepositOutcome | Promise<DepositOutcome>;
}

export interface LinkOptions {
  now?: () => number;
  /** The budget above this agent's own share: its address' share or the relay's total; a total of its own when not given (tests, one Durable Object per agent). */
  parent?: ByteBudget;
  /** Rate limit state saved by an earlier link on the same socket (see `rates()`). */
  rates?: LinkRates;
  /** Native push; without it Push frames are answered `disabled` and Ready says `push: false`. */
  push?: LinkPush | null;
  /** The dead man's switch; without it Deposit frames are answered `disabled` and Ready says `deadman: false`. */
  deadman?: LinkDeadman | null;
}

export type CallResult = { kind: 'reply'; status: number; body: Uint8Array } | { kind: 'error'; code: RelayErrorCode };

interface Pending {
  resolve: (result: CallResult) => void;
  timer: ReturnType<typeof setTimeout>;
  parts: Uint8Array[];
  size: number;
  /** Bytes of this call counted against the budgets (its request until answered, then the answer's parts), given back when it ends. */
  reserved: number;
  /** When the first part arrived: from then on the stream and progress timeouts apply. */
  startedAt: number;
  /** This call in the budgets: evicted when a smaller answer needs the room. */
  holder: BudgetHolder;
}

/**
 * One registered agent's socket, seen from the relay: hands calls to the
 * agent and matches the answers to them by call id. Limits apply here so
 * that the Node relay and the Cloudflare Durable Object enforce exactly the
 * same ones. The link never looks into a payload; it only counts bytes.
 */
export class AgentLink {
  private readonly pending = new Map<number, Pending>();
  private readonly calls: TokenBucket;
  private readonly bytes: TokenBucket;
  /** This agent's share; its parent is the address' share or the relay's total. */
  private readonly budget: ByteBudget;
  private readonly now: () => number;
  private closed = false;
  private readonly push: LinkPush | null;
  /** Per calling address, in front of the agent's own buckets (review M1). */
  private readonly callers: CallerLimiter;
  /** Call frames still queued on the socket, by a token of their own, with their size: held in the budgets until they leave (review H1). */
  private readonly queued = new Map<object, number>();
  /** Push ids waiting for FCM: each answered once, and their number is capped. */
  private readonly pushesInFlight = new Set<number>();
  private readonly deadman: LinkDeadman | null;
  /** Deposits being stored: one at a time, the next one waits (each replaces the one before). */
  private depositing: Promise<void> = Promise.resolve();

  constructor(
    private readonly socket: LinkSocket,
    private readonly limits: RelayLimits,
    {
      now = Date.now,
      parent = new ByteBudget(limits.maxInflightBytes),
      rates,
      push = null,
      deadman = null,
    }: LinkOptions = {},
  ) {
    this.now = now;
    this.push = push;
    this.deadman = deadman;
    this.callers = new CallerLimiter(limits);
    this.budget = new ByteBudget(Math.min(limits.maxConcurrent * limits.maxResponseBytes, shareBytes(limits)), parent);
    this.calls = new TokenBucket(limits.callBurst, limits.callsPerMinute / 60_000, now(), rates?.calls);
    this.bytes = new TokenBucket(limits.bytesPerHour, limits.bytesPerHour / 3_600_000, now(), rates?.bytes);
  }

  /** The rate limit state, for a link that has to be rebuilt later (a Durable Object loses its fields when it hibernates). */
  rates(): LinkRates {
    return { calls: this.calls.state(), bytes: this.bytes.state() };
  }

  get inFlight(): number {
    return this.pending.size;
  }

  /** What the agent is told in its Ready frame. */
  info(): RelayLimitsInfo {
    return {
      maxRequestBytes: this.limits.maxRequestBytes,
      maxResponseBytes: this.limits.maxResponseBytes,
      maxConcurrent: this.limits.maxConcurrent,
      callTimeoutMs: this.limits.callTimeoutMs,
      push: this.push !== null,
      statusPush: this.push !== null,
      deadman: this.deadman !== null,
    };
  }

  /**
   * Forwards one sealed request and resolves with the agent's answer or the
   * relay's refusal; never rejects. `caller` is the calling client's address
   * (its own buckets come first). Every limit is checked before any is
   * charged (review L4), and the request's bytes count against the answer
   * budgets until the call ends: an agent that does not read must not make
   * the relay hold its requests without bound (review H1).
   */
  call(body: Uint8Array, caller?: string): Promise<CallResult> {
    if (this.closed || this.socket.isOpen?.() === false) {
      return Promise.resolve({ kind: 'error', code: 'RELAY_AGENT_OFFLINE' });
    }
    if (body.length > this.limits.maxRequestBytes) {
      return Promise.resolve({ kind: 'error', code: 'RELAY_TOO_LARGE' });
    }
    const now = this.now();
    const callerAllowed = caller === undefined || this.callers.allows(caller, body.length, now);
    if (
      this.pending.size >= this.limits.maxConcurrent ||
      !callerAllowed ||
      !this.calls.has(1, now) ||
      !this.bytes.has(body.length, now)
    ) {
      return Promise.resolve({ kind: 'error', code: 'RELAY_RATE_LIMITED' });
    }
    if ((this.socket.bufferedAmount?.() ?? 0) + body.length > this.limits.maxSocketBufferBytes) {
      return Promise.resolve({ kind: 'error', code: 'RELAY_BUSY' });
    }
    const callId = this.allocate();
    const holder: BudgetHolder = {
      evict: () => {
        this.finish(callId, { kind: 'error', code: 'RELAY_BUSY' });
        this.trySend(encodeFrame(FrameType.Cancel, callId));
      },
    };
    // Twice: the request until the call ends (a holder, may be evicted), and its frame until it has left
    // the socket's queue (no holder: queued bytes cannot be taken back, so they are never evicted).
    if (!this.budget.reserve(body.length, holder) || !this.budget.reserve(body.length + FRAME_OVERHEAD)) {
      this.budget.release(body.length, holder);
      return Promise.resolve({ kind: 'error', code: 'RELAY_BUSY' });
    }
    if (caller !== undefined) {
      this.callers.charge(caller, body.length, now);
    }
    this.calls.takeExact(1, now);
    this.bytes.takeExact(body.length, now);
    return new Promise<CallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(callId, { kind: 'error', code: 'RELAY_TIMEOUT' });
        this.trySend(encodeFrame(FrameType.Cancel, callId));
      }, this.limits.callTimeoutMs);
      this.pending.set(callId, { resolve, timer, parts: [], size: 0, reserved: body.length, startedAt: 0, holder });
      this.sendQueued(encodeFrame(FrameType.Call, callId, body));
    });
  }

  /** A binary message from the registered agent. */
  onFrame(frame: Frame): void {
    if (frame.type === FrameType.Push) {
      this.onPush(frame.callId, frame.payload);
      return;
    }
    if (frame.type === FrameType.Deposit) {
      this.onDeposit(frame.callId, frame.payload);
      return;
    }
    if (frame.type !== FrameType.ReplyChunk && frame.type !== FrameType.ReplyEnd) {
      return; // unknown types are ignored, so agents can add some later
    }
    const call = this.pending.get(frame.callId);
    if (!call) {
      return; // a late answer to a call that timed out
    }
    let part = frame.payload;
    let status = 0;
    if (frame.type === FrameType.ReplyEnd) {
      try {
        const end = decodeReplyEnd(frame.payload);
        status = end.status;
        part = end.last;
      } catch (err) {
        if (err instanceof RelayFrameError) {
          this.socket.close(RelayClose.Protocol, 'bad reply');
          this.shutdown();
          return;
        }
        throw err;
      }
    }
    if (!call.startedAt) {
      // The answer has begun: the request's bytes go back, the answer's take their place.
      this.budget.release(call.reserved, call.holder);
      call.reserved = 0;
    }
    const refusal = this.refusePart(call, part.length);
    if (refusal) {
      this.finish(frame.callId, { kind: 'error', code: refusal });
      this.trySend(encodeFrame(FrameType.Cancel, frame.callId));
      return;
    }
    call.size += part.length;
    call.reserved += part.length;
    this.rearm(frame.callId, call);
    // Copied: the payload is a view into the socket's receive buffer.
    call.parts.push(part.slice());
    if (frame.type === FrameType.ReplyEnd) {
      const reply = checkAgentReply(status, join(call.parts, call.size));
      this.finish(
        frame.callId,
        reply ? { kind: 'reply', ...reply } : { kind: 'error', code: 'RELAY_BAD_AGENT_RESPONSE' },
      );
    }
  }

  /**
   * One push from the agent: answered exactly once per id, with `disabled`
   * on a relay without push, `rate_limited` past this agent's bucket or its
   * pushes in flight, `invalid` for a malformed request, else what FCM said.
   * Nothing of it is logged: the token is the phone's address.
   */
  private onPush(id: number, payload: Uint8Array): void {
    if (this.closed || this.pushesInFlight.has(id)) {
      return; // a closed link sends nothing to FCM; an id still waiting gets one answer only
    }
    if (!this.push) {
      this.trySend(encodePushResult(id, 'disabled'));
      return;
    }
    const request = decodePushRequest(payload);
    if (!request) {
      this.trySend(encodePushResult(id, 'invalid'));
      return;
    }
    const now = this.now();
    const digest = pushTokenDigest(request.token);
    const { send, done, policy, gate } = this.push;
    if (
      this.pushesInFlight.size >= this.push.maxInFlight ||
      !policy.allows(digest, now) ||
      (gate && !gate.allows(now))
    ) {
      this.trySend(encodePushResult(id, 'rate_limited'));
      done?.();
      return;
    }
    policy.charge(digest, now);
    gate?.charge(now);
    this.pushesInFlight.add(id);
    void send(request)
      .catch(() => 'failed' as const)
      .then((outcome) => {
        this.pushesInFlight.delete(id);
        policy.settle(digest, outcome, this.now());
        if (!this.closed) {
          this.trySend(encodePushResult(id, outcome));
        }
        done?.();
      });
  }

  /**
   * The agent's dead man's switch messages (docs/RELAY.md, "Dead man's
   * switch"): handed to the platform, which stores them (memory or the
   * object's storage), and answered once with what became of them. In
   * order: a later deposit always replaces an earlier one.
   */
  private onDeposit(id: number, payload: Uint8Array): void {
    if (this.closed) {
      return;
    }
    const deadman = this.deadman;
    if (!deadman) {
      this.trySend(encodeDepositResult(id, 'disabled'));
      return;
    }
    const deposit = decodeDeposit(payload);
    this.depositing = this.depositing.then(async () => {
      let outcome: DepositOutcome;
      try {
        outcome = await deadman.deposit(deposit);
      } catch {
        outcome = 'full'; // could not be stored: the previous deposit stays, the agent tries again later
      }
      if (!this.closed) {
        this.trySend(encodeDepositResult(id, outcome));
      }
    });
  }

  /** Every part is checked before it is kept: the answer's size, this agent's byte budget, the relay's memory. */
  private refusePart(call: Pending, bytes: number): RelayErrorCode | null {
    if (call.size + bytes > this.limits.maxResponseBytes) {
      return 'RELAY_RESPONSE_TOO_LARGE';
    }
    if (!this.bytes.take(bytes, this.now())) {
      return 'RELAY_RATE_LIMITED';
    }
    if (!this.budget.reserve(bytes, call.holder)) {
      return 'RELAY_BUSY';
    }
    return null;
  }

  /** The socket is gone: every waiting call learns that the agent is offline, and queued frames give their bytes back. */
  shutdown(): void {
    this.closed = true;
    for (const [token, size] of this.queued) {
      this.queued.delete(token);
      this.budget.release(size);
    }
    for (const id of [...this.pending.keys()]) {
      this.finish(id, { kind: 'error', code: 'RELAY_AGENT_OFFLINE' });
    }
  }

  /**
   * An answer in progress holds memory: from its first part on, each next
   * part must come within the progress timeout, and the whole answer within
   * the stream timeout, or the call is cancelled and its bytes go back.
   */
  private rearm(callId: number, call: Pending): void {
    const now = this.now();
    if (!call.startedAt) {
      call.startedAt = now;
    }
    clearTimeout(call.timer);
    const wait = Math.max(
      0,
      Math.min(this.limits.progressTimeoutMs, call.startedAt + this.limits.streamTimeoutMs - now),
    );
    call.timer = setTimeout(() => {
      this.finish(callId, { kind: 'error', code: 'RELAY_TIMEOUT' });
      this.trySend(encodeFrame(FrameType.Cancel, callId));
    }, wait);
  }

  private finish(callId: number, result: CallResult): void {
    const call = this.pending.get(callId);
    if (!call) {
      return;
    }
    this.pending.delete(callId);
    clearTimeout(call.timer);
    this.budget.release(call.reserved, call.holder);
    call.parts = [];
    call.resolve(result);
  }

  /** A Call frame, whose bytes (reserved by the caller) go back to the budgets once the socket has sent it. */
  private sendQueued(frame: Uint8Array): void {
    const token = {};
    this.queued.set(token, frame.length);
    const sent = () => {
      if (this.queued.delete(token)) {
        this.budget.release(frame.length);
      }
    };
    if (this.closed || this.socket.isOpen?.() === false) {
      sent();
      this.shutdown();
      return;
    }
    try {
      this.socket.send(frame, sent);
    } catch {
      sent();
      this.shutdown();
    }
  }

  private trySend(bytes: Uint8Array): void {
    if (this.socket.isOpen?.() === false) {
      this.shutdown();
      return;
    }
    try {
      this.socket.send(bytes);
    } catch {
      this.shutdown();
    }
  }

  /**
   * A random id in 1 .. 2^32-1 not in flight (0 belongs to registration).
   * Random rather than sequential: an "agent" that never reads its Call
   * frames must not be able to answer them blindly by guessing the next id
   * (review H1), which would free its concurrency slots for more unread calls.
   */
  private allocate(): number {
    const word = new Uint32Array(1);
    do {
      crypto.getRandomValues(word);
    } while (word[0] === 0 || this.pending.has(word[0]!));
    return word[0]!;
  }
}

/** A frame's header: type and call id. */
const FRAME_OVERHEAD = 5;

function join(parts: Uint8Array[], size: number): Uint8Array {
  if (parts.length === 1) {
    return parts[0]!;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
