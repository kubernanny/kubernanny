import { MAX_SEALED_REQUEST, sourceKey } from '@kubernanny/protocol';

/**
 * Limits of one relay, read from the environment. Shared by the Node relay
 * and the Cloudflare Worker (which reads them from its `vars`), so both
 * behave the same. The defaults are for a free public relay: generous for
 * one person looking at a few clusters, tight enough that nobody can turn
 * it into a file transfer service.
 */
export interface RelayLimits {
  /** Agents connected at once; more are refused (close 4029 / 503). */
  maxAgents: number;
  /** Sockets that have not proven their key yet; when full, the oldest is dropped for a new one. */
  maxPendingRegistrations: number;
  /** Unproven sockets per client address (see trustProxy); more are refused. */
  maxPendingPerIp: number;
  /** Registered agents per client address: a soft limit for agents behind one NAT, so one host cannot fill the relay. */
  maxAgentsPerIp: number;
  /** A sealed request: 0x01 plus one Noise message. */
  maxRequestBytes: number;
  /** A response, reassembled from the agent's chunks. */
  maxResponseBytes: number;
  /** Response bytes held in memory across all agents at once; past it calls get 503 RELAY_BUSY. The main memory knob. */
  maxInflightBytes: number;
  /** Share of maxInflightBytes one agent id, and all agents of one client address together, may hold (1/4 by default). */
  inflightShare: number;
  /** Calls one agent may have in flight. */
  maxConcurrent: number;
  /**
   * Bytes queued on an agent's socket that it has not read yet; past it new
   * calls get RELAY_BUSY instead of piling up in relay memory (review H1).
   */
  maxSocketBufferBytes: number;
  /** Share of one agent's call and byte buckets that one calling address may use (review M1). */
  callerShare: number;
  /** Token bucket per agent: burst size and refill per minute. */
  callBurst: number;
  callsPerMinute: number;
  /** Request plus response bytes per agent and hour (token bucket of that size). */
  bytesPerHour: number;
  /** A call the agent has not answered by then gets 504. */
  callTimeoutMs: number;
  /** Once an answer has started, a gap longer than this between its parts cancels it (it holds memory meanwhile). */
  progressTimeoutMs: number;
  /** Once an answer has started, it must be complete within this. */
  streamTimeoutMs: number;
  /** A connection must prove its key within this. */
  registerTimeoutMs: number;
  /** A connection without any message (the agent pings every 25 s) for this long is closed. */
  idleTimeoutMs: number;
  /** Origins allowed to call the HTTP API from a browser; ['*'] for any. */
  corsOrigins: string[];
  /** Header carrying the client address set by a trusted proxy (cf-connecting-ip, x-forwarded-for, x-real-ip); empty: the socket address. */
  trustProxy: string;
}

export const DEFAULT_LIMITS: RelayLimits = {
  maxAgents: 10_000,
  maxPendingRegistrations: 1_000,
  maxPendingPerIp: 8,
  maxAgentsPerIp: 20,
  maxRequestBytes: 64 * 1024,
  // The agent's own answers stay below 8 MiB (MAX_INTERNAL_RESPONSE) plus the sealing.
  maxResponseBytes: 9 * 1024 * 1024,
  maxInflightBytes: 64 * 1024 * 1024,
  inflightShare: 0.25,
  maxConcurrent: 4,
  // A few requests' worth: a reading agent drains it within milliseconds.
  maxSocketBufferBytes: 1024 * 1024,
  callerShare: 0.25,
  callBurst: 30,
  callsPerMinute: 120,
  bytesPerHour: 256 * 1024 * 1024,
  callTimeoutMs: 25_000,
  progressTimeoutMs: 3_000,
  // 9 MiB at 5 Mbit/s upload takes about 15 s; typical answers are a few KiB.
  streamTimeoutMs: 15_000,
  // A real agent proves its key within one round trip; this is only for slow links.
  registerTimeoutMs: 3_000,
  idleTimeoutMs: 90_000,
  corsOrigins: ['*'],
  trustProxy: '',
};

