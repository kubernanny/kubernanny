import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentError } from '../agent-error';
import { BackupsView, IncidentsView, Snapshot } from '../agent.model';
import { translatorFor } from '../../i18n/translator';
import { buildClusterView } from '../../cluster/cluster-view';
import { DemoAgent, applySettings, judge } from './demo-agent';
import { DemoData, shiftTimes } from './demo-data';

const PUBLIC = join(__dirname, '../../../../public');
const recording = (scenario: string, lang = 'de') => JSON.parse(readFileSync(join(PUBLIC, `demo/${scenario}.${lang}.json`), 'utf8')) as DemoData;
/** Serves app/public like the static hosting; the recordings without a language are not needed. */
const serve = (url: string) => new Response(readFileSync(join(PUBLIC, url), 'utf8'));

describe('demo recordings', () => {
  it('exist for every scenario and match what the scenario promises', () => {
    for (const lang of ['de', 'en']) {
      expect(recording('broken', lang).status.light).toBe('red');
      expect(recording('warning', lang).status.light).toBe('yellow');
      expect(recording('healthy', lang).status.issues).toEqual([]);
      expect(recording('broken', lang).incidents?.incidents.length).toBeGreaterThan(0);
      expect(recording('broken', lang).backups?.rows.length).toBeGreaterThan(0);
    }
  });

  it('carry logs for every logs action they offer', () => {
    const data = recording('broken');
    for (const issue of data.status.issues) {
      issue.actions.filter((a) => a.type === 'logs').forEach((_, index) => expect(data.logs[`${issue.id}#${index}`], issue.id).toBeDefined());
    }
  });
});

describe('shiftTimes', () => {
  it('moves ISO times and chart points, and nothing else', () => {
    const hour = 3_600_000;
    const shifted = shiftTimes({ since: '2026-11-24T10:00:00.000Z', name: '2026-11-24', points: [[1795000000000, 0.5]], count: 3, pair: [3, 4] }, hour);
    expect(shifted).toEqual({ since: '2026-11-24T11:00:00.000Z', name: '2026-11-24', points: [[1795000000000 + hour, 0.5]], count: 3, pair: [3, 4] });
  });
});

