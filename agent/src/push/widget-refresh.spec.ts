import {
  decodePushContent,
  fromBase64Url,
  generateKeyPair,
  isStatusOnly,
  openPush,
  PushRequest,
  PushStatus,
  toBase64Url,
} from '@kubernanny/protocol';
import { describe, expect, it } from 'vitest';

import { DevicesService, Principal } from '../auth/devices.service';
import { IdentityService } from '../auth/identity.service';
import { Config, loadConfig, parseWidgetRefreshMinutes } from '../config';
import { DemoKubeClient } from '../demo/demo-cluster';
import { Notifier } from '../notify/notifier';
import type { Snapshot } from '../status/status.service';
import { AppPushService } from './app-push.service';
import { PushTransport } from './push-transport';

const TOKEN = 'cXVpdGUtYS10b2tlbg:APA91bHPRgkF-test_token';
const agentKeys = generateKeyPair();
const identity = { keyPair: agentKeys } as IdentityService;
const pushKey = generateKeyPair();
const registration = { token: TOKEN, platform: 'android', key: toBase64Url(pushKey.publicKey) };
const status: PushStatus = { l: 'yellow', c: 0, n: 1, a: 1_795_000_000_000 };
const MIN = 60_000;

type Outcome = Awaited<ReturnType<PushTransport['send']>>;

/** An agent with one paired phone, a clock of its own and a relay that does (or does not) deliver status pushes. */
async function setup(options: { config?: Partial<Config>; statusPush?: boolean; outcome?: Outcome } = {}) {
  const config: Config = { ...loadConfig(), relayUrl: 'wss://relay.example.org', ...options.config };
  const kube = new DemoKubeClient();
  const devices = new DevicesService(config, kube);
  await devices.onModuleInit();
  const view = await devices.add('Phone', generateKeyPair().publicKey);
  const device: Principal = { kind: 'device', id: view.id, name: view.name };
  const sent: PushRequest[] = [];
  const clock = { now: 1_800_000_000_000 };
  const transport = new PushTransport();
  const outcome = { value: options.outcome ?? ('sent' as Outcome) };
  transport.attach({
    available: () => true,
    statusAvailable: () => options.statusPush ?? true,
    send: async (push) => (sent.push(push), outcome.value),
  });
  const push = new AppPushService(config, devices, identity, transport, () => clock.now);
  return { config, kube, devices, device, push, sent, clock, outcome };
}

const opened = (request: PushRequest) =>
  decodePushContent(openPush(pushKey, agentKeys.publicKey, fromBase64Url(request.message)));

describe('WIDGET_REFRESH_MINUTES', () => {
  it('defaults to 60, 0 is off, and below 30 stops the start', () => {
    expect(parseWidgetRefreshMinutes(undefined)).toBe(60);
    expect(parseWidgetRefreshMinutes('')).toBe(60);
    expect(parseWidgetRefreshMinutes('0')).toBe(0);
    expect(parseWidgetRefreshMinutes('30')).toBe(30);
    expect(parseWidgetRefreshMinutes('120')).toBe(120);
    expect(() => parseWidgetRefreshMinutes('29')).toThrow(/WIDGET_REFRESH_MINUTES/);
    expect(() => parseWidgetRefreshMinutes('hourly')).toThrow(/WIDGET_REFRESH_MINUTES/);
    expect(() => parseWidgetRefreshMinutes('-5')).toThrow(/WIDGET_REFRESH_MINUTES/);
  });
});

describe('the widget flag at registration', () => {
  it('is stored, refused when it is not a boolean, and an unchanged registration is not written again', async () => {
    const { kube, devices, device, push } = await setup();
    await expect(push.register(device, { ...registration, widget: 'yes' })).rejects.toMatchObject({
      response: { code: 'PUSH_INVALID' },
    });
    await push.register(device, { ...registration, widget: true });
    expect(devices.pushTargets()[0]!.push.widget).toBe(true);
    const writes = kube.writes.length;
    await push.register(device, { ...registration, widget: true });
    expect(kube.writes.length).toBe(writes);
    await push.register(device, { ...registration, widget: false });
    expect(kube.writes.length).toBeGreaterThan(writes);
    expect(devices.pushTargets()[0]!.push.widget).toBeUndefined();
  });
});

