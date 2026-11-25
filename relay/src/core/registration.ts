import { FrameType, RegistrationChallenge, RelayClose, RelayFrameError, decodeFrame } from '@kubernanny/protocol';

export type RegistrationOutcome = { ok: true } | { ok: false; close: number; reason: string };

/**
 * The first binary message of a connection must be the Proof for the
 * challenge the relay sent, for the id in the URL, made for this relay's
 * `origin`. Anything else ends the connection; there is no second try on the
 * same socket.
 */
export function checkRegistration(challenge: RegistrationChallenge, message: Uint8Array, agentId: string, origin: string): RegistrationOutcome {
  let frame;
  try {
    frame = decodeFrame(message);
  } catch (err) {
    if (err instanceof RelayFrameError) {
      return { ok: false, close: RelayClose.Protocol, reason: 'bad frame' };
    }
    throw err;
  }
  if (frame.type !== FrameType.Proof || frame.callId !== 0) {
    return { ok: false, close: RelayClose.Protocol, reason: 'expected proof' };
  }
  if (!challenge.verify(frame.payload, agentId, origin)) {
    return { ok: false, close: RelayClose.ProofFailed, reason: 'proof failed' };
  }
  return { ok: true };
}
