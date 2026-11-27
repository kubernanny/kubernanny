import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  encodePushContent,
  generateKeyPair,
  isDeadman,
  parsePublicKey,
  pushKeyId,
  sealPush,
  toBase64Url,
} from '@kubernanny/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { translatorFor } from '../../i18n/translator';
import { AgentPushView, ClusterConfig } from '../agent.model';
import { AgentClient } from '../agent-client.service';
import { ClusterStore } from '../cluster-store.service';
import { WidgetBridge } from '../widget/widget-bridge';
import {
  deadmanFresh,
  MAX_PUSH_AGE_MS,
  openPushMessage,
  pushFresh,
  statusPushFresh,
} from './push-content';
import { PushNative } from './push-native';
import { PushRegistration } from './push-registration.service';
import { deadmanView, pushView } from './push-view';

const en = translatorFor('en');
const agentKeys = generateKeyPair();
const config = (extra: Partial<ClusterConfig> = {}): ClusterConfig => ({
  id: 'c1',
  name: 'homelab',
  url: 'https://agent.example',
  agentKey: toBase64Url(agentKeys.publicKey),
  deviceKey: 'PRIVATE-DEVICE-KEY',
  deviceId: 'dev-1',
  ...extra,
});

describe('openPushMessage (the reference the iOS extension and the Android service mirror)', () => {
  it('opens the first vector of protocol/test/push-vectors.json', () => {
    // Base64url of the vector "status": push secret, agent static public key, message.
    const content = openPushMessage(
      'ISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0-P0A',
      'iDGGuAC0HVzwQpaV2ps8xPMo680YSm5IL6V4wQPwbHc',
      'ASRP47lj6JndKVuv_OJI01MPOpp0eboGMAJoDr_nra1JJ3c7HLo-EgGzY0xSag8J2ZIiwtXc6jwMsL2YkITc_seVhcnL7ojxpFUDLd48UcUc8ibPI7qRg3NBBTIU2X8bP0RjaVsOXKQJQqNah4vME2AhsE9Ya1k4qpxHHmn-xrM3VmJKK6TVF99vRbrJ',
    );
    expect(content).toEqual({
      t: 'homelab: 2 problems',
      b: '🔴 default/api: CrashLoopBackOff',
      p: 5,
      s: 1795000000000,
    });
  });

  it('refuses a message from another key than the pinned agent', () => {
    const push = generateKeyPair();
    const sealed = sealPush(
      generateKeyPair(),
      push.publicKey,
      encodePushContent({ t: 'x', b: 'y', p: 3, s: 1 }),
    );
    expect(() =>
      openPushMessage(
        toBase64Url(push.secretKey),
        toBase64Url(agentKeys.publicKey),
        toBase64Url(sealed),
      ),
    ).toThrow();
  });
});

