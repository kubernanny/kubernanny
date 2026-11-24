import { describe, expect, it } from 'vitest';
import { checkStatusPageSlug } from './config';

describe('UPTIME_KUMA_STATUS_PAGE', () => {
  it('takes a slug as Uptime Kuma writes it and refuses anything that could leave the URL path', () => {
    expect(checkStatusPageSlug(undefined)).toBeUndefined();
    expect(checkStatusPageSlug(' Homelab ')).toBe('homelab');
    expect(checkStatusPageSlug('my-status-2')).toBe('my-status-2');
    for (const bad of ['../admin', 'a/b', 'a?b', 'with space', '-x']) {
      expect(() => checkStatusPageSlug(bad), bad).toThrow(/UPTIME_KUMA_STATUS_PAGE/);
    }
  });
});