describe('DemoAgent', () => {
  let agent: DemoAgent;

  beforeEach(() => {
    agent = new DemoAgent();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => serve(url)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('answers the status as of now', async () => {
    const snapshot = await agent.call<Snapshot>('broken', 'GET', '/status');
    expect(snapshot.light).toBe('red');
    expect(Math.abs(Date.parse(snapshot.checkedAt!) - Date.now())).toBeLessThan(5000);
    // Issue ages read like the recording's, moved to now.
    expect(snapshot.issues.every((i) => Date.parse(i.since) <= Date.now() + 1000)).toBe(true);
  });

  it('pretends an action worked and takes the issue away, recomputing the light', async () => {
    const before = await agent.call<Snapshot>('warning', 'GET', '/status');
    for (const issue of before.issues) {
      const action = issue.actions.find((a) => a.type !== 'logs');
      if (action) {
        const done = await agent.call<{ done: string }>('warning', 'POST', `/actions/${action.type}?${new URLSearchParams({ issue: issue.id, index: '0' })}`);
        expect(done.done).toContain('Demo');
        await expect(agent.call('warning', 'POST', `/actions/${action.type}?${new URLSearchParams({ issue: issue.id })}`)).rejects.toBeInstanceOf(AgentError);
      }
    }
    const after = await agent.call<Snapshot>('warning', 'GET', '/status');
    expect(after.issues.length).toBeLessThanOrEqual(before.issues.length);
  });

  it('switches modules off and hides their issues', async () => {
    const before = await agent.call<Snapshot>('broken', 'GET', '/status');
    const module = before.issues[0]!.module;
    await agent.call('broken', 'POST', '/settings', { modules: { [module]: false } });
    const after = await agent.call<Snapshot>('broken', 'GET', '/status');
    expect(after.issues.some((i) => i.module === module)).toBe(false);
  });

  it('silences issues: still listed, no longer red, and the view shows them apart', async () => {
    const before = await agent.call<Snapshot>('broken', 'GET', '/status');
    for (const issue of before.issues.filter((i) => i.severity === 'critical')) {
      await agent.call('broken', 'POST', `/issues/silence?${new URLSearchParams({ issue: issue.id, hours: '8' })}`);
    }
    const after = await agent.call<Snapshot>('broken', 'GET', '/status');
    expect(after.light).toBe('yellow');
    expect(after.issues).toHaveLength(before.issues.length);
    const view = buildClusterView(after, null, new Date(), translatorFor('de'));
    expect(view.silenced.length).toBe(before.issues.filter((i) => i.severity === 'critical').length);
    expect(view.silenced[0]!.silencedText).toMatch(/^stumm bis /);
    expect(view.issues.every((c) => !c.issue.silencedUntil && c.canSilence)).toBe(true);
  });

  it('accepts an advisory: it leaves its issue, the issue goes when nothing remains, and comes back when taken back', async () => {
    const before = await agent.call<Snapshot>('broken', 'GET', '/status', undefined, 'en');
    const issue = before.issues.find((i) => i.id.startsWith('vulnerabilities/'))!;
    const component = issue.id.slice('vulnerabilities/'.length);
    const advisory = issue.advisories![0]!;
    expect(before.modules.find((m) => m.id === 'vulnerabilities')!.canAccept).toBe(true);
    await expect(agent.call('broken', 'POST', '/vulnerabilities/accept', { component, advisory, days: 7 })).rejects.toBeInstanceOf(AgentError);
    await agent.call('broken', 'POST', '/vulnerabilities/accept', { component, advisory, days: 90, reason: 'not exposed' }, 'en');
    const after = await agent.call<Snapshot>('broken', 'GET', '/status', undefined, 'en');
    const left = after.issues.find((i) => i.id === issue.id);
    expect(left?.advisories ?? []).not.toContain(advisory);
    const sheet = after.modules.find((m) => m.id === 'vulnerabilities')!;
    expect(sheet.accepted).toEqual([expect.objectContaining({ component, advisory, reason: 'not exposed', by: 'Demo device' })]);
    if (issue.advisories!.length === 1) {
      expect(left).toBeUndefined();
      expect(sheet.issueIds).not.toContain(issue.id);
    }
    await agent.call('broken', 'POST', '/vulnerabilities/unaccept', { component, advisory }, 'en');
    expect((await agent.call<Snapshot>('broken', 'GET', '/status', undefined, 'en')).issues.find((i) => i.id === issue.id)?.advisories).toContain(advisory);
  });

  it('answers from the recording in the UI language, keeping what was done across a switch', async () => {
    const fetched = vi.mocked(fetch);
    const before = await agent.call<Snapshot>('warning', 'GET', '/status', undefined, 'en');
    expect(fetched.mock.calls.map(([url]) => String(url))).toContain('demo/warning.en.json');
    const issue = before.issues.find((i) => i.actions.some((a) => a.type !== 'logs'))!;
    const action = issue.actions.find((a) => a.type !== 'logs')!;
    const { done } = await agent.call<{ done: string }>('warning', 'POST', `/actions/${action.type}?${new URLSearchParams({ issue: issue.id, index: '0' })}`, undefined, 'en');
    expect(done).toMatch(/^Demo: .* is fixed\./);
    const german = await agent.call<Snapshot>('warning', 'GET', '/status', undefined, 'de');
    expect(german.issues.map((i) => i.id)).not.toContain(issue.id);
  });

  it('answers the incident history in step with what the demo shows', async () => {
    const status = await agent.call<Snapshot>('broken', 'GET', '/status');
    const view = await agent.call<IncidentsView>('broken', 'GET', '/incidents?days=7');
    const open = view.incidents.filter((i) => i.end === null);
    expect(open.length).toBeGreaterThan(0);
    // An open incident starts when its issue does, not when the recording was made.
    for (const i of open) {
      expect(i.start).toBe(status.issues.find((x) => x.id === i.issueId)?.since ?? i.start);
    }
    expect(view.incidents.map((i) => Date.parse(i.start))).toEqual([...view.incidents.map((i) => Date.parse(i.start))].sort((a, b) => b - a));
    expect(Date.parse(view.coveredSince)).toBeLessThan(Date.now() - 6 * 86_400_000);

    const target = status.issues.find((i) => i.actions.some((a) => a.type === 'restart'))!;
    await agent.call('broken', 'POST', `/actions/restart?${new URLSearchParams({ issue: target.id, index: '0' })}`);
    const after = await agent.call<IncidentsView>('broken', 'GET', '/incidents');
    const fixed = after.incidents.find((i) => i.issueId === target.id && i.start === target.since)!;
    expect(fixed.end).not.toBeNull();

    const silencedId = open.find((i) => i.issueId !== target.id)!.issueId;
    await agent.call('broken', 'POST', `/issues/silence?${new URLSearchParams({ issue: silencedId, hours: '1' })}`);
    expect((await agent.call<IncidentsView>('broken', 'GET', '/incidents')).incidents.find((i) => i.issueId === silencedId && i.end === null)?.silenced).toBe(true);
  });

  it('answers the backups, moved to now like everything else', async () => {
    const backups = await agent.call<BackupsView>('warning', 'GET', '/backups', undefined, 'en');
    expect(backups.rows.length).toBeGreaterThan(0);
    const newest = Math.max(...backups.rows.map((r) => Date.parse(r.lastSuccess ?? '0')));
    expect(newest).toBeLessThan(Date.now());
    expect(newest).toBeGreaterThan(Date.now() - 2 * 86_400_000);
  });

  it('keeps a maintenance window in the status until it ends, and refuses other lengths', async () => {
    expect((await agent.call<Snapshot>('healthy', 'GET', '/status')).maintenanceUntil).toBeUndefined();
    const { maintenanceUntil } = await agent.call<{ maintenanceUntil: string }>('healthy', 'POST', '/maintenance?hours=2');
    expect(Math.abs(Date.parse(maintenanceUntil) - Date.now() - 2 * 3_600_000)).toBeLessThan(5000);
    const during = await agent.call<Snapshot>('healthy', 'GET', '/status');
    expect(during.maintenanceUntil).toBe(maintenanceUntil);
    // Checks and the light go on during maintenance.
    expect(during.light).toBe('green');
    await expect(agent.call('healthy', 'POST', '/maintenance?hours=3')).rejects.toMatchObject({ status: 400, code: 'MAINTENANCE_HOURS' });
    await agent.call('healthy', 'POST', '/maintenance/end');
    expect((await agent.call<Snapshot>('healthy', 'GET', '/status')).maintenanceUntil).toBeUndefined();
  });

  it('falls back to the recording without a language', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (url.endsWith('.de.json') ? new Response('', { status: 404 }) : serve(url.replace(/\.json$/, '.en.json')))));
    const snapshot = await agent.call<Snapshot>('broken', 'GET', '/status', undefined, 'de');
    expect(snapshot.light).toBe('red');
    expect(vi.mocked(fetch).mock.calls.map(([url]) => String(url))).toEqual(['demo/broken.de.json', 'demo/broken.json']);
  });

  it('serves the nearest history and refuses what only a real agent can do', async () => {
    expect(((await agent.call('healthy', 'GET', '/history?hours=12')) as { hours: number }).hours).toBe(24);
    await expect(agent.call('healthy', 'POST', '/pair/code')).rejects.toMatchObject({ code: 'DEMO_ONLY' });
  });
});

describe('judge and applySettings', () => {
  it('follow the agent rules', () => {
    expect(judge([])).toEqual({ light: 'green', score: 100 });
    expect(judge([{ severity: 'warning' }, { severity: 'info' }])).toEqual({ light: 'yellow', score: 95 });
    expect(judge([{ severity: 'critical' }])).toEqual({ light: 'red', score: 82 });
  });

  it('never changes a locked switch', () => {
    const view = { modules: [{ id: 'a', name: 'A', icon: 'x', category: 'core', description: '', deep: true, detected: true, state: 'locked' as const }], actions: [], notifications: 'on' as const };
    expect(applySettings(view, { modules: { a: true }, notifications: false })).toEqual({ ...view, notifications: 'off' });
  });
});
