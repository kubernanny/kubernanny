import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { raw } from '../i18n/text';
import { Notifier } from '../notify/notifier';
import type { IssueView, Snapshot } from '../status/status.service';
import type { AppPushMessage, AppPushService } from './app-push.service';
import { pushStatus } from './push-status';

const NOW = new Date('2026-11-24T04:10:00Z');
const issue = (id: string, severity: IssueView['severity'], extra: Partial<IssueView> = {}): IssueView => ({
  id,
  check: 'pods',
  severity,
  title: raw(`T ${id}`),
  cause: raw(`C ${id}`),
  actions: [],
  since: '2026-11-24T03:00:00Z',
  module: 'pods',
  ...extra,
});
const snapshot = (issues: IssueView[], extra: Partial<Snapshot> = {}) =>
  ({ cluster: 'homelab', light: 'red', checkedAt: '2026-11-24T04:09:30.000Z', issues, ...extra }) as Snapshot;

describe('pushStatus', () => {
  it('counts like the app (no silenced issues, no hints) and puts outages first', () => {
    const s = snapshot([issue('w1', 'warning'), issue('c1', 'critical'), issue('hint', 'info'), issue('quiet', 'critical', { silencedUntil: '2026-11-25T00:00:00Z' }), issue('w2', 'warning'), issue('c2', 'critical')]);
    expect(pushStatus(s, 'full', 'en')).toEqual({
      l: 'red',
      c: 2,
      n: 2,
      a: Date.parse('2026-11-24T04:09:30.000Z'),
      i: [
        { s: 'c', t: 'T c1' },
        { s: 'c', t: 'T c2' },
        { s: 'w', t: 'T w1' },
      ],
    });
  });

  it('sends only the light and the counts with detail minimal, and no list when all is well', () => {
    expect(pushStatus(snapshot([issue('c1', 'critical')]), 'minimal', 'en')).toEqual({ l: 'red', c: 1, n: 0, a: Date.parse('2026-11-24T04:09:30.000Z') });
    expect(pushStatus(snapshot([], { light: 'green' }), 'full', 'en')).toEqual({ l: 'green', c: 0, n: 0, a: Date.parse('2026-11-24T04:09:30.000Z') });
    expect(pushStatus(snapshot([], { light: 'unknown', checkedAt: null }), 'full', 'en').a).toBeNull();
  });

  it('shortens a long title', () => {
    const t = pushStatus(snapshot([issue('x', 'critical', { title: raw('ä'.repeat(300)) })]), 'full', 'en').i![0]!.t;
    expect(Array.from(t)).toHaveLength(120);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('Notifier and the app channel', () => {
  it('hands every native push the state of the newest run', async () => {
    const sent: AppPushMessage[] = [];
    const appPush = { hasTargets: () => true, deliver: vi.fn(async (m: AppPushMessage) => (sent.push(m), true)) } as unknown as AppPushService;
    const notifier = new Notifier({ ...loadConfig(), notifyAfterSeconds: 0, ntfyUrl: undefined, webhookUrl: undefined }, undefined, appPush);
    await notifier.update(snapshot([issue('c1', 'critical')]), NOW);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.status).toMatchObject({ l: 'red', c: 1, n: 0, i: [{ s: 'c', t: 'T c1' }] });

    // Resolved: the widget goes green with the same push.
    await notifier.update(snapshot([], { light: 'green' }), NOW);
    expect(sent[1]!.status).toEqual({ l: 'green', c: 0, n: 0, a: Date.parse('2026-11-24T04:09:30.000Z') });
  });
});