describe('pushView', () => {
  const agent = (extra: Partial<AgentPushView> = {}): AgentPushView => ({
    state: 'on',
    relay: true,
    registered: false,
    deadman: { state: 'on', grace: 15 },
    ...extra,
  });
  const ios = { available: true, platform: 'ios' as const };

  it('is hidden in a build without push, for the demo, and while the agent has not answered', () => {
    expect(
      pushView({ demo: false, native: { available: false, platform: null }, agent: agent() }, en)
        .visible,
    ).toBe(false);
    expect(pushView({ demo: true, native: ios, agent: agent() }, en).visible).toBe(false);
    expect(pushView({ demo: false, native: ios, agent: null }, en).visible).toBe(false);
  });

  it('shows a lock and no button when the deployment switched it off', () => {
    expect(
      pushView({ demo: false, native: ios, agent: agent({ state: 'locked' }) }, en),
    ).toMatchObject({ visible: true, locked: true, action: null, canTest: false });
  });

  it('explains that a relay is needed, without a button', () => {
    expect(
      pushView({ demo: false, native: ios, agent: agent({ state: 'no-relay' }) }, en),
    ).toMatchObject({ visible: true, action: null, note: expect.stringContaining('relay') });
  });

  it('offers to turn it on, and once on, to turn it off and test', () => {
    expect(pushView({ demo: false, native: ios, agent: agent() }, en)).toMatchObject({
      action: 'enable',
      actionLabel: 'Push to this device',
      canTest: false,
    });
    expect(
      pushView({ demo: false, native: ios, agent: agent({ registered: true }) }, en),
    ).toMatchObject({ action: 'disable', canTest: true, note: 'On for this device.' });
    expect(
      pushView({ demo: false, native: ios, agent: agent({ registered: true, relay: false }) }, en),
    ).toMatchObject({ action: 'disable', canTest: false });
  });

  it('always offers to switch off a sign kept on the phone, whatever the agent says', () => {
    const on = { on: true, line: expect.stringContaining('🦉🌵⚓') };
    // The agent did not answer: the section shows, with only the sign.
    expect(pushView({ demo: false, native: ios, agent: null, marker: '🦉🌵⚓' }, en)).toMatchObject(
      {
        visible: true,
        action: null,
        sign: on,
      },
    );
    // Push off for this device, locked or without a relay: the sign stays reachable.
    for (const a of [agent(), agent({ state: 'locked' }), agent({ state: 'no-relay' })]) {
      expect(
        pushView({ demo: false, native: ios, agent: a, marker: '🦉🌵⚓' }, en).sign,
      ).toMatchObject(on);
    }
    // Without a stored sign nothing changes: no sign row where push is off.
    expect(
      pushView({ demo: false, native: ios, agent: agent(), marker: null }, en).sign,
    ).toBeNull();
    expect(pushView({ demo: false, native: ios, agent: null, marker: null }, en).visible).toBe(
      false,
    );
  });
});

/** Stands in for the plugin: what it holds is what the device's keychain or Keystore would hold. */
class FakeNative {
  available = true;
  granted = true;
  currentToken = 'fcm-token-1:APA91b';
  keys = new Map<
    string,
    { secretKey: string; publicKey: string; agentKey: string; clusterId: string }
  >();
  permissionAsked = 0;
  async status() {
    return { available: this.available, platform: this.available ? ('ios' as const) : null };
  }
  async requestPermission() {
    this.permissionAsked++;
    return this.granted;
  }
  async token() {
    return this.currentToken;
  }
  async storeKey(o: {
    kid: string;
    secretKey: string;
    publicKey: string;
    agentKey: string;
    clusterId: string;
  }) {
    this.keys.set(o.kid, o);
  }
  async removeKey(kid: string) {
    this.keys.delete(kid);
  }
}

/** Stands in for the widget bridge: whether a widget is placed, and which clusters its list holds. */
class FakeWidgets {
  count = 0;
  ids: string[] = ['c1'];
  async placed() {
    return this.count > 0;
  }
  async read() {
    return this.ids.map((id) => ({ id }));
  }
}

class FakeClient {
  registered: {
    token: string;
    platform: string;
    key: string;
    widget: boolean;
    deadman?: number | false;
  }[] = [];
  unregistered = 0;
  fail = false;
  async registerPush(
    _: ClusterConfig,
    r: { token: string; platform: string; key: string; widget: boolean; deadman?: number | false },
  ) {
    if (this.fail) {
      throw new Error('agent says no');
    }
    this.registered.push(r);
  }
  async unregisterPush() {
    this.unregistered++;
  }
  async testPush() {
    return { outcome: 'sent' };
  }
}

class FakeStore {
  readonly clusters = signal<ClusterConfig[]>([config()]);
  async save(c: ClusterConfig) {
    this.clusters.set(this.clusters().map((x) => (x.id === c.id ? c : x)));
    return c;
  }
}

