import { Injectable } from '@nestjs/common';
import type { PushOutcome, PushRequest } from '@kubernanny/protocol';

/** What carries a push out of the agent: the relay connection, the agent's only outbound one. */
export interface PushCarrier {
  /** Whether the relay said `push: true` on this connection; null while not connected. */
  available(): boolean | null;
  send(push: PushRequest): Promise<PushOutcome>;
}

/**
 * The seam between AppPushService and RelayClient. RelayClient attaches
 * itself when it starts; AppPushService only ever talks to this. Kept apart
 * so the notifier (which the end-to-end service and the relay depend on)
 * does not depend on the relay in turn.
 */
@Injectable()
export class PushTransport {
  private carrier: PushCarrier | null = null;

  attach(carrier: PushCarrier): void {
    this.carrier = carrier;
  }

  /** Whether a push could go out now: a relay is connected and offers push. */
  available(): boolean {
    return this.carrier?.available() === true;
  }

  /** `disabled` without a relay or when it offers no push: the agent then never sends a Push frame. */
  send(push: PushRequest): Promise<PushOutcome> {
    return this.carrier && this.carrier.available() === true ? this.carrier.send(push) : Promise.resolve('disabled');
  }
}
