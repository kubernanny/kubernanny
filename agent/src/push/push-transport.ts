import type { DeadmanDeposit, DepositOutcome, PushOutcome, PushRequest } from '@kubernanny/protocol';

/** What carries a push out of the agent: the relay connection, the agent's only outbound one. */
export interface PushCarrier {
  /** Whether the relay said `push: true` on this connection; null while not connected. */
  available(): boolean | null;
  /** Whether the relay delivers status pushes as silent background messages (Ready `statusPush`). */
  statusAvailable?(): boolean;
  send(push: PushRequest): Promise<PushOutcome>;
  /** Whether the relay holds dead man's switch deposits (Ready `deadman`). */
  deadmanAvailable?(): boolean;
  /** Hands the dead man's switch messages to the relay (a Deposit frame). */
  deposit?(deposit: DeadmanDeposit): Promise<DepositOutcome>;
  /** Called on every registration with the relay (a new connection), with what the relay sent while the agent was away. */
  onReady?(listener: (event: RelayReady) => void): void;
}

/** A registration with the relay, as the dead man's switch needs it. */
export interface RelayReady {
  /** Counts up with every connection, so a deposit can be tied to the one it was made on. */
  connection: number;
  deadman: boolean;
  /** The key ids the relay sent deposited messages to while the agent was away, and for how long it was away (ms). */
  fired: { kids: string[]; awayMs: number } | null;
}

/**
 * The seam between AppPushService and RelayClient. RelayClient attaches
 * itself when it starts; AppPushService only ever talks to this. Kept apart
 * so the notifier (which the end-to-end service and the relay depend on)
 * does not depend on the relay in turn.
 */
export class PushTransport {
  private carrier: PushCarrier | null = null;
  private readonly readyListeners: ((event: RelayReady) => void)[] = [];

  attach(carrier: PushCarrier): void {
    this.carrier = carrier;
    carrier.onReady?.((event) => {
      for (const listener of this.readyListeners) {
        listener(event);
      }
    });
  }

  /** Every registration with the relay (the dead man's switch re-deposits at once and says when it is back). */
  onReady(listener: (event: RelayReady) => void): void {
    this.readyListeners.push(listener);
  }

  /** Whether the connected relay holds dead man's switch deposits. */
  deadmanAvailable(): boolean {
    return this.available() && this.carrier?.deadmanAvailable?.() === true;
  }

  /** `disabled` when no relay holds deposits now. */
  deposit(deposit: DeadmanDeposit): Promise<DepositOutcome> {
    return this.carrier?.deposit && this.deadmanAvailable()
      ? this.carrier.deposit(deposit)
      : Promise.resolve('disabled');
  }

  /** Whether a push could go out now: a relay is connected and offers push. */
  available(): boolean {
    return this.carrier?.available() === true;
  }

  /** Whether a silent status push could go out now: only to a relay that promised to keep it silent. */
  statusAvailable(): boolean {
    return this.available() && this.carrier?.statusAvailable?.() === true;
  }

  /** `disabled` without a relay or when it offers no push: the agent then never sends a Push frame. */
  send(push: PushRequest): Promise<PushOutcome> {
    return this.carrier && this.carrier.available() === true ? this.carrier.send(push) : Promise.resolve('disabled');
  }
}