describe('PushRegistration', () => {
  let native: FakeNative;
  let client: FakeClient;
  let store: FakeStore;
  let widgets: FakeWidgets;
  let registration: PushRegistration;

  beforeEach(() => {
    native = new FakeNative();
    client = new FakeClient();
    store = new FakeStore();
    widgets = new FakeWidgets();
    TestBed.configureTestingModule({
      providers: [
        { provide: PushNative, useValue: native },
        { provide: AgentClient, useValue: client },
        { provide: ClusterStore, useValue: store },
        { provide: WidgetBridge, useValue: widgets },
      ],
    });
    registration = TestBed.inject(PushRegistration);
  });

  it('asks for permission on the tap, keeps a push key of its own natively and registers its public half', async () => {
    expect(await registration.enable(config())).toBe('enabled');
    expect(native.permissionAsked).toBe(1);
    const [kid, stored] = [...native.keys][0]!;
    expect(stored).toMatchObject({ agentKey: config().agentKey, clusterId: 'c1' });
    expect(stored.secretKey).not.toBe(config().deviceKey);
    expect(client.registered).toEqual([
      {
        token: 'fcm-token-1:APA91b',
        platform: 'ios',
        key: stored.publicKey,
        widget: false,
        deadman: 15,
      },
    ]);
    expect(kid).toBe(pushKeyId(parsePublicKey(stored.publicKey)));
    expect(store.clusters()[0]!.push).toEqual({
      kid,
      key: stored.publicKey,
      token: 'fcm-token-1:APA91b',
      deadman: 15,
    });
    expect(JSON.stringify(store.clusters())).not.toContain(stored.secretKey);

    // What the agent seals for the registered key opens with what the phone stored.
    const sealed = sealPush(
      agentKeys,
      parsePublicKey(stored.publicKey),
      encodePushContent({ t: 'homelab: 1 problem', b: 'x', p: 5, s: 1 }),
    );
    expect(openPushMessage(stored.secretKey, stored.agentKey, toBase64Url(sealed)).t).toBe(
      'homelab: 1 problem',
    );
  });

  it('stores and registers nothing when permission is refused or the build cannot push', async () => {
    native.granted = false;
    expect(await registration.enable(config())).toBe('denied');
    native.available = false;
    expect(await registration.enable(config())).toBe('unavailable');
    expect(native.keys.size).toBe(0);
    expect(client.registered).toEqual([]);
  });

  it('removes the key again when the agent refuses the registration', async () => {
    client.fail = true;
    await expect(registration.enable(config())).rejects.toThrow();
    expect(native.keys.size).toBe(0);
    expect(store.clusters()[0]!.push).toBeUndefined();
  });

  it('turns off at the agent, then drops the key', async () => {
    await registration.enable(config());
    await registration.disable(store.clusters()[0]!);
    expect(client.unregistered).toBe(1);
    expect(native.keys.size).toBe(0);
    expect(store.clusters()[0]!.push).toBeUndefined();
  });

  it('registers a new FCM token on start, with the same push key', async () => {
    await registration.enable(config());
    const before = store.clusters()[0]!.push!;
    native.currentToken = 'fcm-token-2:APA91b';
    await registration.refreshRegistrations();
    expect(client.registered.at(-1)).toEqual({
      token: 'fcm-token-2:APA91b',
      platform: 'ios',
      key: before.key,
      widget: false,
      deadman: 15,
    });
    expect(store.clusters()[0]!.push).toEqual({ ...before, token: 'fcm-token-2:APA91b' });
    const count = client.registered.length;
    await registration.refreshRegistrations();
    expect(client.registered.length).toBe(count);
  });

  it('tells the agent when a widget shows the cluster, and again when it no longer does', async () => {
    widgets.count = 1;
    await registration.enable(config());
    expect(client.registered.at(-1)!.widget).toBe(true);
    expect(store.clusters()[0]!.push!.widget).toBe(true);
    // Unchanged: nothing is sent again on the next resume.
    const count = client.registered.length;
    await registration.refreshRegistrations();
    expect(client.registered.length).toBe(count);
    // The widget was removed from the home screen.
    widgets.count = 0;
    await registration.refreshRegistrations();
    expect(client.registered.at(-1)).toMatchObject({
      key: store.clusters()[0]!.push!.key,
      widget: false,
    });
    expect(store.clusters()[0]!.push!.widget).toBeUndefined();
    // Placed again, but this cluster is switched off for the widget (not in its list).
    widgets.count = 2;
    widgets.ids = [];
    await registration.refreshRegistrations();
    expect(client.registered.length).toBe(count + 1);
    widgets.ids = ['c1'];
    await registration.refreshRegistrations();
    expect(client.registered.at(-1)!.widget).toBe(true);
  });

  it("turns the dead man's switch on with push, changes its grace and switches it off, registering again each time", async () => {
    await registration.enable(config());
    const cluster = await registration.setDeadman(store.clusters()[0]!, 60);
    expect(client.registered.at(-1)).toMatchObject({ key: cluster.push!.key, deadman: 60 });
    await registration.setDeadman(cluster, false);
    expect(client.registered.at(-1)!.deadman).toBe(false);
    expect(store.clusters()[0]!.push!.deadman).toBe(false);
    // An explicit off survives the next start.
    const count = client.registered.length;
    await registration.refreshRegistrations();
    expect(client.registered.length).toBe(count);
  });

  it("registers once more, with the default, a push set up by an app before the dead man's switch", async () => {
    store.clusters.set([config({ push: { kid: 'k', key: 'key', token: 'fcm-token-1:APA91b' } })]);
    await registration.refreshRegistrations();
    expect(client.registered).toEqual([
      { token: 'fcm-token-1:APA91b', platform: 'ios', key: 'key', widget: false, deadman: 15 },
    ]);
    expect(store.clusters()[0]!.push!.deadman).toBe(15);
    await registration.refreshRegistrations();
    expect(client.registered).toHaveLength(1);
  });

  it('keeps the old flag when the agent cannot be reached, and tries again next time', async () => {
    await registration.enable(config());
    widgets.count = 1;
    client.fail = true;
    await registration.refreshRegistrations();
    expect(store.clusters()[0]!.push!.widget).toBeUndefined();
    client.fail = false;
    await registration.refreshRegistrations();
    expect(store.clusters()[0]!.push!.widget).toBe(true);
  });
});

