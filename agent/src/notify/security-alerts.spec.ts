import { generateKeyPair } from '@kubernanny/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DevicesService } from '../auth/devices.service';
import { Config, loadConfig } from '../config';
import { DemoKubeClient } from '../demo/demo-cluster';
import { KubeClient } from '../kube/kube-client';
import { SettingsService } from '../settings/settings.service';
import { SilenceService } from '../silence/silence.service';
import { formatSecurityAlert, Notifier, SecurityEvent } from './notifier';

const who = { kind: 'device' as const, id: 'd1', name: 'Nicos iPhone' };

/** Records alerts, and how many cluster writes had happened when each arrived. */
function recorder(kube: DemoKubeClient) {
  const alerts: { by: string; events: SecurityEvent[]; writesBefore: number }[] = [];
  const notifier = {
    securityAlert: async (by: string, events: SecurityEvent[]) =>
      void (events.length && alerts.push({ by, events, writesBefore: kube.writes.length })),
  } as unknown as Notifier;
  return { alerts, notifier };
}

describe('security notifications (review: a stolen device could blind the owner)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('names the device and the change, and nothing of either in minimal mode', () => {
    const full = formatSecurityAlert(
      'home',
      'Nicos iPhone',
      [{ kind: 'notificationsOff' }, { kind: 'moduleOff', id: 'argocd' }],
      'full',
      'en',
    );
    expect(full.title).toBe('home: security-relevant change');
    expect(full.body).toContain('Nicos iPhone switched notifications off.');
    expect(full.body).toContain('Nicos iPhone switched the module argocd off.');
    expect(full.body).toContain('Remove that device from another paired device');
    const minimal = formatSecurityAlert(
      'home',
      'Nicos iPhone',
      [{ kind: 'deviceRevoked', device: 'Laptop' }],
      'minimal',
      'de',
    );
    expect(minimal.body).not.toContain('Nicos');
    expect(minimal.body).not.toContain('Laptop');
  });

  it('is announced before notifications go off, and for every module or action switched off', async () => {
    const kube = new DemoKubeClient();
    const { alerts, notifier } = recorder(kube);
    const settings = new SettingsService(loadConfig(), kube, notifier);
    await settings.onModuleInit();
    await settings.update({ notifications: false }, who);
    expect(alerts).toEqual([{ by: 'Nicos iPhone', events: [{ kind: 'notificationsOff' }], writesBefore: 0 }]);
    expect(kube.writes.length).toBeGreaterThan(0);
    await settings.update({ modules: { argocd: false }, actions: { restart: false } }, who);
    expect(alerts.at(-1)!.events).toEqual([
      { kind: 'moduleOff', id: 'argocd' },
      { kind: 'actionOff', id: 'restart' },
    ]);
    // Switching on, or off again what is off, announces nothing.
    const count = alerts.length;
    await settings.update({ modules: { argocd: true }, notifications: true }, who);
    await settings.update({ actions: { restart: false } }, who);
    expect(alerts.length).toBe(count);
  });

  it('announces switching on a module that sends data out of the cluster, in both languages; other modules switch on silently', async () => {
    const kube = new DemoKubeClient();
    const { alerts, notifier } = recorder(kube);
    const settings = new SettingsService(loadConfig(), new SlowKube(), notifier);
    await settings.onModuleInit();
    await settings.update({ modules: { vulnerabilities: true } }, who);
    expect(alerts.at(-1)).toMatchObject({ events: [{ kind: 'moduleOn', id: 'vulnerabilities' }] });
    // Off again and on again: announced again; already on: nothing.
    await settings.update({ modules: { vulnerabilities: false } }, who);
    await settings.update({ modules: { vulnerabilities: true, 'image-updates': true } }, who);
    expect(alerts.at(-1)!.events).toEqual([
      { kind: 'moduleOn', id: 'vulnerabilities' },
      { kind: 'moduleOn', id: 'image-updates' },
    ]);
    const count = alerts.length;
    await settings.update({ modules: { vulnerabilities: true } }, who);
    await settings.update({ modules: { argocd: false } }, who);
    await settings.update({ modules: { argocd: true } }, who);
    expect(alerts.slice(count).flatMap((a) => a.events)).toEqual([{ kind: 'moduleOff', id: 'argocd' }]);

    const en = formatSecurityAlert('home', 'Nicos iPhone', [{ kind: 'moduleOn', id: 'vulnerabilities' }], 'full', 'en');
    expect(en.body).toContain('Nicos iPhone switched the module vulnerabilities on. It sends data out of the cluster.');
    const de = formatSecurityAlert('home', 'Nicos iPhone', [{ kind: 'moduleOn', id: 'vulnerabilities' }], 'full', 'de');
    expect(de.body).toContain(
      'Nicos iPhone hat das Modul vulnerabilities eingeschaltet. Es sendet Daten aus dem Cluster.',
    );
    expect(`${en.body}${de.body}`).not.toMatch(/[\u2013\u2014]/);
  });

  it('announces a maintenance window before it holds everything back', async () => {
    const kube = new DemoKubeClient();
    const { alerts, notifier } = recorder(kube);
    const silences = new SilenceService(loadConfig(), kube, notifier);
    await silences.onModuleInit();
    await silences.startMaintenance(24, who);
    expect(alerts).toEqual([{ by: 'Nicos iPhone', events: [{ kind: 'maintenance', hours: 24 }], writesBefore: 0 }]);
  });

  it('goes out even with notifications off in the app, and only Helm `notifications` disabled silences it', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      sent.push(init.body);
      return new Response(null, { status: 204 });
    });
    const config: Config = {
      ...loadConfig(),
      clusterName: 'home',
      language: 'en',
      webhookUrl: 'https://hooks.example.org/k',
      webhookFormat: 'json',
    };
    await new Notifier(config).securityAlert('Nicos iPhone', [{ kind: 'maintenance', hours: 1 }]);
    expect(JSON.parse(sent.pop()!)).toMatchObject({
      title: 'home: security-relevant change',
      body: expect.stringContaining('Nicos iPhone started a maintenance window of 1 hour.'),
    });
    await new Notifier({ ...config, disabledModules: ['notifications'] }).securityAlert('Nicos iPhone', [
      { kind: 'notificationsOff' },
    ]);
    expect(sent).toEqual([]);
  });

  it('announces a rollback with the app and both short revisions, in both languages', () => {
    const event: SecurityEvent = { kind: 'rolledBack', app: 'argocd/shop', from: 'c4d5e6f', to: '3f9c2a1' };
    expect(formatSecurityAlert('home', 'Nicos iPhone', [event], 'full', 'en').body).toContain(
      'Nicos iPhone rolled the Argo CD app argocd/shop back from c4d5e6f to 3f9c2a1.',
    );
    expect(formatSecurityAlert('home', 'Nicos iPhone', [event], 'full', 'de').body).toContain(
      'Nicos iPhone hat die Argo-CD-App argocd/shop von c4d5e6f auf 3f9c2a1 zurückgerollt.',
    );
    expect(formatSecurityAlert('home', 'Nicos iPhone', [event], 'minimal', 'en').body).not.toContain('shop');
  });

  it('sends a rollback alert while notifications are paused in the app and during maintenance', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      sent.push(init.body);
      return new Response(null, { status: 204 });
    });
    const config: Config = {
      ...loadConfig(),
      clusterName: 'home',
      language: 'en',
      webhookUrl: 'https://hooks.example.org/k',
      webhookFormat: 'json',
    };
    const kube = new DemoKubeClient();
    const notifier = new Notifier(config);
    const settings = new SettingsService(config, kube, notifier);
    await settings.onModuleInit();
    await settings.update({ notifications: false }, who);
    const silences = new SilenceService(config, kube as KubeClient, notifier);
    await silences.onModuleInit();
    await silences.startMaintenance(4, who);
    sent.length = 0;
    await notifier.securityAlert('Nicos iPhone', [
      { kind: 'rolledBack', app: 'argocd/shop', from: 'c4d5e6f', to: '3f9c2a1' },
    ]);
    expect(sent.map((b) => JSON.parse(b).body)).toEqual([expect.stringContaining('back from c4d5e6f to 3f9c2a1')]);
  });

  it('never blocks the change when a channel is down', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const config: Config = { ...loadConfig(), webhookUrl: 'https://hooks.example.org/k' };
    await expect(new Notifier(config).securityAlert('x', [{ kind: 'notificationsOff' }])).resolves.toBeUndefined();
  });
});