const ENV: Record<Exclude<keyof RelayLimits, 'corsOrigins' | 'trustProxy'>, string> = {
  maxAgents: 'RELAY_MAX_AGENTS',
  maxPendingRegistrations: 'RELAY_MAX_PENDING_REGISTRATIONS',
  maxPendingPerIp: 'RELAY_MAX_PENDING_PER_IP',
  maxAgentsPerIp: 'RELAY_MAX_AGENTS_PER_IP',
  maxRequestBytes: 'RELAY_MAX_REQUEST_BYTES',
  maxResponseBytes: 'RELAY_MAX_RESPONSE_BYTES',
  maxInflightBytes: 'RELAY_MAX_INFLIGHT_BYTES',
  inflightShare: 'RELAY_INFLIGHT_SHARE',
  maxConcurrent: 'RELAY_MAX_CONCURRENT',
  maxSocketBufferBytes: 'RELAY_MAX_SOCKET_BUFFER_BYTES',
  callerShare: 'RELAY_CALLER_SHARE',
  callBurst: 'RELAY_CALL_BURST',
  callsPerMinute: 'RELAY_CALLS_PER_MINUTE',
  bytesPerHour: 'RELAY_BYTES_PER_HOUR',
  callTimeoutMs: 'RELAY_CALL_TIMEOUT_MS',
  progressTimeoutMs: 'RELAY_PROGRESS_TIMEOUT_MS',
  streamTimeoutMs: 'RELAY_STREAM_TIMEOUT_MS',
  registerTimeoutMs: 'RELAY_REGISTER_TIMEOUT_MS',
  idleTimeoutMs: 'RELAY_IDLE_TIMEOUT_MS',
};

