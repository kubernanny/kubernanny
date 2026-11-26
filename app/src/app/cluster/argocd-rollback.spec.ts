import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModuleView, SettingsView, Snapshot } from '../core/agent.model';
import { DemoAgent } from '../core/demo/demo-agent';
import { translatorFor } from '../i18n/translator';
import { markRolledBack, rollbackRows } from './argocd-rollback';

const SHA = (c: string) => c.repeat(40);
const argocd = (extra: Partial<ModuleView> = {}): ModuleView =>
  ({
    id: 'argocd',
    name: 'Argo CD',
    issueIds: [],
    stats: [],
    links: [],
    workloads: { ready: 0, total: 0, items: [] },
    rollbacks: [
      {
        namespace: 'argocd',
        app: 'shop',
        current: 'ccccccc',
        entries: [
          {
            id: 3,
            revision: SHA('c'),
            short: 'ccccccc',
            deployedAt: '2026-11-20T10:00:00Z',
            current: true,
          },
          {
            id: 1,
            revision: SHA('a'),
            short: 'aaaaaaa',
            deployedAt: '2026-11-01T10:00:00Z',
            current: false,
          },
          {
            id: 2,
            revision: SHA('b'),
            short: 'bbbbbbb',
            deployedAt: '2026-11-10T10:00:00Z',
            current: false,
          },
        ],
      },
    ],
    ...extra,
  }) as ModuleView;

describe('rollback rows on the Argo CD sheet', () => {
  it('lists earlier deployments newest first, without the current one, with the confirmation worked out', () => {
    const [row] = rollbackRows(argocd(), translatorFor('en'));
    expect(row).toMatchObject({
      key: 'argocd/shop',
      app: 'shop',
      now: 'Deployed now: ccccccc',
      sheetTitle: 'Roll back shop',
      confirmTitle: 'Roll back shop?',
    });
    expect(row!.choices.map((c) => c.id)).toEqual([2, 1]);
    expect(row!.choices[0]!.label).toContain('bbbbbbb');
    expect(row!.choices[0]!.label).toContain('2026');
    expect(row!.choices[0]!.confirm).toBe(
      'shop goes from ccccccc back to bbbbbbb. The cluster then differs from Git until you revert the change there.',
    );
    const de = rollbackRows(argocd(), translatorFor('de'))[0]!;
    expect(de.choices[1]!.confirm).toBe(
      'shop geht von ccccccc zurück auf aaaaaaa. Der Cluster weicht danach von Git ab, bis du die Änderung dort mit einem Revert zurücknimmst.',
    );
    for (const text of [row!.choices[0]!.confirm, de.choices[0]!.confirm, de.sheetTitle]) {
      expect(text).not.toMatch(/[–—]/);
    }
  });

  it('shows nothing without rollbacks (the agent sends none unless the chart opted in), on other modules, or with odd values', () => {
    expect(rollbackRows(argocd({ rollbacks: undefined }), translatorFor('en'))).toEqual([]);
    expect(rollbackRows(argocd({ id: 'longhorn' }), translatorFor('en'))).toEqual([]);
    const odd = argocd({
      rollbacks: [
        {
          namespace: 'argocd',
          app: 'x',
          entries: [{ id: 1, revision: 'a', short: '<b>x</b>', current: false }],
        },
      ],
    });
    expect(rollbackRows(odd, translatorFor('en'))).toEqual([]);
  });

  it('marks the chosen deployment as current after a rollback', () => {
    const after = markRolledBack(argocd(), { namespace: 'argocd', app: 'shop' }, 1);
    expect(after.rollbacks![0]!.current).toBe('aaaaaaa');
    expect(rollbackRows(after, translatorFor('en'))[0]!.choices.map((c) => c.id)).toEqual([3, 2]);
  });
});

const PUBLIC = join(__dirname, '../../../public');

describe('rollback in the demo', () => {
  let agent: DemoAgent;

  beforeEach(() => {
    agent = new DemoAgent();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response(readFileSync(join(PUBLIC, url), 'utf8'))),
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it('offers one manual-sync app with three deployments, simulates the rollback and says so', async () => {
    const status = await agent.call<Snapshot>('broken', 'GET', '/status', undefined, 'en');
    const module = status.modules.find((m) => m.id === 'argocd')!;
    const [row] = rollbackRows(module, translatorFor('en'));
    expect(module.rollbacks![0]!.entries).toHaveLength(3);
    expect(row!.choices).toHaveLength(2);
    const { done } = await agent.call<{ done: string }>(
      'broken',
      'POST',
      '/argocd/rollback',
      { namespace: row!.namespace, app: row!.app, id: row!.choices[1]!.id },
      'en',
    );
    expect(done).toContain('Simulated');
    const after = (
      await agent.call<Snapshot>('broken', 'GET', '/status', undefined, 'en')
    ).modules.find((m) => m.id === 'argocd')!;
    expect(after.rollbacks![0]!.current).toBe(row!.choices[1]!.short);
  });

  it('refuses and hides it once switched off in the demo settings', async () => {
    await agent.call<SettingsView>(
      'broken',
      'POST',
      '/settings',
      { actions: { 'argocd-rollback': false } },
      'en',
    );
    const module = (
      await agent.call<Snapshot>('broken', 'GET', '/status', undefined, 'en')
    ).modules.find((m) => m.id === 'argocd')!;
    expect(module.rollbacks).toBeUndefined();
    await expect(
      agent.call(
        'broken',
        'POST',
        '/argocd/rollback',
        { namespace: 'argocd', app: 'shop-web-app-chart', id: 7 },
        'en',
      ),
    ).rejects.toMatchObject({ code: 'ACTION_DISABLED' });
  });
});
