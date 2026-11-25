import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { encodePushContent, generateKeyPair, parsePublicKey, pushKeyId, sealPush, toBase64Url } from '@kubernanny/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { AgentClient } from '../agent-client.service';
import { AgentPushView, ClusterConfig } from '../agent.model';
import { ClusterStore } from '../cluster-store.service';
import { translatorFor } from '../../i18n/translator';
import { openPushMessage } from './push-content';
import { PushNative } from './push-native';
import { PushRegistration } from './push-registration.service';
import { pushView } from './push-view';

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
    expect(content).toEqual({ t: 'homelab: 2 problems', b: '🔴 default/api: CrashLoopBackOff', p: 5, s: 1795000000000 });
  });

  it('refuses a message from another key than the pinned agent', () => {
    const push = generateKeyPair();
    const sealed = sealPush(generateKeyPair(), push.publicKey, encodePushContent({ t: 'x', b: 'y', p: 3, s: 1 }));
    expect(() => openPushMessage(toBase64Url(push.secretKey), toBase64Url(agentKeys.publicKey), toBase64Url(sealed))).toThrow();
  });
});

describe('pushView', () => {
  const agent = (extra: Partial<AgentPushView> = {}): AgentPushView => ({ state: 'on', relay: true, registered: false, ...extra });
  const ios = { available: true, platform: 'ios' as const };

  it('is hidden in a build without push, for the demo, and while the agent has not answered', () => {
    expect(pushView({ demo: false, native: { available: false, platform: null }, agent: agent() }, en).visible).toBe(false);
    expect(pushView({ demo: true, native: ios, agent: agent() }, en).visible).toBe(false);
    expect(pushView({ demo: false, native: ios, agent: null }, en).visible).toBe(false);
  });

  it('shows a lock and no button when the deployment switched it off', () => {
    expect(pushView({ demo: false, native: ios, agent: agent({ state: 'locked' }) }, en)).toMatchObject({ visible: true, locked: true, action: null, canTest: false });
  });

  it('explains that a relay is needed, without a button', () => {
    expect(pushView({ demo: false, native: ios, agent: agent({ state: 'no-relay' }) }, en)).toMatchObject({ visible: true, action: null, note: expect.stringContaining('relay') });
  });

  it('offers to turn it on, and once on, to turn it off and test', () => {
    expect(pushView({ demo: false, native: ios, agent: agent() }, en)).toMatchObject({ action: 'enable', actionLabel: 'Push to this device', canTest: false });
    expect(pushView({ demo: false, native: ios, agent: agent({ registered: true }) }, en)).toMatchObject({ action: 'disable', canTest: true, note: 'On for this device.' });
    expect(pushView({ demo: false, native: ios, agent: agent({ registered: true, relay: false }) }, en)).toMatchObject({ action: 'disable', canTest: false });
  });
});

/** Stands in for the plugin: what it holds is what the device's keychain or Keystore would hold. */
class FakeNative {
  available = true;
  granted = true;
  currentToken = 'fcm-token-1:APA91b';
  keys = new Map<string, { secretKey: string; publicKey: string; agentKey: string; clusterId: string }>();
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
  async storeKey(o: { kid: string; secretKey: string; publicKey: string; agentKey: string; clusterId: string }) {
    this.keys.set(o.kid, o);
  }
  async removeKey(kid: string) {
    this.keys.delete(kid);
  }
}

class FakeClient {
  registered: { token: string; platform: string; key: string }[] = [];
  unregistered = 0;
  fail = false;
  async registerPush(_: ClusterConfig, r: { token: string; platform: string; key: string }) {
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
  let registration: PushRegistration;

  beforeEach(() => {
    native = new FakeNative();
    client = new FakeClient();
    store = new FakeStore();
    TestBed.configureTestingModule({
      providers: [
        { provide: PushNative, useValue: native },
        { provide: AgentClient, useValue: client },
        { provide: ClusterStore, useValue: store },
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
    expect(client.registered).toEqual([{ token: 'fcm-token-1:APA91b', platform: 'ios', key: stored.publicKey }]);
    expect(kid).toBe(pushKeyId(parsePublicKey(stored.publicKey)));
    expect(store.clusters()[0]!.push).toEqual({ kid, key: stored.publicKey, token: 'fcm-token-1:APA91b' });
    expect(JSON.stringify(store.clusters())).not.toContain(stored.secretKey);

    // What the agent seals for the registered key opens with what the phone stored.
    const sealed = sealPush(agentKeys, parsePublicKey(stored.publicKey), encodePushContent({ t: 'homelab: 1 problem', b: 'x', p: 5, s: 1 }));
    expect(openPushMessage(stored.secretKey, stored.agentKey, toBase64Url(sealed)).t).toBe('homelab: 1 problem');
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
    await registration.refreshTokens();
    expect(client.registered.at(-1)).toEqual({ token: 'fcm-token-2:APA91b', platform: 'ios', key: before.key });
    expect(store.clusters()[0]!.push).toEqual({ ...before, token: 'fcm-token-2:APA91b' });
    const count = client.registered.length;
    await registration.refreshTokens();
    expect(client.registered.length).toBe(count);
  });
});
