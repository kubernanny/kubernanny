/**
 * The per-token push limit on the Worker (review M3): one small Durable
 * Object per FCM token, named by the token's digest, so the limit holds
 * across every agent object of the relay, as it does across the agents of a
 * Node relay. One request per push, one stored row per token that was ever
 * pushed to; the token itself is never stored or sent there.
 */
import { pushTokenDigest } from '@kubernanny/protocol';
import { BucketState } from '../../src/core/limits';
import { TokenGate, parsePushConfig, tokenBucket } from '../../src/core/push';
import { stringVars } from './agent-object';

export interface TokenLimiterStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** The object's logic: one bucket, kept in storage so an eviction does not refill it. */
export class TokenLimiterCore {
  private readonly perHour: number;

  constructor(
    private readonly storage: TokenLimiterStorage,
    env: Record<string, unknown>,
    private readonly now: () => number = Date.now,
  ) {
    this.perHour = parsePushConfig(stringVars(env)).tokenPerHour;
  }

  /** 204 when the push may go out, 429 when the token's hour is used up. */
  async fetch(): Promise<Response> {
    const now = this.now();
    const bucket = tokenBucket(this.perHour, now, await this.storage.get<BucketState>('bucket'));
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
    async take(token) {
      const res = await namespace.get(namespace.idFromName(pushTokenDigest(token))).fetch('https://token-limiter/take', { method: 'POST' });
      return res.status === 204;
    },
  };
}
