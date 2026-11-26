import {
  DeadmanDeposit,
  decodePushContent,
  fromBase64Url,
  generateKeyPair,
  isDeadman,
  openPush,
  PushRequest,
  PushStatus,
  toBase64Url,
} from '@kubernanny/protocol';
import { describe, expect, it } from 'vitest';

import { DevicesService, Principal } from '../auth/devices.service';
import { IdentityService } from '../auth/identity.service';
import { Config, loadConfig, parseDeadman } from '../config';
import { DemoKubeClient } from '../demo/demo-cluster';
import { AppPushService } from './app-push.service';
import { DEADMAN_REFRESH_MS, DEADMAN_VALIDITY_MS, DeadmanService } from './deadman.service';
import { PushTransport, RelayReady } from './push-transport';

const TOKEN = 'cXVpdGUtYS10b2tlbg:APA91bHPRgkF-test_token';
const agentKeys = generateKeyPair();
const identity = { keyPair: agentKeys } as IdentityService;
const pushKey = generateKeyPair();
const registration = { token: TOKEN, platform: 'ios', key: toBase64Url(pushKey.publicKey) };
const status: PushStatus = { l: 'green', c: 0, n: 0, a: 1_800_000_000_000 };
const MIN = 60_000;
const armed = { armed: true, holdUntil: null, status };

async function setup(options: { config?: Partial<Config>; relayDeadman?: boolean } = {}) {
  const config: Config = {
    ...loadConfig(),
    relayUrl: 'wss://relay.example.org',
    clusterName: 'homelab',
    language: 'de',
    ...options.config,
  };
  const devices = new DevicesService(config, new DemoKubeClient());
  await devices.onModuleInit();
  const view = await devices.add('Phone', generateKeyPair().publicKey);
  const device: Principal = { kind: 'device', id: view.id, name: view.name };
  const clock = { now: 1_800_000_000_000 };
  const deposits: DeadmanDeposit[] = [];
  const pushes: PushRequest[] = [];
  let ready: ((event: RelayReady) => void) | null = null;
  const transport = new PushTransport();
  transport.attach({
    available: () => true,
    statusAvailable: () => true,
    deadmanAvailable: () => options.relayDeadman ?? true,
    send: async (push) => (pushes.push(push), 'sent'),
    deposit: async (deposit) => (deposits.push(deposit), 'stored'),
    onReady: (listener) => (ready = listener),
  });
  const push = new AppPushService(config, devices, identity, transport, () => clock.now);
  const deadman = new DeadmanService(config, devices, identity, transport, push, () => clock.now);
  const connect = (n: number, fired: RelayReady['fired'] = null) => ready!({ connection: n, deadman: true, fired });
  return { config, devices, device, push, deadman, deposits, pushes, clock, connect };
}

const opened = (message: string) => decodePushContent(openPush(pushKey, agentKeys.publicKey, fromBase64Url(message)));
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('DEADMAN', () => {
  it('is on by default, off with off/false/0', () => {
    expect(parseDeadman(undefined)).toBe(true);
    expect(parseDeadman('off')).toBe(false);
    expect(() => parseDeadman('sometimes')).toThrow(/DEADMAN/);
  });
});

describe("registration with the dead man's switch", () => {
  it('stores the grace, refuses other values, and shows it in the view', async () => {
    const { device, push, devices } = await setup();
    await expect(push.register(device, { ...registration, deadman: 20 })).rejects.toMatchObject({
      response: { code: 'PUSH_INVALID' },
    });
    await expect(push.register(device, { ...registration, deadman: 'yes' })).rejects.toMatchObject({
      response: { code: 'PUSH_INVALID' },
    });
    await push.register(device, { ...registration, deadman: 15 });
    expect(devices.pushTargets()[0]!.push.deadman).toBe(15);
    expect(push.view(device).deadman).toEqual({ state: 'on', grace: 15 });
    await push.register(device, { ...registration, deadman: false });
    expect(devices.pushTargets()[0]!.push.deadman).toBeUndefined();
    expect(push.view(device).deadman).toEqual({ state: 'on', grace: null });
  });

  it('says locked with DEADMAN=off and relay when the relay does not hold deposits', async () => {
    expect(
      (await setup({ config: { deadman: false } })).push.view({ kind: 'device', id: 'x', name: 'x' }).deadman.state,
    ).toBe('locked');
    expect((await setup({ relayDeadman: false })).push.view({ kind: 'device', id: 'x', name: 'x' }).deadman.state).toBe(
      'relay',
    );
  });
});

