import { describe, expect, it } from 'vitest';

import { emptyInventory, shutdownsOf } from '../inventory/inventory';
import { buildEvents, probeFailureWhileStopping } from './events';

describe('events view', () => {
  it('groups warnings about one object with one reason, summing counts and keeping the newest message', () => {
    const inv = emptyInventory(new Date());
    const ev = (
      name: string,
      reason: string,
      pod: string,
      first: string,
      last: string,
      count: number,
      message = reason,
    ) =>
      ({
        metadata: { name, namespace: 'd' },
        reason,
        message,
        count,
        firstTimestamp: first,
        lastTimestamp: last,
        involvedObject: { kind: 'Pod', name: pod, namespace: 'd' },
      }) as (typeof inv.events)[number];
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

describe('probe failures while a pod stops', () => {
  const shutdown = Date.parse('2026-11-27T14:29:03Z');
  const shutdowns = new Map([['default/api-gf955', shutdown]]);
  const probe = (name: string, pod: string, first: string, message: string, reason = 'Unhealthy') =>
    ({
      metadata: { name, namespace: 'default' },
      reason,
      message,
      count: 1,
      firstTimestamp: first,
      lastTimestamp: first,
      involvedObject: { kind: 'Pod', name: pod, namespace: 'default' },
    }) as ReturnType<typeof emptyInventory>['events'][number];

  it('leaves out readiness and liveness failures from the shutdown on, keeps everything else', () => {
    const inv = emptyInventory(new Date());
    inv.podShutdowns = shutdowns;
    inv.events = [
      // While stopping: 503 first, then the closed port.
      probe('a', 'api-gf955', '2026-11-27T14:29:08Z', 'Readiness probe failed: HTTP probe failed with statuscode: 503'),
      probe(
        'b',
        'api-gf955',
        '2026-11-27T14:29:28Z',
        'Readiness probe failed: Get "http://10.42.0.226:3000/health/readiness": dial tcp 10.42.0.226:3000: connect: connection refused',
      ),
      probe('c', 'api-gf955', '2026-11-27T14:29:02Z', 'Liveness probe failed: connection refused'),
      // Before the shutdown: a real problem, stays.
      probe('d', 'api-gf955', '2026-11-27T14:20:00Z', 'Readiness probe failed: HTTP probe failed with statuscode: 500'),
      // Another pod, and another reason on the stopping pod: stay.
      probe('e', 'api-other', '2026-11-27T14:29:10Z', 'Readiness probe failed: connection refused'),
      probe('f', 'api-gf955', '2026-11-27T14:29:11Z', 'Back-off restarting failed container', 'BackOff'),
    ];
    const rows = buildEvents(inv);
    expect(rows.map((r) => [r.name, r.reason, r.message?.slice(0, 30)])).toEqual([
      ['api-gf955', 'BackOff', 'Back-off restarting failed con'],
      ['api-other', 'Unhealthy', 'Readiness probe failed: connec'],
      ['api-gf955', 'Unhealthy', 'Readiness probe failed: HTTP p'],
    ]);
    expect(rows.find((r) => r.name === 'api-gf955' && r.reason === 'Unhealthy')!.message).toContain('500');
  });

  it('changes nothing without shutdown times (tests, an agent before the watch)', () => {
    const e = probe('a', 'api-gf955', '2026-11-27T14:29:08Z', 'Readiness probe failed: 503');
    expect(probeFailureWhileStopping(e, undefined)).toBe(false);
    expect(probeFailureWhileStopping(e, new Map())).toBe(false);
  });

  it('takes shutdown times from the watch and from pods listed with a deletionTimestamp', () => {
    const pods = [
      { metadata: { name: 'stopping', namespace: 'ns', deletionTimestamp: '2026-11-27T10:00:00Z' } },
      { metadata: { name: 'running', namespace: 'ns' } },
    ] as unknown as Parameters<typeof shutdownsOf>[0];
    const merged = shutdownsOf(pods, new Map([['ns/gone', 5]]));
    expect([...merged]).toEqual([
      ['ns/gone', 5],
      ['ns/stopping', Date.parse('2026-11-27T10:00:00Z')],
    ]);
  });
});