/** A Secret / ConfigMap store whose writes take a while, so concurrent changes overlap. */
class SlowKube extends KubeClient {
  data: Record<string, unknown> = {};
  override async get<T>(): Promise<T> {
    return { data: {} } as T;
  }
  override async mergePatch(_path: string, body: unknown): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = body as { data?: Record<string, string>; stringData?: Record<string, string> };
    Object.assign(this.data, b.data ?? b.stringData);
  }
}

describe('concurrent changes do not lose each other (review)', () => {
  it('settings', async () => {
    const kube = new SlowKube();
    const settings = new SettingsService(loadConfig(), kube);
    await settings.onModuleInit();
    await Promise.all([
      settings.update({ modules: { argocd: false } }, who),
      settings.update({ actions: { restart: false } }, who),
      settings.update({ notifications: false }, who),
    ]);
    expect(settings.moduleState('argocd')).toBe('off');
    expect(settings.actionState('restart')).toBe('off');
    expect(settings.notificationsOn()).toBe(false);
    expect(JSON.parse(kube.data.settings as string)).toMatchObject({
      disabledModules: ['argocd'],
      disabledActions: ['restart'],
      notificationsPaused: true,
    });
  });

  it('silences', async () => {
    const kube = new SlowKube();
    const silences = new SilenceService(loadConfig(), kube);
    await silences.onModuleInit();
    await Promise.all([
      silences.silence('a/1', 8, who),
      silences.silence('b/2', 8, who),
      silences.startMaintenance(2, who),
    ]);
    expect(silences.silencedUntil('a/1')).not.toBeNull();
    expect(silences.silencedUntil('b/2')).not.toBeNull();
    expect(silences.maintenanceUntil()).not.toBeNull();
  });

  it('devices', async () => {
    const kube = new SlowKube();
    const devices = new DevicesService(loadConfig(), kube);
    await devices.onModuleInit();
    await Promise.all([
      devices.add('A', generateKeyPair().publicKey),
      devices.add('B', generateKeyPair().publicKey),
      devices.add('C', generateKeyPair().publicKey),
    ]);
    expect(
      devices
        .list()
        .map((d) => d.name)
        .sort(),
    ).toEqual(['A', 'B', 'C']);
    await Promise.all(devices.list().map((d) => devices.revoke(d.id)));
    expect(devices.list()).toEqual([]);
  });
});
