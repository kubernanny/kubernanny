import { describe, expect, it } from 'vitest';

import { DemoKubeClient } from '../demo/demo-cluster';
import { raw } from '../i18n/text';
import { EpisodeLog } from '../notify/digest';
import type { IssueView } from '../status/status.service';
import { de } from '../testing/i18n';
import { buildIncidents } from '../views/incidents';
import { IncidentsService } from './incidents.service';

const H = 3_600_000;
const D = 24 * H;
const issue = (id: string, since: number, extra: Partial<IssueView> = {}): IssueView => ({
  id,
  check: 'pods',
  module: 'pods',
  severity: 'warning',
  title: raw(id),
  cause: raw(''),
  actions: [],
  since: new Date(since).toISOString(),
  ...extra,
});

describe('incident history', () => {
  it('lists episodes newest first, with end, duration, module and whether they were silenced', () => {
    const log = new EpisodeLog(0);
    log.record([issue('a', 0)], H);
    log.record(
      [issue('a', 0, { silencedUntil: 'x' }), issue('b', 2 * H, { module: 'cnpg', severity: 'critical' })],
      2 * H,
    );
    log.record([issue('b', 2 * H, { module: 'cnpg', severity: 'critical' })], 3 * H);
    // a comes back: a second episode under the same issue id
    log.record([issue('a', 4 * H), issue('b', 2 * H, { module: 'cnpg', severity: 'critical' })], 4 * H);
    const view = buildIncidents(log.lastWeek(5 * H), 0, 5 * H, 7);
    expect(view.coveredSince).toBe(new Date(0).toISOString());
    expect(view.incidents.map((i) => [i.issueId, i.module, i.severity, i.end, i.durationMs, i.silenced])).toEqual([
      ['a', 'pods', 'warning', null, H, false],
      ['b', 'cnpg', 'critical', null, 3 * H, false],
      ['a', 'pods', 'warning', new Date(3 * H).toISOString(), 3 * H, true],
    ]);
    expect(new Set(view.incidents.map((i) => i.id)).size).toBe(3);
  });

  it('keeps only what touched the window asked for', () => {
    const log = new EpisodeLog(0);
    log.record([issue('old', 0)], H);
    log.record([], 2 * H);
    log.record([issue('open', 2 * H)], 3 * D);
    expect(buildIncidents(log.lastWeek(3 * D), 0, 3 * D, 1).incidents.map((i) => i.issueId)).toEqual(['open']);
    expect(buildIncidents(log.lastWeek(3 * D), 0, 3 * D, 7).incidents.map((i) => i.issueId)).toEqual(['open', 'old']);
  });

  it('starts empty on a real cluster, covering the time since the start', () => {
    const service = new IncidentsService();
    const view = service.view(7, Date.now());
    expect(view.incidents).toEqual([]);
    expect(Date.now() - Date.parse(view.coveredSince)).toBeLessThan(60_000);
  });

  it('gives the demo a week of resolved incidents, calm when healthy and rough when broken', () => {
    const count = (scenario: 'healthy' | 'warning' | 'broken') =>
      new IncidentsService(new DemoKubeClient(undefined, scenario)).view(7, Date.now());
    const healthy = count('healthy');
    expect(healthy.incidents.length).toBe(3);
    expect(healthy.incidents.find((i) => i.flaps)).toMatchObject({ issueId: 'nodes/rke2-node-2/not-ready', flaps: 4 });
    expect(healthy.incidents.every((i) => i.end !== null)).toBe(true);
    expect(Date.now() - Date.parse(healthy.coveredSince)).toBeGreaterThanOrEqual(7 * D - 60_000);
    expect(count('warning').incidents.length).toBe(5);
    const broken = de(count('broken'));
    expect(broken.incidents.length).toBe(8);
    expect(broken.incidents.some((i) => i.silenced)).toBe(true);
    expect(broken.incidents.map((i) => i.title)).toContain('Node rke2-node-5 NotReady');
    expect(buildIncidents([], 0, 1, 1).incidents).toEqual([]);
  });
});