/** Reads RELAY_* from `env`; fails loudly on anything that is not a positive number. */
export function parseLimits(env: Record<string, string | undefined>): RelayLimits {
  const limits: RelayLimits = { ...DEFAULT_LIMITS };
  for (const [key, name] of Object.entries(ENV) as [keyof typeof ENV, string][]) {
    const raw = env[name];
    if (raw === undefined || raw === '') {
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number, got "${raw}"`);
    }
    limits[key] = value;
  }
  // A request is one Noise message plus the version byte; more can never be valid.
  limits.maxRequestBytes = Math.min(limits.maxRequestBytes, MAX_SEALED_REQUEST);
  limits.inflightShare = Math.min(1, limits.inflightShare);
  limits.callerShare = Math.min(1, limits.callerShare);
  // At least one request must fit, or no call could ever be sent.
  limits.maxSocketBufferBytes = Math.max(limits.maxSocketBufferBytes, limits.maxRequestBytes + 64);
  // One answer must fit into one agent's share, or it could never succeed.
  limits.maxResponseBytes = Math.min(limits.maxResponseBytes, shareBytes(limits));
  if (env['TRUST_PROXY']) {
    const header = env['TRUST_PROXY'].trim().toLowerCase();
    if (!['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip'].includes(header)) {
      throw new Error(
        `TRUST_PROXY must be cf-connecting-ip, x-forwarded-for or x-real-ip, got "${env['TRUST_PROXY']}"`,
      );
    }
    limits.trustProxy = header;
  }
  if (env['CORS_ORIGINS']) {
    limits.corsOrigins = env['CORS_ORIGINS']
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return limits;
}

/** What a token bucket needs to continue where it stopped: its tokens and when they were counted. */
export interface BucketState {
  tokens: number;
  at: number;
}

/** A token bucket: `capacity` at most, refilled at `perMs` tokens per millisecond. */
export class TokenBucket {
  private tokens: number;
  private at: number;

  /** Starts full, or from `saved` (a Durable Object woken from hibernation); a saved state is never fuller than `capacity`. */
  constructor(
    private readonly capacity: number,
    private readonly perMs: number,
    now: number,
    saved?: BucketState,
  ) {
    const valid = saved !== undefined && Number.isFinite(saved.tokens) && Number.isFinite(saved.at);
    this.tokens = valid ? Math.min(capacity, saved.tokens) : capacity;
    this.at = valid ? Math.min(now, saved.at) : now;
  }

  /** Takes `amount` if there is at least one token left; may go negative, so a large answer part is paid for by the next calls. Only for what the agent itself sends. */
  take(amount: number, now: number): boolean {
    this.refill(now);
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= amount;
    return true;
  }

  /** Whether `amount` can be taken in full; for checking several buckets before charging any (review L4). */
  has(amount: number, now: number): boolean {
    this.refill(now);
    return this.tokens >= amount;
  }

  /** Takes `amount` only if all of it is there: what callers send never drives a bucket negative (review M1). */
  takeExact(amount: number, now: number): boolean {
    if (!this.has(amount, now)) {
      return false;
    }
    this.tokens -= amount;
    return true;
  }

  /** Whether the bucket has refilled completely: forgetting it then changes nothing. */
  isFull(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }

  state(): BucketState {
    return { tokens: this.tokens, at: this.at };
  }

  private refill(now: number): void {
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, now - this.at) * this.perMs);
    this.at = now;
  }
}

const MAX_EVICTIONS = 16;

/** Something holding bytes of a budget that can be made to give them up (an answer in progress). */
export interface BudgetHolder {
  /** Ends the holder and releases everything it reserved, synchronously. */
  evict(): void;
}

/**
 * Bytes held for answers in flight. One per relay, one per client address
 * and one per agent, nested: a reservation must fit all three. Anyone can
 * register agent ids of their own, so without this an "agent" could make
 * the relay hold maxResponseBytes per call, per call in flight, per id.
 *
 * When a reservation does not fit, the largest holder that holds more than
 * the requester would after it gives way: an answer that keeps growing
 * without ending loses to a small answer that is about to finish. Holding
 * the budget therefore keeps nobody out who needs less.
 */
export class ByteBudget {
  private used = 0;
  private readonly holders = new Map<BudgetHolder, number>();

  /** With a parent, a reservation must fit both: an agent's share inside its address' share inside the relay's total. */
  constructor(
    readonly capacity: number,
    private readonly parent?: ByteBudget,
  ) {}

  get inUse(): number {
    return this.used;
  }

  /**
   * Two phases (review L4): first every level is asked whether the amount
   * could fit, evictions included, and only then does anyone get evicted. A
   * holder is never pushed out for a reservation a parent then refuses.
   */
  reserve(amount: number, holder?: BudgetHolder): boolean {
    if (!this.couldFit(amount, holder)) {
      return false;
    }
    return this.reserveNow(amount, holder);
  }

  private couldFit(amount: number, holder?: BudgetHolder): boolean {
    let free = this.capacity - this.used;
    if (free < amount) {
      if (!holder) {
        return false;
      }
      const threshold = (this.holders.get(holder) ?? 0) + amount;
      const victims = [...this.holders]
        .filter(([h, held]) => h !== holder && held > threshold)
        .map(([, held]) => held)
        .sort((a, b) => b - a)
        .slice(0, MAX_EVICTIONS);
      for (const held of victims) {
        if (free >= amount) {
          break;
        }
        free += held;
      }
      if (free < amount) {
        return false;
      }
    }
    return !this.parent || this.parent.couldFit(amount, holder);
  }

  private reserveNow(amount: number, holder?: BudgetHolder): boolean {
    for (let evictions = 0; this.used + amount > this.capacity; evictions++) {
      const victim =
        holder && evictions < MAX_EVICTIONS ? this.largerThan((this.holders.get(holder) ?? 0) + amount, holder) : null;
      if (!victim) {
        return false;
      }
      victim.evict();
    }
    if (this.parent && !this.parent.reserveNow(amount, holder)) {
      return false;
    }
    this.used += amount;
    if (holder) {
      this.holders.set(holder, (this.holders.get(holder) ?? 0) + amount);
    }
    return true;
  }

  release(amount: number, holder?: BudgetHolder): void {
    const given = Math.min(amount, this.used);
    this.used -= given;
    if (holder && this.holders.has(holder)) {
      const left = this.holders.get(holder)! - given;
      if (left > 0) {
        this.holders.set(holder, left);
      } else {
        this.holders.delete(holder);
      }
    }
    this.parent?.release(given, holder);
  }

  private largerThan(bytes: number, requester: BudgetHolder): BudgetHolder | null {
    let victim: BudgetHolder | null = null;
    let most = bytes;
    for (const [holder, held] of this.holders) {
      if (holder !== requester && held > most) {
        victim = holder;
        most = held;
      }
    }
    return victim;
  }
}

/** What one agent id, or all agents of one client address, may hold of the relay-wide answer budget. */
export function shareBytes(limits: Pick<RelayLimits, 'maxInflightBytes' | 'inflightShare'>): number {
  return Math.floor(limits.maxInflightBytes * limits.inflightShare);
}

/**
 * The client address for per-address limits: the trusted proxy's header
 * when TRUST_PROXY names one (the last x-forwarded-for entry, the one the
 * proxy added), else the socket address. Without a trusted proxy the
 * header is ignored, since anyone can send it.
 */
export function clientAddress(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
  trustProxy: string,
): string {
  if (trustProxy) {
    const raw = headers[trustProxy];
    const value = Array.isArray(raw) ? raw.at(-1) : raw;
    const address = trustProxy === 'x-forwarded-for' ? value?.split(',').at(-1) : value;
    if (address?.trim()) {
      return address.trim().slice(0, 64);
    }
  }
  return socketAddress ?? 'unknown';
}

/**
 * Per calling address, in front of one agent's own buckets (review M1):
 * anyone who knows an agent's public key can send it junk, and without this
 * one address could empty the agent's call and byte buckets for everyone.
 * Each address gets `callerShare` of them, so emptying the agent's buckets
 * takes several addresses. IPv6 callers count per /64 (`sourceKey`, the same
 * grouping as the agent's own per-address buckets): one host usually owns a
 * whole /64 and would otherwise get a fresh share, and push everyone else out
 * of the `maxCallers` entries, with every address it rotates through.
 * Bounded: past `maxCallers` the least recently seen key is forgotten (it
 * starts full again, which only helps an attacker who has that many
 * IPv4 addresses or /64s anyway).
 */
export class CallerLimiter {
  private readonly callers = new Map<string, { calls: TokenBucket; bytes: TokenBucket }>();

  constructor(
    private readonly limits: Pick<RelayLimits, 'callBurst' | 'callsPerMinute' | 'bytesPerHour' | 'callerShare'>,
    private readonly maxCallers = 256,
  ) {}

  /** Whether `address` may send a request of `bytes` now; charges nothing (see `charge`). */
  allows(address: string, bytes: number, now: number): boolean {
    const entry = this.entry(address, now);
    return entry.calls.has(1, now) && entry.bytes.has(bytes, now);
  }

  charge(address: string, bytes: number, now: number): void {
    const entry = this.entry(address, now);
    entry.calls.takeExact(1, now);
    entry.bytes.takeExact(bytes, now);
  }

  get size(): number {
    return this.callers.size;
  }

  private entry(address: string, now: number): { calls: TokenBucket; bytes: TokenBucket } {
    const key = sourceKey(address);
    let entry = this.callers.get(key);
    if (entry) {
      this.callers.delete(key); // re-inserted: the Map's order is least recently used first
    } else {
      const share = this.limits.callerShare;
      entry = {
        calls: new TokenBucket(
          Math.max(1, Math.floor(this.limits.callBurst * share)),
          (this.limits.callsPerMinute * share) / 60_000,
          now,
        ),
        bytes: new TokenBucket(
          Math.max(1, Math.floor(this.limits.bytesPerHour * share)),
          (this.limits.bytesPerHour * share) / 3_600_000,
          now,
        ),
      };
    }
    this.callers.set(key, entry);
    while (this.callers.size > this.maxCallers) {
      this.callers.delete(this.callers.keys().next().value!);
    }
    return entry;
  }
}