describe('pushFresh (mirrored by PushFreshness.java and PushKeys.isFresh)', () => {
  const now = 1_795_000_000_000;

  it('shows a push sealed within the last hour, newer than the last one shown', () => {
    expect(pushFresh(now - 5_000, now, null)).toBe(true);
    expect(pushFresh(now - 5_000, now, now - 60_000)).toBe(true);
    expect(pushFresh(now - MAX_PUSH_AGE_MS, now, null)).toBe(true);
  });

  it('drops a replayed or stale push', () => {
    expect(pushFresh(now - MAX_PUSH_AGE_MS - 1, now, null)).toBe(false);
    expect(pushFresh(now - 60_000, now, now - 60_000)).toBe(false);
    expect(pushFresh(now - 60_000, now, now - 5_000)).toBe(false);
  });

  it('applies a status push sealed within the hour, whatever was shown before (statusPushFresh)', () => {
    expect(statusPushFresh(now - 5_000, now)).toBe(true);
    expect(statusPushFresh(now - MAX_PUSH_AGE_MS, now)).toBe(true);
    expect(statusPushFresh(now - MAX_PUSH_AGE_MS - 1, now)).toBe(false);
    expect(statusPushFresh(now + MAX_PUSH_AGE_MS + 1, now)).toBe(false);
  });

  it('drops a push dated more than an hour ahead, so it cannot block the ones after it', () => {
    expect(pushFresh(now + MAX_PUSH_AGE_MS + 1, now, null)).toBe(false);
    expect(pushFresh(Number.NaN, now, null)).toBe(false);
  });
});

