import { ByteBudget, RelayLimits, shareBytes, TokenBucket } from './limits';
import { PushConfig } from './push';
import { AgentPushPolicy } from './push-policy';

/** How long an agent's push allowance outlives its connection: a reconnect within it continues instead of starting full (review M3). */
export const PUSH_MEMORY_MS = 3_600_000;

/**
 * The Node relay's per-address and relay-wide rules, apart from the sockets
 * so they can be tested without any: unproven connections and registered
 * agents per client address, the address' share of the answer budget, and
 * the push budgets per address, per agent id and for the whole relay.
 * `T` is whatever the hub uses for a connection.
 */
export class Admission<T> {
  readonly budget: ByteBudget;
  private readonly pending = new Map<string, number>();
  private readonly addresses = new Map<string, { agents: Set<T>; budget: ByteBudget; pushes: TokenBucket | null }>();
  private readonly relayPushes: TokenBucket | null;
  /** Push allowances by agent id, kept for PUSH_MEMORY_MS after the agent left. */
  private readonly pushPolicies = new Map<string, { policy: AgentPushPolicy; leftAt: number | null }>();

  constructor(
    private readonly limits: RelayLimits,
    private readonly push: PushConfig | null,
    now: number,
  ) {
    this.budget = new ByteBudget(limits.maxInflightBytes);
    // A sixth of the hour as burst, like the per-token limit.
    this.relayPushes = push
      ? new TokenBucket(Math.max(1, Math.ceil(push.relayPerHour / 6)), push.relayPerHour / 3_600_000, now)
      : null;
  }

  /** Why a new connection from `address` is refused at the upgrade, or null. `registered` is the relay's agent count. */
  refuseConnect(address: string, registered: number): 'full' | null {
    const own = this.agentsOf(address);
    const full = registered >= this.limits.maxAgents && this.largest()[1] <= own + 1;
    if (full || own >= this.limits.maxAgentsPerIp || (this.pending.get(address) ?? 0) >= this.limits.maxPendingPerIp) {
      return 'full';
    }
    return null;
  }

  addPending(address: string): void {
    this.pending.set(address, (this.pending.get(address) ?? 0) + 1);
  }

  removePending(address: string): void {
    const left = (this.pending.get(address) ?? 1) - 1;
    if (left > 0) {
      this.pending.set(address, left);
    } else {
      this.pending.delete(address);
    }
  }

  agentsOf(address: string): number {
    return this.addresses.get(address)?.agents.size ?? 0;
  }

  /** Registers `connection` under `address`; returns the address' share of the answer budget. */
  join(address: string, connection: T): ByteBudget {
    let entry = this.addresses.get(address);
    if (!entry) {
      const pushes = this.push
        ? new TokenBucket(
            Math.max(1, Math.ceil(this.push.addressPerHour / 6)),
            this.push.addressPerHour / 3_600_000,
            Date.now(),
          )
        : null;
      entry = { agents: new Set(), budget: new ByteBudget(shareBytes(this.limits), this.budget), pushes };
      this.addresses.set(address, entry);
    }
    entry.agents.add(connection);
    return entry.budget;
  }

  leave(address: string, connection: T): void {
    const entry = this.addresses.get(address);
    if (entry?.agents.delete(connection) && entry.agents.size === 0) {
      // The address' push bucket goes with it; the relay-wide budget and the per-agent allowances still hold.
      this.addresses.delete(address);
    }
  }

  /** The address with the most registered agents, and one of them (the oldest): the one that gives way when the relay is full. */
  largest(): [T | null, number] {
    let best: [T | null, number] = [null, 0];
    for (const entry of this.addresses.values()) {
      if (entry.agents.size > best[1]) {
        best = [entry.agents.values().next().value!, entry.agents.size];
      }
    }
    return best;
  }

  /** The push gate for agents of `address`: its own bucket and the relay's, both asked before either is charged. */
  pushGate(address: string): { allows(now: number): boolean; charge(now: number): void } {
    return {
      allows: (now) =>
        (this.addresses.get(address)?.pushes?.has(1, now) ?? true) && (this.relayPushes?.has(1, now) ?? true),
      charge: (now) => {
        this.addresses.get(address)?.pushes?.takeExact(1, now);
        this.relayPushes?.takeExact(1, now);
      },
    };
  }

  /** This agent id's push allowance, the one it left with if it was here within the hour. */
  pushPolicy(agentId: string, now: number): AgentPushPolicy | null {
    if (!this.push) {
      return null;
    }
    let entry = this.pushPolicies.get(agentId);
    if (!entry) {
      entry = {
        policy: new AgentPushPolicy(
          { burst: this.push.agentBurst, perHour: this.push.agentPerHour, tokensPerDay: this.push.tokensPerDay },
          now,
        ),
        leftAt: null,
      };
      this.pushPolicies.set(agentId, entry);
      this.capPushPolicies();
    }
    entry.leftAt = null;
    return entry.policy;
  }

  /** The agent id has no connection any more; its push allowance is kept for PUSH_MEMORY_MS. */
  pushPolicyLeft(agentId: string, now: number): void {
    const entry = this.pushPolicies.get(agentId);
    if (entry) {
      entry.leftAt = now;
    }
  }

  /** This agent id's push allowance if it has one, without marking the agent as back (the dead man's switch fires while it is away). */
  existingPushPolicy(agentId: string): AgentPushPolicy | null {
    return this.pushPolicies.get(agentId)?.policy ?? null;
  }

  /** Drops push allowances of agents gone for an hour, and earlier ones that have nothing left to remember. */
  prune(now: number): void {
    for (const [agentId, entry] of this.pushPolicies) {
      if (entry.leftAt !== null && (now - entry.leftAt >= PUSH_MEMORY_MS || entry.policy.isIdle(now))) {
        this.pushPolicies.delete(agentId);
      }
    }
  }

  /** Bounded: past twice the relay's agents, the allowances of agents that left longest ago go first. */
  private capPushPolicies(): void {
    const max = this.limits.maxAgents * 2;
    for (const [agentId, entry] of this.pushPolicies) {
      if (this.pushPolicies.size <= max) {
        return;
      }
      if (entry.leftAt !== null) {
        this.pushPolicies.delete(agentId);
      }
    }
  }

  get rememberedPushPolicies(): number {
    return this.pushPolicies.size;
  }

  clear(): void {
    this.pending.clear();
    this.addresses.clear();
    this.pushPolicies.clear();
  }
}
