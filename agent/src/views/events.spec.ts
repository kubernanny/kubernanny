import { describe, expect, it } from 'vitest';
import { emptyInventory } from '../inventory/inventory';
import { buildEvents } from './events';

describe('events view', () => {
  it('groups warnings about one object with one reason, summing counts and keeping the newest message', () => {
    const inv = emptyInventory(new Date());
    const ev = (name: string, reason: string, pod: string, first: string, last: string, count: number, message = reason) =>
      ({ metadata: { name, namespace: 'd' }, reason, message, count, firstTimestamp: first, lastTimestamp: last, involvedObject: { kind: 'Pod', name: pod, namespace: 'd' } }) as (typeof inv.events)[number];
    inv.events = [
      ev('a', 'FailedScheduling', 'web', '2026-11-24T08:00:00Z', '2026-11-24T09:00:00Z', 3, 'old'),
      ev('b', 'FailedScheduling', 'web', '2026-11-24T09:10:00Z', '2026-11-24T10:00:00Z', 5, 'new'),
      ev('c', 'BackOff', 'web', '2026-11-24T09:30:00Z', '2026-11-24T09:30:00Z', 1),
      ev('d', 'FailedScheduling', 'db', '2026-11-24T07:00:00Z', '2026-11-24T07:00:00Z', 1),
    ];
    const rows = buildEvents(inv);
    expect(rows.map((r) => [r.name, r.reason, r.count, r.events])).toEqual([
      ['web', 'FailedScheduling', 8, 2],
      ['web', 'BackOff', 1, 1],
      ['db', 'FailedScheduling', 1, 1],
    ]);
    expect(rows[0]).toMatchObject({ time: '2026-11-24T10:00:00Z', firstSeen: '2026-11-24T08:00:00Z', message: 'new' });
  });
});