describe('the deposit', () => {
  it('seals one "agent silent" message per device, in the agent language, with its validity and grace', async () => {
    const { device, push, deadman, deposits, clock, connect } = await setup();
    await push.register(device, { ...registration, deadman: 30 });
    connect(1);
    await deadman.tick(armed);
    expect(deposits).toHaveLength(1);
    const [deposit] = deposits;
    expect(deposit).toMatchObject({ validitySeconds: DEADMAN_VALIDITY_MS / 1000, holdSeconds: 0 });
    expect(deposit!.items).toHaveLength(1);
    expect(deposit!.items[0]).toMatchObject({ token: TOKEN, platform: 'ios', graceMinutes: 30, lang: 'de' });
    const content = opened(deposit!.items[0]!.message);
    expect(isDeadman(content)).toBe(true);
    expect(content).toMatchObject({
      t: 'homelab: Kubernanny schweigt',
      b: 'Kubernanny meldet sich seit 30 Min. nicht. Cluster oder Agent prüfen.',
      p: 3,
      s: clock.now,
      d: { u: clock.now + DEADMAN_VALIDITY_MS, g: 30 },
    });
    expect(content.w).toBeUndefined();
  });

  it('is renewed every 30 minutes, at once when a registration changes, and on every new relay connection', async () => {
    const { device, push, deadman, deposits, clock, connect } = await setup();
    await push.register(device, { ...registration, deadman: 15 });
    connect(1);
    await deadman.tick(armed);
    await deadman.tick(armed);
    expect(deposits).toHaveLength(1);
    clock.now += DEADMAN_REFRESH_MS;
    await deadman.tick(armed);
    expect(deposits).toHaveLength(2);
    await push.register(device, { ...registration, deadman: 60 });
    await settle();
    expect(deposits).toHaveLength(3);
    expect(deposits[2]!.items[0]!.graceMinutes).toBe(60);
    // A rollout: the new leader's connection deposits again right away.
    connect(2);
    await settle();
    expect(deposits).toHaveLength(4);
  });

  it('holds nothing for devices that did not ask, or while notifications are paused, and clears what it held', async () => {
    const { device, push, deadman, deposits, connect } = await setup();
    await push.register(device, registration);
    connect(1);
    await deadman.tick(armed);
    expect(deposits.at(-1)!.items).toEqual([]); // the first frame on a connection clears what an earlier pod left
    await deadman.tick(armed);
    expect(deposits).toHaveLength(1);
    await push.register(device, { ...registration, deadman: 10 });
    await settle();
    expect(deposits.at(-1)!.items).toHaveLength(1);
    await deadman.tick({ ...armed, armed: false });
    expect(deposits.at(-1)!.items).toEqual([]);
  });

  it('deposits nothing before the run loop ticked on this pod, and nothing with DEADMAN=off', async () => {
    const first = await setup();
    await first.push.register(first.device, { ...registration, deadman: 15 });
    first.connect(1);
    await settle();
    expect(first.deposits).toHaveLength(0);
    const off = await setup({ config: { deadman: false } });
    await off.push.register(off.device, { ...registration, deadman: 15 });
    off.connect(1);
    await off.deadman.tick(armed);
    expect(off.deposits.at(-1)!.items).toEqual([]);
  });

  it('waits out a maintenance window: the relay holds the message until it ends, and it stays valid past it', async () => {
    const { device, push, deadman, deposits, clock, connect } = await setup();
    await push.register(device, { ...registration, deadman: 15 });
    connect(1);
    await deadman.tick({ ...armed, holdUntil: clock.now + 4 * 60 * MIN });
    const deposit = deposits.at(-1)!;
    expect(deposit.holdSeconds).toBe(4 * 3600);
    expect(deposit.validitySeconds).toBe(4 * 3600 + DEADMAN_VALIDITY_MS / 1000);
    expect(opened(deposit.items[0]!.message).d!.u).toBe(clock.now + 4 * 60 * MIN + DEADMAN_VALIDITY_MS);
  });
});

describe('back after a silence', () => {
  it('tells exactly the devices the relay sent to, with a normal sealed push and the state', async () => {
    const { device, push, deadman, pushes, connect, devices } = await setup();
    await push.register(device, { ...registration, deadman: 15 });
    connect(1);
    await deadman.tick(armed);
    const kid = devices.pushTargets()[0]!.push.kid;
    connect(2, { kids: [kid, 'ZZZZZZZZZZZZZZZZ'], awayMs: 42 * MIN });
    await settle();
    expect(pushes).toHaveLength(1);
    const content = opened(pushes[0]!.message);
    expect(content).toMatchObject({
      t: 'homelab: Kubernanny ist wieder erreichbar',
      b: 'War 42 Min. weg.',
      p: 2,
      w: status,
    });
    expect(isDeadman(content)).toBe(false);
    expect(pushes[0]!.silent).toBeUndefined();
  });

  it('says nothing when the relay sent nothing (back before the grace)', async () => {
    const { device, push, deadman, pushes, connect } = await setup();
    await push.register(device, { ...registration, deadman: 15 });
    connect(1);
    await deadman.tick(armed);
    connect(2);
    await settle();
    expect(pushes).toHaveLength(0);
  });
});
