import { pushTokenDigest } from '@kubernanny/protocol';

/** Strikes before a token is forgotten, and the least time between two of them. */
const UNREGISTERED_STRIKES = 3;
export const STRIKE_GAP_MS = 3_600_000;
const MAX_TRACKED = 1024;

/**
 * Whether the relay's `unregistered` for a push token is believed. The relay
 * is not trusted (docs/RELAY.md), and a hostile one could answer every push
 * `unregistered` to make the agent delete every device's push registration.
 * So a token is only forgotten after FCM's verdict, as relayed, came back on
 * UNREGISTERED_STRIKES separate pushes at least STRIKE_GAP_MS apart; a
 * `sent` in between clears its record. A token that is really gone costs a
 * few failed pushes over two hours; a hostile relay gains nothing it could
 * not have by dropping pushes. In memory only (a restart starts over, which
 * only delays forgetting); keyed by digest, so no token is held twice.
 */
export class UnregisteredStrikes {
  private readonly strikes = new Map<string, { count: number; last: number }>();

  /** Records one push's outcome for `token`; true when the token should now be forgotten. */
  record(token: string, outcome: string, now: number): boolean {
    const digest = pushTokenDigest(token);
    if (outcome === 'sent') {
      this.strikes.delete(digest);
      return false;
    }
    if (outcome !== 'unregistered') {
      return false;
    }
    const entry = this.strikes.get(digest);
    if (!entry) {
      this.strikes.set(digest, { count: 1, last: now });
      while (this.strikes.size > MAX_TRACKED) {
        this.strikes.delete(this.strikes.keys().next().value!);
      }
      return UNREGISTERED_STRIKES <= 1;
    }
    if (now - entry.last < STRIKE_GAP_MS) {
      return false; // the same verdict again within the hour counts once
    }
    entry.count++;
    entry.last = now;
    if (entry.count >= UNREGISTERED_STRIKES) {
      this.strikes.delete(digest);
      return true;
    }
    return false;
  }
}
