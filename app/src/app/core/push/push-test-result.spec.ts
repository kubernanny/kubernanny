import { describe, expect, it } from 'vitest';

import { translatorFor } from '../../i18n/translator';
import { isPublicRelay, pushTestResult } from './push-test-result';

const de = translatorFor('de');
const en = translatorFor('en');
const PUBLIC = 'https://relay.kubernanny.app';
const OWN = 'https://relay.example.org';

describe('the test push result', () => {
  it('says it was sent', () => {
    expect(pushTestResult('sent', PUBLIC, de)).toEqual({
      message: 'Test-Push gesendet.',
      color: 'success',
    });
  });

  it('names the missing permission and how to fix it on an own relay', () => {
    const { message, color } = pushTestResult('fcm_permission', OWN, de);
    expect(color).toBe('danger');
    expect(message).toContain('Firebase lehnt den Versand ab: Beim Relay fehlt die Berechtigung');
    expect(message).toContain('Firebase Cloud Messaging API Admin');
    expect(message).not.toContain('öffentlichen Relay');
  });

  it("says that the public relay's setup is its operator's to fix", () => {
    for (const outcome of ['fcm_permission', 'fcm_auth', 'apns_auth']) {
      const { message } = pushTestResult(outcome, PUBLIC, de);
      expect(message).toContain('Das muss der Betreiber des Relays beheben.');
      expect(message).not.toContain('FCM_SERVICE_ACCOUNT');
    }
    expect(pushTestResult('apns_auth', PUBLIC, en).message).toContain(
      'The Apple key is missing in Firebase',
    );
  });

  it('explains the other outcomes, and reads one it does not know as failed', () => {
    expect(pushTestResult('unregistered', OWN, de).message).toBe(
      'Dieses Gerät ist bei Firebase nicht mehr bekannt: Push aus- und wieder einschalten.',
    );
    expect(pushTestResult('fcm_auth', OWN, en).message).toContain('FCM_SERVICE_ACCOUNT');
    expect(pushTestResult('rate_limited', OWN, en).message).toBe(
      'Too many pushes in a short time. Try again later.',
    );
    expect(pushTestResult('exploded', undefined, de).message).toBe(
      'Das Relay hat den Test-Push nicht angenommen (exploded). Den Grund nennen die Logs des Relays.',
    );
  });

  it('has no em or en dash in any of its texts', () => {
    const outcomes = [
      'sent',
      'unregistered',
      'rate_limited',
      'unavailable',
      'invalid',
      'disabled',
      'failed',
    ];
    for (const tr of [de, en]) {
      for (const outcome of [...outcomes, 'fcm_permission', 'fcm_auth', 'apns_auth']) {
        for (const relay of [PUBLIC, OWN]) {
          expect(pushTestResult(outcome, relay, tr).message).not.toMatch(/[–—]/);
        }
      }
    }
  });

  it('knows the public relay by its host', () => {
    expect(isPublicRelay(PUBLIC)).toBe(true);
    expect(isPublicRelay('https://relay.kubernanny.app/')).toBe(true);
    expect(isPublicRelay(OWN)).toBe(false);
    expect(isPublicRelay(undefined)).toBe(false);
    expect(isPublicRelay('not a url')).toBe(false);
  });
});
