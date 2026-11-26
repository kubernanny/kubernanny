import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../config';
import { raw, t } from '../i18n/text';
import type { IssueView, Snapshot } from '../status/status.service';
import { formatPush, Notifier, planNotifications, Pushed } from './notifier';

const NOW = new Date('2026-11-24T04:10:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const issue = (id: string, severity: IssueView['severity'], since: string): IssueView => ({
  id,
  check: 'nodes',
  severity,
  title: raw(`T ${id}`),
  cause: raw(`C ${id}`),
  actions: [],
  since,
  module: 'nodes',
});

describe('planNotifications', () => {
  const AFTER = 5 * 60_000;

  it('waits until an issue has lasted long enough (a kured reboot heals before)', () => {
    const plan = planNotifications(
      new Map(),
      [issue('a', 'critical', minutesAgo(2)), issue('b', 'warning', minutesAgo(6))],
      NOW,
      AFTER,
    );
    expect(plan.opened.map((i) => i.id)).toEqual(['b']);
  });

  it('pushes an issue once, again only when it escalates, and its end', () => {
    const pushed = new Map<string, Pushed>([
      ['a', { title: raw('T a'), severity: 'warning' }],
      ['gone', { title: raw('T gone'), severity: 'critical' }],
    ]);
    const plan = planNotifications(pushed, [issue('a', 'critical', minutesAgo(20))], NOW, AFTER);
    expect(plan.opened).toEqual([]);
    expect(plan.escalated.map((i) => i.id)).toEqual(['a']);
    expect(plan.resolved).toEqual([{ id: 'gone', title: raw('T gone') }]);
  });

  it('never pushes hints', () => {
    const plan = planNotifications(
      new Map(),
      [issue('h', 'info' as IssueView['severity'], minutesAgo(60))],
      NOW,
      AFTER,
    );
    expect(plan.opened).toEqual([]);
  });

  it('never pushes the end of an issue whose start was not pushed', () => {
    const plan = planNotifications(new Map(), [], NOW, AFTER);
    expect(plan).toEqual({ opened: [], resolved: [], escalated: [] });
  });
});

describe('formatPush', () => {
  it('leaves out every name in minimal mode', () => {
    const push = formatPush(
      'home',
      {
        opened: [issue('pods/secret-ns/Deployment/billing', 'critical', '')],
        resolved: [{ id: 'x', title: raw('T x') }],
        escalated: [],
      },
      'minimal',
      'de',
    )!;
    expect(push).toMatchObject({
      title: 'home: Neue Probleme',
      body: '1 kritisch, 1 behoben. Details in Kubernanny.',
      priority: 5,
    });
    expect(JSON.stringify(push)).not.toMatch(/billing|secret-ns|T x/);
  });

  it('returns nothing for an empty plan', () => {
    expect(formatPush('home', { opened: [], resolved: [], escalated: [] }, 'full', 'de')).toBeNull();
  });

  it('uses the issue as title for one problem, urgent when critical', () => {
    const push = formatPush(
      'home',
      { opened: [issue('a', 'critical', minutesAgo(9))], resolved: [], escalated: [] },
      'full',
      'de',
    );
    expect(push).toEqual({ title: 'home: T a', body: '🔴 T a: C a', priority: 5, tags: 'rotating_light' });
  });

  it('summarises several problems and quiet resolutions', () => {
    expect(
      formatPush(
        'home',
        {
          opened: [issue('a', 'warning', ''), issue('b', 'warning', '')],
          resolved: [{ id: 'c', title: raw('T c') }],
          escalated: [],
        },
        'full',
        'de',
      ),
    ).toMatchObject({ title: 'home: 2 Probleme', priority: 3 });
    expect(
      formatPush('home', { opened: [], resolved: [{ id: 'c', title: raw('T c') }], escalated: [] }, 'full', 'de'),
    ).toMatchObject({
      title: 'home: Problem behoben',
      priority: 2,
      body: '✅ behoben: T c',
    });
  });
});

describe('notification language', () => {
  const plan = () => ({
    opened: [issue('a', 'warning', ''), issue('b', 'critical', '')],
    resolved: [{ id: 'c', title: raw('T c') }],
    escalated: [],
  });

  it('writes pushes in the language it is given (the agent passes LANGUAGE)', () => {
    expect(formatPush('home', plan(), 'full', 'en')).toMatchObject({
      title: 'home: 2 problems',
      body: '🟡 T a: C a\n🔴 T b: C b\n✅ resolved: T c',
    });
    expect(formatPush('home', plan(), 'minimal', 'en')).toMatchObject({
      title: 'home: new problems',
      body: '1 critical, 1 warning, 1 resolved. Details in Kubernanny.',
    });
    expect(formatPush('home', plan(), 'minimal', 'de')).toMatchObject({
      body: '1 kritisch, 1 Warnung, 1 behoben. Details in Kubernanny.',
    });
  });
});

describe('Notifier', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends pushes and the test message in the agent language (LANGUAGE), whatever the app speaks', async () => {
    const sent: { title: string; body: string; opened: { title: string; cause: string }[] }[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      sent.push(JSON.parse(init.body));
      return new Response(null, { status: 204 });
    });
    const config = {
      ...loadConfig(),
      webhookUrl: 'https://hooks.example.org/kubernanny',
      webhookFormat: 'json' as const,
      notifyAfterSeconds: 60,
    };
    const snapshot = (issues: IssueView[]) => ({ cluster: 'home', issues }) as unknown as Snapshot;
    const crash = {
      ...issue('pods/a/Deployment/web', 'critical', minutesAgo(10)),
      title: t('pods.title', { workload: 'a/web', reason: 'CrashLoopBackOff', pods: 2 }),
      cause: t('jobs.failed'),
    };

    await new Notifier({ ...config, language: 'en' }).update(snapshot([crash]), NOW);
    expect(sent.pop()).toMatchObject({
      title: 'home: a/web: CrashLoopBackOff (2 pods)',
      opened: [{ title: 'a/web: CrashLoopBackOff (2 pods)', cause: 'The job failed.' }],
    });

    await new Notifier({ ...config, language: 'de' }).update(snapshot([crash]), NOW);
    expect(sent.pop()).toMatchObject({
      title: 'home: a/web: CrashLoopBackOff (2 Pods)',
      opened: [{ cause: 'Job fehlgeschlagen.' }],
    });

    await new Notifier({ ...config, language: 'en' }).test('home');
    expect(sent.pop()).toMatchObject({ title: 'home: test message', body: 'Kubernanny can reach you.' });
  });
});
