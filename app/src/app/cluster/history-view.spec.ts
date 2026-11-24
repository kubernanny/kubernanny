import { describe, expect, it } from 'vitest';
import { IncidentView, IncidentsView, ModuleView } from '../core/agent.model';
import { translatorFor } from '../i18n/translator';
import { historyView } from './history-view';

const de = translatorFor('de');
const en = translatorFor('en');
/** Local noon, so day boundaries are clear in any time zone of the test machine. */
const NOW = new Date(2026, 10, 24, 12, 0);
const at = (daysAgo: number, hour: number, minute = 0) => new Date(2026, 10, 24 - daysAgo, hour, minute).toISOString();
const modules = [{ id: 'argocd', name: 'Argo CD' }, { id: 'nodes', name: 'Nodes' }] as ModuleView[];

const incident = (over: Partial<IncidentView>): IncidentView => ({
  id: `${over.issueId ?? 'x'}@${over.start}`,
  issueId: 'x',
  title: 'Something broke',
  severity: 'warning',
  module: 'argocd',
  start: at(0, 9),
  end: null,
  durationMs: 0,
  silenced: false,
  ...over,
});

const view: IncidentsView = {
  coveredSince: at(10, 0),
  days: 7,
  incidents: [
    incident({ issueId: 'open', start: at(0, 9, 46), title: 'App web Degraded', severity: 'critical' }),
    incident({ issueId: 'sync', start: at(1, 17), end: at(1, 19, 14), durationMs: (2 * 60 + 14) * 60_000, silenced: true }),
    incident({ issueId: 'node', module: 'nodes', start: at(2, 18), end: at(2, 18, 7), durationMs: 7 * 60_000, severity: 'critical', title: 'Node down' }),
    incident({ issueId: 'cert', start: at(6, 8), end: at(6, 10), durationMs: 2 * 3_600_000 }),
    incident({ issueId: 'tiny', start: at(6, 7), end: at(6, 7, 1), durationMs: 40_000 }),
  ],
};

describe('historyView', () => {
  it('colours each of the last seven days by its worst incident, today last', () => {
    const v = historyView(view, modules, NOW, de);
    expect(v.days.map((d) => d.tone)).toEqual(['warning', 'ok', 'ok', 'ok', 'critical', 'warning', 'critical']);
    expect(v.days.map((d) => d.count)).toEqual([2, 0, 0, 0, 1, 1, 1]);
    expect(v.days[6]).toMatchObject({ label: 'Heute', today: true, title: 'Heute: 1 Problem' });
    expect(v.days[5].title).toBe('Gestern: 1 Problem');
    expect(v.days[1].title).toMatch(/: keine Probleme$/);
  });

  it('lists incidents by start day with module, time and duration; open ones keep counting', () => {
    const v = historyView(view, modules, NOW, de);
    expect(v.summary).toBe('5 Probleme in 7 Tagen');
    expect(v.groups.map((g) => g.label.slice(0, 7))).toEqual(['Heute', 'Gestern', v.groups[2].label.slice(0, 7), v.groups[3].label.slice(0, 7)]);
    const [open] = v.groups[0].rows;
    expect(open).toMatchObject({ tone: 'critical', icon: 'alert-circle', meta: 'Argo CD, 09:46', duration: 'noch offen, seit 2 h 14 min', open: true });
    expect(v.groups[1].rows[0]).toMatchObject({ duration: '2 h 14 min', silenced: true, open: false });
    expect(v.groups[2].rows[0].meta).toBe('Nodes, 18:00');
    expect(v.groups[3].rows.map((r) => r.duration)).toEqual(['2 h', '40 s']);
    // The overview shows the first four, still by day.
    expect(v.preview.flatMap((g) => g.rows).length).toBe(4);
    expect(v.coveredNote).toBeNull();
  });

  it('says what it cannot know when the agent has watched for less than a week', () => {
    const v = historyView({ ...view, coveredSince: at(2, 15), incidents: view.incidents.slice(0, 2) }, modules, NOW, en);
    expect(v.days.map((d) => d.tone)).toEqual(['muted', 'muted', 'muted', 'muted', 'ok', 'warning', 'critical']);
    expect(v.days[0].title).toMatch(/: not watched yet$/);
    expect(v.coveredNote).toMatch(/^Nothing known before .*: that is when the agent started watching\.$/);
    expect(v.groups[0].rows[0].duration).toBe('still open, for 2 h 14 min');
    expect(v.summary).toBe('2 issues in 7 days');
  });

  it('reads calm without incidents', () => {
    const v = historyView({ ...view, incidents: [] }, modules, NOW, en);
    expect(v.summary).toBe('No issues in the last 7 days.');
    expect(v.days.every((d) => d.tone === 'ok')).toBe(true);
    expect(v.groups).toEqual([]);
  });
});