describe('the hourly status push', () => {
  it('goes to a widget device once an hour without other pushes: silent, the state only, no text', async () => {
    const { device, push, sent, clock } = await setup();
    await push.register(device, { ...registration, widget: true });
    // Not right after start (a restart or a new leader would otherwise send a round at once).
    expect(await push.refreshWidgets(status)).toEqual({ due: 0, sent: 0 });
    clock.now += 59 * MIN;
    expect(await push.refreshWidgets(status)).toEqual({ due: 0, sent: 0 });
    clock.now += MIN;
    expect(await push.refreshWidgets(status)).toEqual({ due: 1, sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ token: TOKEN, platform: 'android', silent: true });
    const content = opened(sent[0]!);
    expect(isStatusOnly(content)).toBe(true);
    expect(content).toEqual({ t: '', b: '', p: 0, s: clock.now, w: status });
    // The next one an hour later, not on the next run.
    clock.now += 5 * MIN;
    expect((await push.refreshWidgets(status)).due).toBe(0);
    clock.now += 55 * MIN;
    expect((await push.refreshWidgets(status)).sent).toBe(1);
    expect(push.widgetPushCounts().get('sent')).toBe(2);
  });

  it('is skipped while another push reached the device within the interval', async () => {
    const { device, push, sent, clock } = await setup();
    await push.register(device, { ...registration, widget: true });
    clock.now += 50 * MIN;
    await push.deliver({ title: 'homelab: 1 problem', body: '…', priority: 3, status });
    clock.now += 30 * MIN; // 80 min after start, 30 after the alert
    expect(await push.refreshWidgets(status)).toEqual({ due: 0, sent: 0 });
    clock.now += 30 * MIN;
    expect((await push.refreshWidgets(status)).sent).toBe(1);
    expect(sent.map((s) => s.silent === true)).toEqual([false, true]);
  });

  it('never goes to devices without a widget (and so never to apps before it)', async () => {
    const { device, push, sent, clock } = await setup();
    await push.register(device, registration);
    clock.now += 3 * 60 * MIN;
    expect(await push.refreshWidgets(status)).toEqual({ due: 0, sent: 0 });
    expect(sent).toHaveLength(0);
  });

  it('is off with WIDGET_REFRESH_MINUTES=0, with APP_PUSH off, and towards a relay that did not promise to keep it silent', async () => {
    for (const options of [{ config: { widgetRefreshMinutes: 0 } }, { statusPush: false }]) {
      const { device, push, sent, clock } = await setup(options);
      await push.register(device, { ...registration, widget: true });
      clock.now += 3 * 60 * MIN;
      expect(await push.refreshWidgets(status)).toEqual({ due: 0, sent: 0 });
      expect(sent).toHaveLength(0);
    }
    const off = await setup({ config: { appPush: false } });
    off.clock.now += 3 * 60 * MIN;
    expect(await off.push.refreshWidgets(status)).toEqual({ due: 0, sent: 0 });
  });

  it('honours a longer interval', async () => {
    const { device, push, clock } = await setup({ config: { widgetRefreshMinutes: 120 } });
    await push.register(device, { ...registration, widget: true });
    clock.now += 90 * MIN;
    expect((await push.refreshWidgets(status)).due).toBe(0);
    clock.now += 30 * MIN;
    expect((await push.refreshWidgets(status)).sent).toBe(1);
  });

  it('after a refusal tries again in ten minutes, not on every run (each try costs the agent allowance at the relay)', async () => {
    const { device, push, sent, clock, outcome } = await setup({ outcome: 'rate_limited' });
    await push.register(device, { ...registration, widget: true });
    clock.now += 60 * MIN;
    expect(await push.refreshWidgets(status)).toEqual({ due: 1, sent: 0 });
    clock.now += MIN;
    expect((await push.refreshWidgets(status)).due).toBe(0);
    clock.now += 9 * MIN;
    outcome.value = 'sent';
    expect((await push.refreshWidgets(status)).sent).toBe(1);
    expect(sent).toHaveLength(2);
    expect(push.widgetPushCounts().get('rate_limited')).toBe(1);
  });
});

describe('PushTransport.statusAvailable', () => {
  it('is false for a carrier that does not say so', () => {
    const transport = new PushTransport();
    expect(transport.statusAvailable()).toBe(false);
    transport.attach({ available: () => true, send: async () => 'sent' });
    expect(transport.statusAvailable()).toBe(false);
    transport.attach({ available: () => null, statusAvailable: () => true, send: async () => 'sent' });
    expect(transport.statusAvailable()).toBe(false);
  });
});

describe('Notifier.refreshWidgets', () => {
  const snapshot = {
    light: 'green',
    issues: [],
    checkedAt: new Date(1_795_000_000_000).toISOString(),
  } as unknown as Snapshot;

  it('sends the run state, and nothing when notifications are locked in the chart', async () => {
    const { config, device, push, sent, clock } = await setup();
    await push.register(device, { ...registration, widget: true });
    clock.now += 60 * MIN;
    await new Notifier({ ...config, disabledModules: ['notifications'] }, undefined, push).refreshWidgets(snapshot);
    expect(sent).toHaveLength(0);
    await new Notifier(config, undefined, push).refreshWidgets(snapshot);
    expect(sent).toHaveLength(1);
    expect(opened(sent[0]!).w).toEqual({ l: 'green', c: 0, n: 0, a: 1_795_000_000_000 });
  });
});
