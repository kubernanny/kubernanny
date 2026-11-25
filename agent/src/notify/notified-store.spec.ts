import { generateKeyPair } from '@kubernanny/protocol';
import { describe, expect, it } from 'vitest';
import { DevicesService } from '../auth/devices.service';
import { IdentityService } from '../auth/identity.service';
import { Config, loadConfig } from '../config';
import { DemoKubeClient } from '../demo/demo-cluster';
import { IncidentsService } from '../incidents/incidents.service';
import { raw } from '../i18n/text';
import { AppPushService, AppPushMessage } from '../push/app-push.service';
import { PushTransport } from '../push/push-transport';
import { SETTINGS_CONFIGMAP as SETTINGS } from '../settings/settings.service';
import type { IssueView, Snapshot } from '../status/status.service';
import { MAX_NOTIFIED, MAX_NOTIFIED_BYTES, NotifiedStore, SETTINGS_CONFIGMAP, parseNotified, serializeNotified } from './notified-store';
import { Notifier, Pushed } from './notifier';

const NOW = new Date('2026-11-24T04:10:00Z');
const issue = (id: string, severity: IssueView['severity'] = 'critical'): IssueView => ({
  id,
  check: 'pods',
  severity,
  title: raw(`T ${id}`),
  cause: raw(`C ${id}`),
  actions: [],
  since: new Date(NOW.getTime() - 3_600_000).toISOString(),
  module: 'pods',
});
const snapshot = (issues: IssueView[]) => ({ cluster: 'home', issues }) as unknown as Snapshot;

/** A notifier whose only channel is native push, recording what the devices would get. */
async function pushOnlyNotifier(kube: DemoKubeClient, overrides: Partial<Config> = {}) {
  const config: Config = { ...loadConfig(), ntfyUrl: undefined, webhookUrl: undefined, relayUrl: 'wss://relay.example.org', notifyAfterSeconds: 60, ...overrides };
  const devices = new DevicesService(config, kube);
  await devices.onModuleInit();
  const sent: AppPushMessage[] = [];
  const push = new AppPushService(config, devices, { keyPair: generateKeyPair() } as IdentityService, new PushTransport());
  push.deliver = async (message) => (sent.push(message), true);
  if (devices.pushTargets().length === 0) {
    const view = await devices.add('Phone', generateKeyPair().publicKey);
    await devices.setPush(view.id, { token: 'cXVpdGUtYS10b2tlbg:APA91b-test', platform: 'android', key: 'B1UPtjCD2JI3Uq6O-Ka7FdNGOLHHDIUrDtEEm4AXfjs' });
  }
  return { notifier: new Notifier(config, new IncidentsService(), push, new NotifiedStore(config, kube)), sent };
}

describe('notified state', () => {
  it('lives in the settings ConfigMap', () => {
    expect(SETTINGS_CONFIGMAP).toBe(SETTINGS);
  });

  it('round-trips compactly and drops what does not parse', () => {
    const pushed = new Map<string, Pushed>([
      ['a', { title: raw('T a'), severity: 'warning' }],
      ['b', { title: raw('T b'), severity: 'critical' }],
    ]);
    expect(parseNotified(serializeNotified(pushed))).toEqual(pushed);
    expect(parseNotified('{"v":1,"issues":{"x":{"s":"?","t":{}}}}').size).toBe(0);
    expect(parseNotified('not json').size).toBe(0);
    expect(parseNotified(undefined).size).toBe(0);
  });

  it('is capped in entries and bytes, keeping the newest', () => {
    const many = new Map<string, Pushed>(Array.from({ length: 1000 }, (_, i) => [`issue-${i}`, { title: raw('x'.repeat(400)), severity: 'warning' as const }]));
    const text = serializeNotified(many);
    expect(text.length).toBeLessThanOrEqual(MAX_NOTIFIED_BYTES);
    const back = parseNotified(text);
    expect(back.size).toBeLessThanOrEqual(MAX_NOTIFIED);
    expect(back.has('issue-999')).toBe(true);
    expect(back.has('issue-0')).toBe(false);
  });
});

describe('notifications across an agent restart (roadmap: persist notification state)', () => {
  it('never sends "opened" again for an issue still open, and still sends "resolved"', async () => {
    const kube = new DemoKubeClient();
    const first = await pushOnlyNotifier(kube);
    await first.notifier.update(snapshot([issue('pods/a'), issue('pods/b')]), NOW);
    expect(first.sent).toHaveLength(1);
    expect(first.sent[0]!.title).toBe('home: 2 problems');

    // A new process: nothing in memory, the same cluster.
    const second = await pushOnlyNotifier(kube);
    await second.notifier.update(snapshot([issue('pods/a'), issue('pods/b')]), new Date(NOW.getTime() + 60_000));
    expect(second.sent).toEqual([]);
    await second.notifier.update(snapshot([issue('pods/a')]), new Date(NOW.getTime() + 120_000));
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.body).toBe('✅ resolved: T pods/b');

    // And the resolution itself is remembered.
    const third = await pushOnlyNotifier(kube);
    await third.notifier.update(snapshot([issue('pods/a')]), new Date(NOW.getTime() + 180_000));
    expect(third.sent).toEqual([]);
  });

  it('sends the same minimal text through the app channel with NOTIFY_DETAIL=minimal', async () => {
    const { notifier, sent } = await pushOnlyNotifier(new DemoKubeClient(), { notifyDetail: 'minimal' });
    expect(notifier.channels).toEqual(['app']);
    await notifier.update(snapshot([issue('pods/secret-ns/Deployment/billing')]), NOW);
    expect(sent).toMatchObject([{ title: 'home: new problems', body: '1 critical. Details in Kubernanny.', priority: 5 }]);
    // The widget's status counts only, no titles, like the text.
    expect(sent[0]!.status).toMatchObject({ c: 1, n: 0 });
    expect(sent[0]!.status!.i).toBeUndefined();
    expect(JSON.stringify(sent)).not.toMatch(/billing|secret-ns/);
  });

  it('counts the app as a channel for security alerts and the test message', async () => {
    const { notifier, sent } = await pushOnlyNotifier(new DemoKubeClient());
    await notifier.securityAlert('Phone', [{ kind: 'devicePaired' }]);
    expect(sent.at(-1)!.priority).toBe(4);
    expect(await notifier.test('home')).toEqual(['app']);
  });
});
