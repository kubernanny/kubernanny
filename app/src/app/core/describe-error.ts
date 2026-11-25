import { HttpErrorResponse } from '@angular/common/http';
import { ProtocolError } from '@kubernanny/protocol';
import { TranslationKey } from '../i18n/dictionary';
import { Translator } from '../i18n/translator';
import { AgentError, InsecureTransportError } from './agent-error';

/** The relay's own refusals (docs/RELAY.md), for the person. */
const RELAY_MESSAGES: Record<string, TranslationKey> = {
  RELAY_AGENT_OFFLINE: 'errors.relayAgentOffline',
  RELAY_RATE_LIMITED: 'errors.relayRateLimited',
  RELAY_TIMEOUT: 'errors.relayTimeout',
  RELAY_TOO_LARGE: 'errors.relayTooLarge',
  RELAY_RESPONSE_TOO_LARGE: 'errors.relayResponseTooLarge',
  RELAY_FULL: 'errors.relayFull',
  // Also answered as a plain 429 when the relay or agent refuses before the encrypted exchange.
  PAIRING_RATE_LIMITED: 'errors.pairingRateLimited',
  // Existing texts fit: the relay is out of room, or the "agent" behind the id did not answer like one.
  RELAY_BUSY: 'errors.relayFull',
  RELAY_BAD_AGENT_RESPONSE: 'errors.tampered',
};

/** The code of a plain (unauthenticated) refusal of /api/e2e, if any. */
function plainCode(err: HttpErrorResponse): string | undefined {
  try {
    const body = err.error instanceof ArrayBuffer ? JSON.parse(new TextDecoder().decode(err.error)) : err.error;
    return (body as { code?: string } | null)?.code;
  } catch {
    return undefined;
  }
}

/**
 * A failure that a rolling update of the agent (or a blip on the way) causes
 * and that goes away within seconds: no answer at all, a gateway error, the
 * relay without its agent for a moment, the agent's own "being updated"
 * (AGENT_HANDOVER). Polls retry these quietly before showing anything.
 */
export function isTransient(err: unknown): boolean {
  if (err instanceof AgentError) {
    return err.code === 'AGENT_HANDOVER' || err.status === 503;
  }
  if (err instanceof HttpErrorResponse) {
    const code = plainCode(err);
    return err.status === 0 || err.status === 502 || err.status === 503 || err.status === 504 || code === 'RELAY_AGENT_OFFLINE' || code === 'RELAY_TIMEOUT';
  }
  return err instanceof Error && err.name === 'TimeoutError';
}

/** A sentence for the person, from whatever the call threw, in the UI language. */
export function describeError(err: unknown, tr: Translator): string {
  if (err instanceof InsecureTransportError) {
    return tr.t('errors.insecureTransport');
  }
  if (err instanceof ProtocolError) {
    return tr.t('errors.tampered');
  }
  if (err instanceof AgentError) {
    switch (err.code) {
      case 'PAIRING_CODE_INVALID':
        return tr.t('errors.pairingCodeInvalid');
      case 'DEVICE_UNKNOWN':
        return tr.t('errors.deviceUnknown');
      case 'PAIRING_UNAVAILABLE':
      case 'SETTING_LOCKED':
        // The agent explains these itself, in the language the app asked for.
        return err.message || tr.t('errors.status', { status: err.status });
      case 'PAIRING_RATE_LIMITED':
        return tr.t('errors.pairingRateLimited');
      case 'ACTION_DISABLED':
        return tr.t('errors.actionDisabled');
    }
    if (err.status === 403) {
      return tr.t('errors.forbidden');
    }
    return err.message || tr.t('errors.status', { status: err.status });
  }
  if (err instanceof HttpErrorResponse) {
    if (err.status === 0) {
      return tr.t('errors.unreachable');
    }
    const code = plainCode(err);
    if (code === 'E2E_HANDSHAKE') {
      return tr.t('errors.handshake');
    }
    if (code === 'E2E_RATE_LIMITED') {
      return tr.t('errors.busy');
    }
    if (code && code in RELAY_MESSAGES) {
      return tr.t(RELAY_MESSAGES[code]);
    }
    if (err.status === 404) {
      return tr.t('errors.notAnAgent');
    }
    return code ? tr.t('errors.refused', { code }) : tr.t('errors.status', { status: err.status });
  }
  if (err instanceof Error && err.name === 'TimeoutError') {
    return tr.t('errors.timeout');
  }
  return tr.t('errors.unknown');
}
