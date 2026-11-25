import { describe, expect, it } from 'vitest';
import { STRIKE_GAP_MS, UnregisteredStrikes } from './unregistered-strikes';

const TOKEN = 'cXVpdGUtYS10b2tlbg:APA91bHPRgkF-test_token';

describe('a hostile relay cannot wipe push registrations (review)', () => {
  it('believes unregistered only on three pushes at least an hour apart', () => {
    const strikes = new UnregisteredStrikes();
    expect(strikes.record(TOKEN, 'unregistered', 0)).toBe(false);
    // A burst within the hour counts once, however many pushes the relay answers that way.
    for (let i = 1; i < 50; i++) {
      expect(strikes.record(TOKEN, 'unregistered', i * 1000)).toBe(false);
    }
    expect(strikes.record(TOKEN, 'unregistered', STRIKE_GAP_MS)).toBe(false);
    expect(strikes.record(TOKEN, 'unregistered', 2 * STRIKE_GAP_MS)).toBe(true);
  });

  it('starts over after a push went through, and ignores other outcomes', () => {
    const strikes = new UnregisteredStrikes();
    strikes.record(TOKEN, 'unregistered', 0);
    strikes.record(TOKEN, 'unregistered', STRIKE_GAP_MS);
    strikes.record(TOKEN, 'sent', STRIKE_GAP_MS + 1);
    expect(strikes.record(TOKEN, 'unregistered', 2 * STRIKE_GAP_MS)).toBe(false);
    expect(strikes.record(TOKEN, 'invalid', 3 * STRIKE_GAP_MS)).toBe(false);
  });
});
