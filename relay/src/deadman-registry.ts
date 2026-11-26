import { DeadmanDeposit, DepositOutcome } from '@kubernanny/protocol';
import { Admission } from './core/admission';
import { DeadmanConfig, DeadmanState, HeldItem, agentBack, agentLost, depositInto, dueItems, emptyDeadman, expire, fireDue, heldBytes, isIdle, markSent, nextWake } from './core/deadman';
import { idPrefix } from './core/http';
import { PushSender } from './core/push';

/** The metrics the registry reports to (RelayMetrics). */
export interface DeadmanMetrics {
  deadmanDeposits: number;
  deadmanEvent(event: string): void;
}

/**
 * The Node relay's dead man's switch (core/deadman.ts has the rules): one
 * state per agent id and a timer for the next message due while the agent
 * is away. In memory: a restart of the relay forgets every deposit, and
 * nothing is sent for an agent that was away across it (docs/RELAY.md says
 * so). Bounded by RELAY_DEADMAN_MAX_TOTAL_BYTES across all agents.
 */
export class DeadmanRegistry {
  private readonly entries = new Map<string, { state: DeadmanState; timer: ReturnType<typeof setTimeout> | null }>();
  private bytes = 0;

  constructor(
    private readonly config: DeadmanConfig,
    private readonly send: PushSender | null,
    private readonly admission: Pick<Admission<unknown>, 'existingPushPolicy' | 'pushGate'>,
    private readonly metrics: DeadmanMetrics,
    private readonly log: (line: string) => void,
    /** Whether a connection of this agent is registered right now. */
    private readonly connected: (agentId: string) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** For tests and diagnostics. */
  state(agentId: string): DeadmanState | null {
    return this.entries.get(agentId)?.state ?? null;
  }

  get heldBytes(): number {
    return this.bytes;
  }

  /** A Deposit frame from the agent's registered connection. */
  deposit(agentId: string, deposit: DeadmanDeposit | null): DepositOutcome {
    const now = this.now();
    const before = this.entries.get(agentId)?.state ?? emptyDeadman();
    const room = this.config.maxTotalBytes - (this.bytes - heldBytes(before));
    const { state, outcome } = depositInto(expire(before, now), deposit, this.config, now, room);
    this.set(agentId, state);
    this.metrics.deadmanEvent(`deposit_${outcome}`);
    return outcome;
  }

  /** The agent's connection is gone (last heard at `heardAt`): the switch arms. */
  lost(agentId: string, heardAt: number): void {
    const entry = this.entries.get(agentId);
    if (!entry || entry.state.items.length === 0) {
      return;
    }
    this.set(agentId, agentLost(entry.state, heardAt));
    this.schedule(agentId);
  }

  /** The agent registered again: disarmed; what went out while it was away is returned for its Ready. */
  back(agentId: string): { k: string[]; m: number } | null {
    const entry = this.entries.get(agentId);
    if (!entry) {
      return null;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const { state, fired } = agentBack(entry.state, this.now());
    this.set(agentId, state);
    return fired;
  }

  /** Expired deposits go; states with nothing left to remember for agents not connected are dropped. */
  sweep(now = this.now()): void {
    for (const [agentId, entry] of [...this.entries]) {
      this.set(agentId, expire(entry.state, now));
      if (!this.connected(agentId) && isIdle(this.entries.get(agentId)!.state, this.config, now)) {
        this.drop(agentId);
      }
    }
  }

  clear(): void {
    for (const agentId of [...this.entries.keys()]) {
      this.drop(agentId);
    }
  }

  private schedule(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (!entry) {
      return;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    const wake = entry.state.lostAt === null ? null : nextWake(entry.state);
    if (wake === null) {
      return;
    }
    // setTimeout holds at most about 24.8 days; a deposit lives 27 hours at most.
    entry.timer = setTimeout(() => void this.fire(agentId), Math.min(2 ** 31 - 1, Math.max(0, wake - this.now())));
    entry.timer.unref?.();
  }

  /** Sends what is due, each message once; then waits for the next one, or the deposit's end. */
  private async fire(agentId: string): Promise<void> {
    const entry = this.entries.get(agentId);
    if (!entry || !this.send) {
      return;
    }
    entry.timer = null;
    const now = this.now();
    const due: HeldItem[] = dueItems(entry.state, now);
    this.set(agentId, expire(markSent(entry.state, due), now));
    if (due.length > 0) {
      const policy = this.admission.existingPushPolicy(agentId);
      // No address: the relay-wide push budget only (the agent's address is gone with its connection).
      const gate = this.admission.pushGate('');
      const outcomes = await fireDue(
        due,
        {
          send: this.send,
          allows: (digest, at) => (policy?.allows(digest, at) ?? true) && gate.allows(at),
          charge: (digest, at) => {
            policy?.charge(digest, at);
            gate.charge(at);
          },
        },
        now,
      );
      for (const outcome of outcomes) {
        this.metrics.deadmanEvent(`fired_${outcome}`);
      }
      this.log(`agent ${idPrefix(agentId)} silent: sent ${outcomes.filter((o) => o === 'sent').length} of ${due.length} dead man's switch message(s)`);
    }
    if (!this.connected(agentId)) {
      this.schedule(agentId);
    }
  }

  private set(agentId: string, state: DeadmanState): void {
    const entry = this.entries.get(agentId);
    this.bytes += heldBytes(state) - (entry ? heldBytes(entry.state) : 0);
    this.metrics.deadmanDeposits += (state.items.length > 0 ? 1 : 0) - (entry && entry.state.items.length > 0 ? 1 : 0);
    if (entry) {
      entry.state = state;
    } else {
      this.entries.set(agentId, { state, timer: null });
    }
  }

  private drop(agentId: string): void {
    const entry = this.entries.get(agentId);
    if (entry) {
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      this.bytes -= heldBytes(entry.state);
      this.metrics.deadmanDeposits -= entry.state.items.length > 0 ? 1 : 0;
      this.entries.delete(agentId);
    }
  }
}