describe('deadmanView (the switch in the push section)', () => {
  const on = {
    state: 'on' as const,
    relay: true,
    registered: true,
    deadman: { state: 'on' as const, grace: 15 },
  };
  it("offers the switch and the graces, with the device's choice", () => {
    const vm = deadmanView({ ...on, deadman: { state: 'on', grace: 30 } }, en);
    expect(vm).toMatchObject({
      editable: true,
      on: true,
      grace: 30,
      note: expect.stringContaining('relay sends this phone'),
    });
    expect(vm.graces.map((g) => g.label)).toEqual(['10 min', '15 min', '30 min', '60 min']);
    expect(deadmanView({ ...on, deadman: { state: 'on', grace: null } }, en)).toMatchObject({
      editable: true,
      on: false,
      grace: 15,
    });
  });

  it('explains a deployment that switched it off and a relay without it', () => {
    expect(deadmanView({ ...on, deadman: { state: 'locked', grace: null } }, en)).toMatchObject({
      editable: false,
      note: expect.stringContaining('deadman.enabled'),
    });
    expect(deadmanView({ ...on, deadman: { state: 'relay', grace: 15 } }, en)).toMatchObject({
      editable: true,
      on: true,
      note: expect.stringContaining('relay does not support'),
    });
    expect(
      pushView(
        {
          demo: false,
          native: { available: true, platform: 'ios' },
          agent: { ...on, deadman: { state: 'on', grace: 15 } },
        },
        en,
      ).deadman,
    ).toMatchObject({ on: true });
    expect(
      pushView(
        {
          demo: false,
          native: { available: true, platform: 'ios' },
          agent: { ...on, registered: false },
        },
        en,
      ).deadman,
    ).toBeNull();
  });
});

describe('deadmanFresh (mirrored by PushFreshness.deadmanFresh and PushKeys.isDeadmanFresh)', () => {
  const s = 1_795_000_000_000;
  const message = { s, d: { u: s + 3 * 3_600_000, g: 15 } };
  const MIN = 60_000;

  it('opens the deadman vector and shows it within its window, long after it was sealed', () => {
    // Base64url of the vector "deadman": push secret, agent static public key, message.
    const content = openPushMessage(
      'sbKztLW2t7i5uru8vb6_wMHCw8TFxsfIycrLzM3Oz9A',
      'TSe87jE1xJRLKNJ92Amwe-EMNRYNIBMcqn6FV1SY0Hw',
      'ATX96p4w06MsjDZt0Y4e7kwTJmmV_VwcBOppQgbOowh8hYarE-piepKZaBYRrorxfB7lbcyU8YZKWo3WRO7nevokwUNmK5_UHZG6It2z_1cigIo-IGH3NOjTXI9GVu1V1vs2x0ZimWDB-NktFhdNbKob5g9otD3C3p6IG7A1e6NmGj80Ny1QvehYRf6mc8Ko7tVHMdCi8Y7y426zE7xKdXyLWCkP7-FemM6b6hsIy1E1aMg40ijP9k_3ISdIWeIUwxprT4IaCaaMSk-685w0Lwn4AOuVZA4',
    );
    expect(isDeadman(content)).toBe(true);
    expect(deadmanFresh(content as typeof message, s + 2 * 3_600_000, null, null)).toBe(true);
    expect(deadmanFresh(message, s + 90 * MIN, null, s - 10 * MIN)).toBe(true);
  });

  it('is not held back by pushes shown since it was sealed (its own replay marker)', () => {
    expect(pushFresh(s, s + 90 * MIN, s + 20 * MIN)).toBe(false);
    expect(deadmanFresh(message, s + 90 * MIN, null, s + 20 * MIN)).toBe(true);
  });

  it('drops a replay, one past its window, one dated ahead, and one while the agent was heard within the grace', () => {
    expect(deadmanFresh(message, s + 90 * MIN, s, null)).toBe(false);
    expect(deadmanFresh(message, s + 3 * 3_600_000 + 1, null, null)).toBe(false);
    expect(deadmanFresh({ s: s + 2 * 3_600_000, d: message.d }, s, null, null)).toBe(false);
    expect(deadmanFresh({ s, d: { u: s + 28 * 3_600_000, g: 15 } }, s + MIN, null, null)).toBe(
      false,
    );
    expect(deadmanFresh(message, s + 90 * MIN, null, s + 80 * MIN)).toBe(false);
  });
});
