import { Frame, FrameType, RelayClose, RelayFrameError, RelayLimitsInfo, decodePushRequest, decodeReplyEnd, encodeFrame, encodePushResult } from '@kubernanny/protocol';
import { RelayErrorCode, checkAgentReply } from './http';
import { BucketState, BudgetHolder, ByteBudget, RelayLimits, TokenBucket, shareBytes } from './limits';
import { DEFAULT_PUSH, PushSender } from './push';

/** What a link needs from a WebSocket; the Node `ws` socket and a Workers WebSocket both fit with a one-line adapter. */
export interface LinkSocket {
  send(bytes: Uint8Array): void;
  close(code: number, reason: string): void;
}

/** The state of a link's rate limits, to carry them over a Durable Object's hibernation. */
export interface LinkRates {
  calls: BucketState;
  bytes: BucketState;
  pushes?: BucketState;
}

/** Native push for this agent: where Push frames go, and this agent's share of them. */
export interface LinkPush {
  send: PushSender;
  burst: number;
  perHour: number;
  maxInFlight: number;
  /** Called when a push has ended, after its bucket was charged (a Durable Object saves the rates then). */
  done?: () => void;
}

export interface LinkOptions {
  now?: () => number;
  /** The budget above this agent's own share: its address' share or the relay's total; a total of its own when not given (tests, one Durable Object per agent). */
  parent?: ByteBudget;
  /** Rate limit state saved by an earlier link on the same socket (see `rates()`). */
  rates?: LinkRates;
  /** Native push; without it Push frames are answered `disabled` and Ready says `push: false`. */
  push?: LinkPush | null;
}

export type CallResult = { kind: 'reply'; status: number; body: Uint8Array } | { kind: 'error'; code: RelayErrorCode };

interface Pending {
  resolve: (result: CallResult) => void;
  timer: ReturnType<typeof setTimeout>;
  parts: Uint8Array[];
  size: number;
  /** Bytes of this call counted against the relay-wide budget, given back when it ends. */
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
  private nextId = 1;
  private closed = false;
  private readonly push: LinkPush | null;
  private readonly pushes: TokenBucket;
  /** Push ids waiting for FCM: each answered once, and their number is capped. */
  private readonly pushesInFlight = new Set<number>();

  constructor(
    private readonly socket: LinkSocket,
    private readonly limits: RelayLimits,
    { now = Date.now, parent = new ByteBudget(limits.maxInflightBytes), rates, push = null }: LinkOptions = {},
  ) {
    this.now = now;
    this.push = push;
    this.pushes = new TokenBucket(push?.burst ?? DEFAULT_PUSH.agentBurst, (push?.perHour ?? DEFAULT_PUSH.agentPerHour) / 3_600_000, now(), rates?.pushes);
    this.budget = new ByteBudget(Math.min(limits.maxConcurrent * limits.maxResponseBytes, shareBytes(limits)), parent);
    this.calls = new TokenBucket(limits.callBurst, limits.callsPerMinute / 60_000, now(), rates?.calls);
    this.bytes = new TokenBucket(limits.bytesPerHour, limits.bytesPerHour / 3_600_000, now(), rates?.bytes);
  }

  /** The rate limit state, for a link that has to be rebuilt later (a Durable Object loses its fields when it hibernates). */
  rates(): LinkRates {
    return { calls: this.calls.state(), bytes: this.bytes.state(), pushes: this.pushes.state() };
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
    };
  }

  /** Forwards one sealed request and resolves with the agent's answer or the relay's refusal; never rejects. */
  call(body: Uint8Array): Promise<CallResult> {
    if (this.closed) {
      return Promise.resolve({ kind: 'error', code: 'RELAY_AGENT_OFFLINE' });
    }
    if (body.length > this.limits.maxRequestBytes) {
      return Promise.resolve({ kind: 'error', code: 'RELAY_TOO_LARGE' });
    }
    const now = this.now();
    if (this.pending.size >= this.limits.maxConcurrent || !this.calls.take(1, now) || !this.bytes.take(body.length, now)) {
      return Promise.resolve({ kind: 'error', code: 'RELAY_RATE_LIMITED' });
    }
    const callId = this.allocate();
    return new Promise<CallResult>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(callId, { kind: 'error', code: 'RELAY_TIMEOUT' });
        this.trySend(encodeFrame(FrameType.Cancel, callId));
      }, this.limits.callTimeoutMs);
      const holder: BudgetHolder = {
        evict: () => {
          this.finish(callId, { kind: 'error', code: 'RELAY_BUSY' });
          this.trySend(encodeFrame(FrameType.Cancel, callId));
        },
      };
      this.pending.set(callId, { resolve, timer, parts: [], size: 0, reserved: 0, startedAt: 0, holder });
      this.trySend(encodeFrame(FrameType.Call, callId, body));
    });
  }

  /** A binary message from the registered agent. */
  onFrame(frame: Frame): void {
    if (frame.type === FrameType.Push) {
      this.onPush(frame.callId, frame.payload);
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
      this.finish(frame.callId, reply ? { kind: 'reply', ...reply } : { kind: 'error', code: 'RELAY_BAD_AGENT_RESPONSE' });
    }
  }

  /**
   * One push from the agent: answered exactly once per id, with `disabled`
   * on a relay without push, `rate_limited` past this agent's bucket or its
   * pushes in flight, `invalid` for a malformed request, else what FCM said.
   * Nothing of it is logged: the token is the phone's address.
   */
  private onPush(id: number, payload: Uint8Array): void {
    if (this.pushesInFlight.has(id)) {
      return; // an id still waiting: one answer per id is all the agent gets
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
    if (this.pushesInFlight.size >= this.push.maxInFlight || !this.pushes.take(1, this.now())) {
      this.trySend(encodePushResult(id, 'rate_limited'));
      this.push.done?.();
      return;
    }
    this.pushesInFlight.add(id);
    const { send, done } = this.push;
    void send(request)
      .catch(() => 'failed' as const)
      .then((outcome) => {
        this.pushesInFlight.delete(id);
        if (!this.closed) {
          this.trySend(encodePushResult(id, outcome));
        }
        done?.();
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

  /** The socket is gone: every waiting call learns that the agent is offline. */
  shutdown(): void {
    this.closed = true;
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
    const wait = Math.max(0, Math.min(this.limits.progressTimeoutMs, call.startedAt + this.limits.streamTimeoutMs - now));
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

  private trySend(bytes: Uint8Array): void {
    try {
      this.socket.send(bytes);
    } catch {
      this.shutdown();
    }
  }

  /** 1 .. 2^32-1, skipping ids still in flight; 0 belongs to registration. */
  private allocate(): number {
    do {
      this.nextId = this.nextId >= 0xffffffff ? 1 : this.nextId + 1;
    } while (this.pending.has(this.nextId));
    return this.nextId;
  }
}

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
