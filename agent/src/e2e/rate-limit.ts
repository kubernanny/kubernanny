/** A token bucket: `capacity` calls at once, refilled at `perSecond`. */
export class TokenBucket {
  private tokens: number;
  private refilledAt: number;

  constructor(
    readonly capacity: number,
    readonly perSecond: number,
    now = Date.now(),
  ) {
    this.tokens = capacity;
    this.refilledAt = now;
  }

  /** Takes one token; false when the bucket is empty. */
  take(now: number): boolean {
    this.refill(now);
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  /** True when the bucket is back to full, so dropping it loses nothing. */
  full(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }

  private refill(now: number): void {
    // max(0, …): a clock that steps back must not drain the bucket.
    this.tokens = Math.min(this.capacity, this.tokens + (Math.max(0, now - this.refilledAt) / 1000) * this.perSecond);
    this.refilledAt = Math.max(this.refilledAt, now);
  }
}

/**
 * One bucket per key (a paired device, a source address). Buckets that
 * refilled completely are dropped when the map is full, which forgets
 * nothing. Never more than `maxKeys`: keys past that, while every bucket is
 * still in use, share one overflow bucket of the same size, so a flood from
 * many addresses costs memory for `maxKeys` buckets at most.
 */
export class KeyedBuckets {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly overflow: TokenBucket;

  constructor(
    private readonly capacity: number,
    private readonly perSecond: number,
    private readonly maxKeys: number,
  ) {
    this.overflow = new TokenBucket(capacity, perSecond);
  }

  take(key: string, now: number): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) {
        for (const [k, b] of this.buckets) {
          if (b.full(now)) {
            this.buckets.delete(k);
          }
        }
      }
      if (this.buckets.size >= this.maxKeys) {
        return this.overflow.take(now);
      }
      bucket = new TokenBucket(this.capacity, this.perSecond, now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(now);
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * Keys seen recently, each until its own expiry, at most `max` (the oldest go
 * first). The e2e channel remembers here the source addresses that recently
 * made an authenticated call.
 */
export class RecentKeys {
  private readonly until = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly max: number,
  ) {}

  add(key: string, now: number): void {
    this.until.delete(key);
    this.until.set(key, now + this.ttlMs);
    while (this.until.size > this.max) {
      this.until.delete(this.until.keys().next().value!);
    }
  }

  has(key: string, now: number): boolean {
    const until = this.until.get(key);
    return until !== undefined && until > now;
  }
}

/** The bucket key of a source address: IPv4 as is, IPv6 by its /64. Shared with the relay. */
export { sourceKey } from '@kubernanny/protocol';
