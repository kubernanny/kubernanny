import { RegistrationChallenge, fromBase64Url, randomBytes, toBase64Url } from '@kubernanny/protocol';
import { RegistrationOutcome, checkRegistration } from './registration';

/**
 * The registration state of one agent connection, shared by the Node relay
 * and the Worker's Durable Object. Plain data, so the Worker can keep it in
 * the socket's attachment across a hibernation.
 *
 *   pending     sent a challenge, waiting for the proof (one try)
 *   registered  proven; `registeredAt` decides which connection is newest
 *   ended       timed out, failed, evicted or replaced: never registers again
 */
export type Session =
  | { phase: 'pending'; agentId: string; since: number; nonce: string; secret: string; origin: string }
  | { phase: 'registered'; agentId: string; since: number; registeredAt: number }
  | { phase: 'ended'; agentId: string; since: number };

/**
 * A new connection for `agentId` and the Challenge frame to send it. `origin`
 * is this relay's public origin, the one the agent must have put into its
 * proof (protocol `relayOrigin`).
 */
export function openSession(agentId: string, origin: string, now: number): { session: Session; challenge: Uint8Array } {
  const nonce = randomBytes(32);
  const secret = randomBytes(32);
  return {
    session: { phase: 'pending', agentId, since: now, nonce: toBase64Url(nonce), secret: toBase64Url(secret), origin },
    challenge: new RegistrationChallenge(nonce, secret).frame(),
  };
}

export type ProofResult = { session: Session; outcome: RegistrationOutcome | null };

/**
 * The first binary message of a pending connection. A session that is not
 * pending ignores it (`outcome: null`); a failed proof ends the session, so
 * there is never a second try.
 */
export function proveSession(session: Session, message: Uint8Array, now: number): ProofResult {
  if (session.phase !== 'pending') {
    return { session, outcome: null };
  }
  const challenge = new RegistrationChallenge(fromBase64Url(session.nonce), fromBase64Url(session.secret));
  const outcome = checkRegistration(challenge, message, session.agentId, session.origin);
  return { session: outcome.ok ? { phase: 'registered', agentId: session.agentId, since: session.since, registeredAt: now } : endSession(session), outcome };
}

/** Drops the challenge and the registration: what a timed-out, failed, evicted or replaced connection keeps. */
export function endSession(session: Session): Session {
  return { phase: 'ended', agentId: session.agentId, since: session.since };
}

/** A pending session past the registration timeout. */
export function registrationExpired(session: Session, now: number, timeoutMs: number): boolean {
  return session.phase === 'pending' && now - session.since >= timeoutMs;
}

/** The newest registered of several connections (largest `registeredAt`): the one calls go to. */
export function newestRegistered<T>(items: readonly T[], sessionOf: (item: T) => Session | null): T | null {
  let best: T | null = null;
  let at = -Infinity;
  for (const item of items) {
    const session = sessionOf(item);
    if (session?.phase === 'registered' && session.registeredAt >= at) {
      best = item;
      at = session.registeredAt;
    }
  }
  return best;
}
