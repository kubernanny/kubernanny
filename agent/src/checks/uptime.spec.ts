import { describe, expect, it } from 'vitest';
import { de, en } from '../testing/i18n';
import { evaluateGatus, evaluateUptimeKuma } from './uptime.check';

const result = (success: boolean, minute: number, extra = {}) => ({ success, timestamp: `2026-11-24T10:${String(minute).padStart(2, '0')}:00Z`, ...extra });

describe('Gatus', () => {
  it('reports endpoints whose newest result failed, one warning per group', () => {
    const v = evaluateGatus([
      { name: 'api', group: 'core', results: [result(false, 0), result(true, 5)] },
      { name: 'forum', group: 'core', results: [result(true, 0), result(false, 5, { status: 503, conditionResults: [{ condition: '[STATUS] == 200', success: false }] })] },
      { name: 'shop', group: 'core', results: [result(false, 5, { errors: ['context deadline exceeded'] })] },
      { name: 'dns', results: [result(false, 1)] },
      { name: 'new', group: 'core', results: [] },
    ]);
    expect(v).toMatchObject({ up: 1, down: 3, other: 1 });
    expect(v.issues.map((i) => [i.id, i.severity])).toEqual([
      ['gatus/group/core', 'warning'],
      ['gatus/group/-', 'warning'],
    ]);
    expect(de(v.issues[0]!)).toMatchObject({ title: 'Gatus-Gruppe core: 2 Endpunkte gestört', cause: 'Laut Gatus schlägt die letzte Prüfung fehl: forum, shop. Nicht erfüllt: [STATUS] == 200' });
    expect(en(v.issues[1]!)).toMatchObject({ title: 'Gatus: 1 endpoint down', cause: 'Gatus says the latest check failed: dns.' });
  });

  it('takes the newest result by its timestamp, whatever the order', () => {
    expect(evaluateGatus([{ name: 'a', results: [result(true, 9), result(false, 1)] }])).toMatchObject({ up: 1, down: 0 });
  });

  it('treats anything unexpected as no verdict, never as down', () => {
    for (const garbage of [null, {}, 'x', [null], [{ results: 'x' }], [{ results: [{ success: 'no' }] }]]) {
      expect(evaluateGatus(garbage)).toMatchObject({ issues: [], down: 0 });
    }
  });
});

describe('Uptime Kuma', () => {
  const page = {
    publicGroupList: [
      { id: 7, name: 'Web', monitorList: [{ id: 1, name: 'Shop' }, { id: 2, name: 'Blog' }] },
      { id: 8, name: 'Intern', monitorList: [{ id: 3, name: 'Git' }, { id: 4, name: 'Wiki' }] },
    ],
  };
  const beats = {
    heartbeatList: {
      '1': [{ status: 1, time: '2026-11-24 10:00:00.000' }, { status: 0, time: '2026-11-24 10:01:00.000' }],
      '2': [{ status: 0, time: '2026-11-24 10:00:00.000' }, { status: 1, time: '2026-11-24 10:01:00.000' }],
      '3': [{ status: 3, time: '2026-11-24 10:01:00.000' }],
    },
  };

  it('reports monitors whose newest heartbeat is down, per status page group', () => {
    const v = evaluateUptimeKuma(page, beats);
    expect(v).toMatchObject({ up: 1, down: 1, other: 2 });
    expect(v.issues.map((i) => i.id)).toEqual(['uptime-kuma/group/7']);
    expect(de(v.issues[0]!)).toMatchObject({ title: 'Uptime Kuma, Web: 1 Monitor down', cause: 'Laut Uptime Kuma ist der letzte Heartbeat fehlgeschlagen: Shop.' });
    expect(en(v.issues[0]!).title).toBe('Uptime Kuma, Web: 1 monitor down');
  });

  it('survives answers of another shape', () => {
    for (const [p, b] of [[null, null], [{ publicGroupList: 'x' }, beats], [page, { heartbeatList: null }], [{ publicGroupList: [{ monitorList: [{ id: 1 }] }] }, beats]] as const) {
      expect(() => evaluateUptimeKuma(p, b)).not.toThrow();
    }
    expect(evaluateUptimeKuma({ publicGroupList: [{ monitorList: [{ id: 1 }] }] }, beats).issues[0]?.id).toBe('uptime-kuma/group/#0');
  });
});
