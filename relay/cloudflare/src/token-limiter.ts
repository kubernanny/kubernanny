/**
 * The per-token push limit on the Worker (review M3): one small Durable
 * Object per FCM token, named by the token's digest, so the limit holds
 * across every agent object of the relay, as it does across the agents of a
 * Node relay. One request per push, one stored row per token that was ever
 * pushed to; the token itself is never stored or sent there.
 */
import { pushTokenDigest } from '@kubernanny/protocol';

import { BucketState } from '../../src/core/limits';
import { parsePushConfig, tokenBucket, TokenGate } from '../../src/core/push';
import { stringVars } from './agent-object';

export interface TokenLimiterStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/**
 * The object's logic: one bucket, kept in storage so an eviction does not
 * refill it. A token's status pushes have an object of their own (named
 * `status:` plus the digest, asked at `/take-status`), with the smaller
 * status budget.
 */
export class TokenLimiterCore {
  private readonly perHour: number;
  private readonly statusPerHour: number;

  constructor(
    private readonly storage: TokenLimiterStorage,
    env: Record<string, unknown>,
    private readonly now: () => number = Date.now,
  ) {
    const config = parsePushConfig(stringVars(env));
    this.perHour = config.tokenPerHour;
    this.statusPerHour = config.statusTokenPerHour;
  }

  /** 204 when the push may go out, 429 when the token's hour is used up. */
  async fetch(request?: { url: string }): Promise<Response> {
    const now = this.now();
    const status = request !== undefined && new URL(request.url).pathname === '/take-status';
    const bucket = tokenBucket(
      status ? this.statusPerHour : this.perHour,
      now,
      await this.storage.get<BucketState>('bucket'),
    );
    const allowed = bucket.takeExact(1, now);
    if (allowed) {
      await this.storage.put('bucket', bucket.state());
    }
    return new Response(null, { status: allowed ? 204 : 429 });
  }
}

/** The binding as far as the gate uses it. */
export interface TokenLimiterNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> };
}

/** The gate the agent objects use: asks the token's own object. */
export function durableTokenGate(namespace: TokenLimiterNamespace): TokenGate {
  return {
    async take(token, silent) {
      const digest = pushTokenDigest(token);
      const res = silent
        ? await namespace
            .get(namespace.idFromName(`status:${digest}`))
            .fetch('https://token-limiter/take-status', { method: 'POST' })
        : await namespace.get(namespace.idFromName(digest)).fetch('https://token-limiter/take', { method: 'POST' });
      return res.status === 204;
    },
  };
}
