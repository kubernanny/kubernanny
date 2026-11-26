import { describe, expect, it } from 'vitest';

import { Snapshot } from '../core/agent.model';
import { translatorFor } from '../i18n/translator';
import { buildClusterView } from './cluster-view';
import { maintenanceChoices, maintenanceView } from './maintenance-view';

const de = translatorFor('de');
const en = translatorFor('en');
const NOW = new Date(2026, 10, 24, 12, 0);
const plain = (s: string) => s.replace(/[  ]/g, ' ');

describe('maintenanceView', () => {
  it('says until when notifications wait, in both languages', () => {
    const until = new Date(2026, 10, 24, 14, 30).toISOString();
    expect(maintenanceView(until, NOW, de)).toEqual({
      active: true,
      status: 'Aktiv bis 14:30',
      banner: 'Wartung bis 14:30: keine Benachrichtigungen',
      time: '14:30',
    });
    const v = maintenanceView(until, NOW, en);
    expect(plain(v.banner)).toBe('Maintenance until 2:30 PM: no notifications');
    expect(plain(v.status)).toBe('Active until 2:30 PM');
  });

  it('names the weekday when the window ends on another day', () => {
    expect(maintenanceView(new Date(2026, 10, 25, 9, 0).toISOString(), NOW, de).banner).toMatch(
      /^Wartung bis Mi\.?, 09:00: keine Benachrichtigungen$/,
    );
  });

  it('reads as none without a window or once it has ended', () => {
    const none = { active: false, status: '', banner: '', time: '' };
    expect(maintenanceView(undefined, NOW, de)).toEqual(none);
    expect(maintenanceView(null, NOW, de)).toEqual(none);
    expect(maintenanceView(new Date(2026, 10, 24, 11, 59).toISOString(), NOW, de)).toEqual(none);
  });

  it('offers the hours the agent accepts', () => {
    expect(maintenanceChoices(de).map((c) => c.label)).toEqual([
      '1 Stunde',
      '2 Stunden',
      '4 Stunden',
      '8 Stunden',
      '24 Stunden',
    ]);
    expect(maintenanceChoices(en).map((c) => [c.hours, c.label])).toEqual([
      [1, '1 hour'],
      [2, '2 hours'],
      [4, '4 hours'],
      [8, '8 hours'],
      [24, '24 hours'],
    ]);
  });

  it('is part of the cluster view the overview reads', () => {
    const snapshot = {
      cluster: 'c',
      light: 'green',
      score: 100,
      checkedAt: NOW.toISOString(),
      durationMs: 5,
      modules: [],
      issues: [],
      maintenanceUntil: new Date(2026, 10, 24, 14, 30).toISOString(),
    } as unknown as Snapshot;
    expect(buildClusterView(snapshot, null, NOW, de).maintenance.banner).toBe(
      'Wartung bis 14:30: keine Benachrichtigungen',
    );
    expect(
      buildClusterView({ ...snapshot, maintenanceUntil: undefined }, null, NOW, de).maintenance
        .active,
    ).toBe(false);
  });
});
