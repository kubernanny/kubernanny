import { TranslationKey } from '../../i18n/dictionary';
import { Translator } from '../../i18n/translator';

/** The relay Kubernanny runs (docs/RELAY.md, "The public relay, fair use"). */
export const PUBLIC_RELAY_HOST = 'relay.kubernanny.app';

/** Outcomes the relay's own Firebase setup causes: the relay's operator fixes them, nobody else can. */
const SETUP = new Map<string, { what: TranslationKey; fix: TranslationKey }>([
  [
    'fcm_permission',
    { what: 'push.testOutcome.fcmPermission', fix: 'push.testFixOwn.fcmPermission' },
  ],
  ['fcm_auth', { what: 'push.testOutcome.fcmAuth', fix: 'push.testFixOwn.fcmAuth' }],
  ['apns_auth', { what: 'push.testOutcome.apnsAuth', fix: 'push.testFixOwn.apnsAuth' }],
]);

const OTHER = new Map<string, TranslationKey>([
  ['unregistered', 'push.testOutcome.unregistered'],
  ['rate_limited', 'push.testOutcome.rateLimited'],
  ['unavailable', 'push.testOutcome.unavailable'],
  ['invalid', 'push.testOutcome.invalid'],
  ['disabled', 'push.testOutcome.disabled'],
]);

/** Whether the agent pushes through the public relay; false for an own relay or none known. */
export function isPublicRelay(relayUrl: string | undefined): boolean {
  if (!relayUrl) {
    return false;
  }
  try {
    return new URL(relayUrl).hostname === PUBLIC_RELAY_HOST;
  } catch {
    return false;
  }
}

/**
 * What the test push's outcome (`POST /push/test`, protocol PushOutcome)
 * means, in words with what to do (docs/NOTIFICATIONS.md, "Test push
 * fails"). A refusal of the relay's Firebase setup names the fix for an own
 * relay, and says that it is the operator's to fix for the public one. An
 * outcome this app does not know yet (a newer agent) reads like `failed`,
 * with the raw value for the logs.
 */
export function pushTestResult(
  outcome: string,
  relayUrl: string | undefined,
  tr: Translator,
): { message: string; color: 'success' | 'danger' } {
  if (outcome === 'sent') {
    return { message: tr.t('push.testSent'), color: 'success' };
  }
  const setup = SETUP.get(outcome);
  if (setup) {
    const fix = isPublicRelay(relayUrl) ? tr.t('push.testFixPublic') : tr.t(setup.fix);
    return { message: `${tr.t(setup.what)} ${fix}`, color: 'danger' };
  }
  const other = OTHER.get(outcome);
  return {
    message: other ? tr.t(other) : tr.t('push.testFailed', { outcome }),
    color: 'danger',
  };
}
