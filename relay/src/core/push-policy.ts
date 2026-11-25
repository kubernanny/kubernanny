import { PushOutcome } from '@kubernanny/protocol';
import { BucketState, TokenBucket } from './limits';

/**
 * One agent's push allowance (review M3). Kept by agent id, not by
 * connection: a reconnect, or a new link after a Worker's hibernation,
 * continues where the last one stopped instead of starting full.
 *
 *   - a token bucket (burst, refill per hour)
 *   - at most `tokensPerDay` distinct FCM tokens a day: an agent pushes to
 *     its own paired phones, a handful; a relay used as an open sender would
 *     need thousands
 *   - a token FCM called `unregistered` or `invalid` is blocked for this
 *     agent for an hour, and such an answer costs `PENALTY` pushes: probing
 *     tokens is expensive, and a dead token is not hammered
 *
 * Tokens are only ever held as digests (`pushTokenDigest`).
 */
export interface PushPolicyState {
  bucket: BucketState;
  /** token digest -> blocked until (ms). */
  blocked: Record<string, number>;
  /** token digest -> first push to it within the current day (ms). */
  seen: Record<string, number>;
}

export interface PushPolicyConfig {
  burst: number;
  perHour: number;
  tokensPerDay: number;
}

const DAY_MS = 86_400_000;
const BLOCK_MS = 3_600_000;
/** What a push FCM refuses for its token costs, in pushes. */
export const PENALTY = 5;
const MAX_BLOCKED = 64;

export class AgentPushPolicy {
  private readonly bucket: TokenBucket;
  private readonly blocked = new Map<string, number>();
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly config: PushPolicyConfig,
    now: number,
    saved?: PushPolicyState,
  ) {
    this.bucket = new TokenBucket(config.burst, config.perHour / 3_600_000, now, saved?.bucket);
    for (const [digest, until] of Object.entries(saved?.blocked ?? {})) {
      if (typeof until === 'number' && until > now) {
        this.blocked.set(digest, until);
      }
    }
    for (const [digest, since] of Object.entries(saved?.seen ?? {})) {
      if (typeof since === 'number' && now - since < DAY_MS && this.seen.size < config.tokensPerDay) {
        this.seen.set(digest, since);
      }
    }
  }

  /** Whether a push to the token with this digest may go out now; charges nothing (see `charge`). */
  allows(digest: string, now: number): boolean {
    this.expire(now);
    if ((this.blocked.get(digest) ?? 0) > now) {
      return false;
    }
    if (!this.seen.has(digest) && this.seen.size >= this.config.tokensPerDay) {
      return false;
    }
    return this.bucket.has(1, now);
  }

  charge(digest: string, now: number): void {
    this.bucket.takeExact(1, now);
    if (!this.seen.has(digest)) {
      this.seen.set(digest, now);
    }
  }

  /** What FCM said; a refusal for the token blocks it and costs extra. */
  settle(digest: string, outcome: PushOutcome, now: number): void {
    if (outcome !== 'unregistered' && outcome !== 'invalid') {
      return;
    }
    this.bucket.take(PENALTY, now);
    this.blocked.delete(digest);
    this.blocked.set(digest, now + BLOCK_MS);
    while (this.blocked.size > MAX_BLOCKED) {
      this.blocked.delete(this.blocked.keys().next().value!);
    }
  }

  /** Nothing left to remember: a full bucket, no block and no token seen today. Such an entry may be dropped. */
  isIdle(now: number): boolean {
    this.expire(now);
    return this.bucket.isFull(now) && this.blocked.size === 0 && this.seen.size === 0;
  }

  state(): PushPolicyState {
    return { bucket: this.bucket.state(), blocked: Object.fromEntries(this.blocked), seen: Object.fromEntries(this.seen) };
  }

  private expire(now: number): void {
    for (const [digest, until] of this.blocked) {
      if (until <= now) {
        this.blocked.delete(digest);
      }
    }
    for (const [digest, since] of this.seen) {
      if (now - since >= DAY_MS) {
        this.seen.delete(digest);
      }
    }
  }
}
