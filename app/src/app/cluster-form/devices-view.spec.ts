import { describe, expect, it } from 'vitest';

import { translatorFor } from '../i18n/translator';
import { deviceRows } from './devices-view';

const NOW = new Date(2026, 10, 24, 12, 0);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe('deviceRows', () => {
  it('says when a device was paired and last active', () => {
    const [row] = deviceRows(
      [
        {
          id: 'a',
          name: 'iPhone',
          createdAt: hoursAgo(48),
          lastSeenAt: hoursAgo(2),
          current: true,
        },
      ],
      NOW,
      translatorFor('de'),
    );
    expect(row).toMatchObject({ id: 'a', name: 'iPhone', current: true });
    expect(row.meta).toMatch(/^gekoppelt .+, zuletzt aktiv .+$/);
  });

  it('says so when a device has not been seen since the agent started', () => {
    const [row] = deviceRows(
      [{ id: 'b', name: 'Pixel', createdAt: hoursAgo(5), lastSeenAt: null, current: false }],
      NOW,
      translatorFor('en'),
    );
    expect(row.meta).toMatch(/^paired .+, not active since the agent started$/);
  });
});
