import { afterEach, describe, expect, it, vi } from 'vitest';

import { IdentityService } from './auth/identity.service';
import { loadConfig } from './config';
import { DemoKubeClient } from './demo/demo-cluster';
import { localize } from './i18n/text';
import { IncidentsService } from './incidents/incidents.service';
import { Notifier } from './notify/notifier';
import { SettingsService } from './settings/settings.service';
import { checkSwitchIds } from './settings/switch-ids';
import { SilenceService } from './silence/silence.service';
import { StatusService } from './status/status.service';
import { startDemoAgent } from './testing/demo-agent';
import { E2eClient } from './testing/e2e-client';

/**
 * Regression tests for the findings of the independent security review that
 * need the whole run loop or a whole agent (the review's scripts in
 * scratchpad/review reproduced them against dist/).
 */

function statusFor(kube: DemoKubeClient, overrides: Partial<ReturnType<typeof loadConfig>>) {
  const cfg = { ...loadConfig(), demo: kube.scenario, ...overrides };
  const notifier = new Notifier(cfg);
  const settings = new SettingsService(cfg, kube);
  return {
    status: new StatusService(kube, cfg, notifier, settings, new SilenceService(cfg, kube), new IncidentsService()),
    notifier,
    cfg,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('H1: a fake in-cluster service cannot crash the agent or blank /status', () => {
  it('keeps `{"$t":"valueOf"}` from Grafana as data, renders /status, and survives a run with a notification channel', async () => {
    const kube = new DemoKubeClient(undefined, 'healthy');
    const get = kube.get.bind(kube);
    vi.spyOn(kube, 'get').mockImplementation(((path: string) =>
      /grafana.*\/api\/health/.test(path)
        ? Promise.resolve({ database: { $t: 'valueOf' }, version: { $t: '__proto__' } })
        : get(path)) as typeof kube.get);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('ok')),
    );
    const rejections: unknown[] = [];
    const onRejection = (e: unknown) => rejections.push(e);
    process.on('unhandledRejection', onRejection);
    try {
      const { status } = statusFor(kube, { ntfyUrl: 'https://ntfy.example/t', notifyAfterSeconds: 0.001 });
      await status.refresh();
      await new Promise((r) => setTimeout(r, 5));
      await status.refresh();
      const body = JSON.stringify(localize(status.snapshot(), 'en'));
      expect(body).not.toContain('"$t"');
      const grafana = status.snapshot().issues.find((i) => i.id === 'grafana/database');
      expect(grafana).toBeDefined();
      expect(grafana!.check).toBe('grafana');
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('caps an Alertmanager answer of thousands of alerts to a bounded number of issues', async () => {
    const kube = new DemoKubeClient(undefined, 'healthy');
    const get = kube.get.bind(kube);
    const flood = Array.from({ length: 20_000 }, (_, i) => ({
      labels: { alertname: `A${i}\nforged log line`, severity: 'critical' },
      annotations: { summary: 'x'.repeat(5000) },
    }));
    vi.spyOn(kube, 'get').mockImplementation(((path: string) =>
      /\/api\/v2\/alerts/.test(path) ? Promise.resolve(flood) : get(path)) as typeof kube.get);
    const { status } = statusFor(kube, {});
    await status.refresh();
    const ids = status
      .snapshot()
      .issues.filter((i) => i.module === 'alertmanager')
      .map((i) => i.id);
    expect(ids.length).toBeLessThanOrEqual(50);
    expect(ids).toContain('alertmanager/more');
    expect(ids.every((id) => !id.includes('\n'))).toBe(true);
    expect(JSON.stringify(localize(status.snapshot(), 'en')).length).toBeLessThan(1024 * 1024);
  });

  it('a run whose notification throws is logged, never rejected', async () => {
    const kube = new DemoKubeClient(undefined, 'broken');
    const { status, notifier } = statusFor(kube, { ntfyUrl: 'https://ntfy.example/t' });
    vi.spyOn(notifier, 'update').mockRejectedValue(new Error('boom'));
    await expect(status.refresh()).resolves.toBeUndefined();
    expect(status.snapshot().checkedAt).not.toBeNull();
  });
});

describe('H4: checks.disabled: [prometheus] means no Prometheus request at all', () => {
  it('sends zero requests to Prometheus from any module, and the views see no client', async () => {
    const kube = new DemoKubeClient(undefined, 'broken');
    const seen: string[] = [];
    for (const m of ['get', 'text', 'list'] as const) {
      const original = (kube[m] as (p: string, ...r: unknown[]) => Promise<unknown>).bind(kube);
      vi.spyOn(kube, m).mockImplementation(((p: string, ...r: unknown[]) => {
        if (/\/api\/v1\/query|prometheus/.test(p)) {
          seen.push(p);
        }
        return original(p, ...r);
      }) as never);
    }
    const { status } = statusFor(kube, { disabledModules: ['prometheus'] });
    await status.refresh();
    expect(seen).toEqual([]);
    expect(status.state().prom).toBeNull();
    expect(status.snapshot().modules.map((m) => m.id)).not.toContain('prometheus');
  });

  it('switched off only in the app, the other modules keep using Prometheus (documented soft switch)', async () => {
    const kube = new DemoKubeClient(undefined, 'broken');
    const { status } = statusFor(kube, { disabledModules: [] });
    await status.refresh();
    expect(status.state().prom).not.toBeNull();
  });
});

describe('H3: checks.disabled: [notifications] is hard', () => {
  it('has no channel, sends no security alert and refuses the test route with 403', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) => new Response('ok'));
    vi.stubGlobal('fetch', fetchMock);
    const agent = await startDemoAgent({
      DISABLED_MODULES: 'notifications',
      NTFY_URL: 'https://ntfy.example/topic',
      WEBHOOK_URL: 'https://hooks.slack.com/services/x',
    });
    try {
      const notifier = agent.app.get(Notifier);
      expect(notifier.channels).toEqual([]);
      await notifier.securityAlert('dev', [{ kind: 'devicePaired' }]);
      await expect(notifier.test('c')).resolves.toEqual([]);
      const client = new E2eClient(agent.app.getHttpServer(), agent.app.get(IdentityService).publicKey);
      const answer = await client.post('/notify/test', {}, 403);
      expect(answer.body).toMatchObject({ code: 'NOTIFICATIONS_LOCKED' });
      expect(fetchMock.mock.calls.filter(([url]) => /ntfy|slack/.test(String(url)))).toEqual([]);
    } finally {
      await agent.close();
    }
  });
});

describe('M2: hard switches refuse typos instead of failing open', () => {
  it('refuses unknown module ids and action types', () => {
    const base = { ...loadConfig(), customComponents: [] };
    expect(() => checkSwitchIds({ ...base, disabledModules: ['prometeus'] })).toThrow(/unknown modules: prometeus/);
    expect(() => checkSwitchIds({ ...base, enabledModules: ['vulnerabilitys'] })).toThrow(/unknown modules/);
    expect(() => checkSwitchIds({ ...base, disabledActions: ['restarts'] })).toThrow(/unknown action types: restarts/);
    expect(
      checkSwitchIds({
        ...base,
        disabledModules: ['prometheus', 'notifications', 'vulnerabilities', 'etcd'],
        disabledActions: ['restart', 'logs'],
      }),
    ).toBeTruthy();
    const custom = {
      ...base,
      customComponents: [{ id: 'custom:shop', name: 'Shop', images: ['x/y'], category: 'apps', icon: 'cube' }],
    };
    expect(checkSwitchIds({ ...custom, disabledModules: ['custom:shop'] })).toBeTruthy();
  });
});
