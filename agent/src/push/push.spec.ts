import { AddressInfo } from 'node:net';
import {
  FrameType,
  PushRequest,
  RegistrationChallenge,
  decodeFrame,
  decodePushContent,
  decodePushRequest,
  encodeFrame,
  encodePushResult,
  fromBase64Url,
  generateKeyPair,
  openPush,
  pushKeyId,
  toBase64Url,
} from '@kubernanny/protocol';
import { NotFoundException } from '../http/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { DevicesService, Principal } from '../auth/devices.service';
import { IdentityService } from '../auth/identity.service';
import { Config, loadConfig, parseAppPush } from '../config';
import { DemoKubeClient } from '../demo/demo-cluster';
import { E2eService } from '../e2e/e2e.service';
import { RelayClient } from '../relay/relay-client';
import { AppPushService } from './app-push.service';
import { PushController } from './push.controller';
import { PushTransport } from './push-transport';

const TOKEN = 'cXVpdGUtYS10b2tlbg:APA91bHPRgkF-test_token';
const agentKeys = generateKeyPair();
const identity = { keyPair: agentKeys } as IdentityService;

/** A carrier that records what would go to the relay. */
function recordingTransport(outcome: Awaited<ReturnType<PushTransport['send']>> = 'sent') {
  const sent: PushRequest[] = [];
  const transport = new PushTransport();
  transport.attach({ available: () => true, send: async (push) => (sent.push(push), outcome) });
  return { transport, sent };
}

async function setup(overrides: Partial<Config> = {}, outcome?: Awaited<ReturnType<PushTransport['send']>>) {
  const config: Config = { ...loadConfig(), relayUrl: 'wss://relay.example.org', ...overrides };
  const kube = new DemoKubeClient();
  const devices = new DevicesService(config, kube);
  await devices.onModuleInit();
  const view = await devices.add('Phone', generateKeyPair().publicKey);
  const device: Principal = { kind: 'device', id: view.id, name: view.name };
  const { transport, sent } = recordingTransport(outcome);
  const push = new AppPushService(config, devices, identity, transport);
  return { config, kube, devices, device, push, sent, transport };
}

const secretWrites = (kube: DemoKubeClient) => kube.writes.filter((w) => w.path.includes('/secrets/') || w.path.endsWith('/secrets'));
const pushKey = generateKeyPair();
const registration = { token: TOKEN, platform: 'ios', key: toBase64Url(pushKey.publicKey) };
const message = { title: 'homelab: 1 problem', body: '🔴 default/api: CrashLoopBackOff', priority: 5 };

describe('APP_PUSH', () => {
  it('is on by default and refuses typos', () => {
    expect(parseAppPush(undefined)).toBe(true);
    expect(parseAppPush('on')).toBe(true);
    expect(parseAppPush('off')).toBe(false);
    expect(parseAppPush('false')).toBe(false);
    expect(() => parseAppPush('of')).toThrow(/APP_PUSH/);
  });
});

describe('push registration', () => {
  it('stores the token with the device, shows only "push: on", and seals each message for that device', async () => {
    const { devices, device, push, sent } = await setup();
    await push.register(device, registration);
    const listed = devices.list();
    expect(listed[0]!.push).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(TOKEN);
    expect(push.view(device)).toEqual({ state: 'on', relay: true, registered: true });

    expect(await push.deliver(message)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ token: TOKEN, platform: 'ios', kid: pushKeyId(pushKey.publicKey), lang: 'en' });
    // What the relay gets says nothing: it opens only with the device's push key and the agent's key.
    expect(Buffer.from(fromBase64Url(sent[0]!.message)).toString('latin1')).not.toContain('CrashLoop');
    const content = decodePushContent(openPush(pushKey, agentKeys.publicKey, fromBase64Url(sent[0]!.message)));
    expect(content).toMatchObject({ t: message.title, b: message.body, p: 5 });
  });

  it('refuses anything but a paired device, a malformed registration, and an agent without a relay', async () => {
    const { device, push } = await setup();
    await expect(push.register({ kind: 'admin', id: 'admin', name: 'Admin' }, registration)).rejects.toMatchObject({ response: { code: 'PUSH_DEVICE_ONLY' } });
    await expect(push.register(device, { ...registration, token: 'short' })).rejects.toMatchObject({ response: { code: 'PUSH_INVALID' } });
    await expect(push.register(device, { ...registration, platform: 'web' })).rejects.toMatchObject({ response: { code: 'PUSH_INVALID' } });
    await expect(push.register(device, { ...registration, key: 'nope' })).rejects.toMatchObject({ response: { code: 'PUSH_INVALID' } });
    const noRelay = await setup({ relayUrl: undefined });
    expect(noRelay.push.state()).toBe('no-relay');
    await expect(noRelay.push.register(noRelay.device, registration)).rejects.toMatchObject({ response: { code: 'PUSH_NO_RELAY' } });
  });

  it('removes the token when the device turns push off, is revoked, or FCM no longer knows it', async () => {
    const a = await setup();
    await a.push.register(a.device, registration);
    await a.push.unregister(a.device);
    expect(a.devices.pushTargets()).toEqual([]);

    const b = await setup();
    await b.push.register(b.device, registration);
    await b.devices.revoke(b.device.id);
    expect(b.devices.pushTargets()).toEqual([]);
    const lastWrite = secretWrites(b.kube).at(-1)!.body as { stringData: { devices: string } };
    expect(lastWrite.stringData.devices).not.toContain(TOKEN);

    // FCM's verdict comes through the relay, which is not trusted: only three strikes an hour apart remove the token.
    const c = await setup({}, 'unregistered');
    await c.push.register(c.device, registration);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (let strike = 0; strike < 3; strike++) {
        expect(c.devices.pushTargets()).toHaveLength(1);
        expect(await c.push.deliver(message)).toBe(false);
        vi.setSystemTime(Date.now() + 3_600_000);
      }
    } finally {
      vi.useRealTimers();
    }
    expect(c.devices.pushTargets()).toEqual([]);
  });

  it('survives a restart of the agent (kept in the devices Secret)', async () => {
    const { config, kube, device, push } = await setup();
    await push.register(device, registration);
    const again = new DevicesService(config, kube);
    await again.onModuleInit();
    expect(again.pushTargets()).toEqual([{ deviceId: device.id, push: expect.objectContaining({ token: TOKEN, platform: 'ios' }) }]);
  });
});

describe('APP_PUSH=off: switched off for good, not just hidden', () => {
  it('refuses every push route with 404 before reading or storing anything', async () => {
    const { config, devices, device, push, kube } = await setup({ appPush: false });
    const controller = new PushController(push, config);
    const writes = kube.writes.length;
    await expect(controller.register(device, registration)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.register(device, registration)).rejects.toMatchObject({ response: { code: 'PUSH_OFF' } });
    await expect(controller.unregister(device)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller.test(device)).rejects.toBeInstanceOf(NotFoundException);
    expect(kube.writes.length).toBe(writes);
    expect(devices.pushTargets()).toEqual([]);
    expect(controller.view(device)).toEqual({ state: 'locked', relay: false, registered: false });
  });

  it('deletes tokens stored while it was on, at start', async () => {
    const on = await setup();
    await on.push.register(on.device, registration);
    const offConfig = { ...on.config, appPush: false };
    const devices = new DevicesService(offConfig, on.kube);
    await devices.onModuleInit();
    expect(devices.pushTargets()).toHaveLength(1); // still in the Secret until the service has started
    const off = new AppPushService(offConfig, devices, identity, recordingTransport().transport);
    await off.onApplicationBootstrap();
    expect(devices.pushTargets()).toEqual([]);
    const lastWrite = secretWrites(on.kube).at(-1)!.body as { stringData: { devices: string } };
    expect(lastWrite.stringData.devices).not.toContain(TOKEN);
  });

  it('never hands a push to the relay, even with a token left behind', async () => {
    const on = await setup();
    await on.push.register(on.device, registration);
    const { transport, sent } = recordingTransport();
    const off = new AppPushService({ ...on.config, appPush: false }, on.devices, identity, transport);
    expect(off.hasTargets()).toBe(false);
    expect(await off.deliver(message)).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe('RelayClient as the push carrier', () => {
  let wss: WebSocketServer | null = null;
  let client: RelayClient | null = null;

  beforeEach(() => {
    wss = null;
    client = null;
  });
  afterEach(async () => {
    client?.onModuleDestroy();
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  });

  /** A relay that registers the agent, says whether it offers push, and answers Push frames with `outcome`. */
  async function relay(offersPush: boolean, appPush: boolean, offersStatusPush = false) {
    wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as AddressInfo).port;
    const pushes: PushRequest[] = [];
    const ready = new Promise<void>((resolve) => {
      wss!.on('connection', (ws: WebSocket) => {
        ws.on('message', (data: Buffer, binary: boolean) => {
          if (!binary) {
            return;
          }
          const frame = decodeFrame(new Uint8Array(data));
          if (frame.type === FrameType.Proof) {
            ws.send(encodeFrame(FrameType.Ready, 0, new TextEncoder().encode(JSON.stringify({ push: offersPush, ...(offersStatusPush ? { statusPush: true } : {}) }))));
            setTimeout(resolve, 20);
          } else if (frame.type === FrameType.Push) {
            pushes.push(decodePushRequest(frame.payload)!);
            ws.send(encodePushResult(frame.callId, 'sent'));
          }
        });
        ws.send(new RegistrationChallenge().frame());
      });
    });
    const transport = new PushTransport();
    client = new RelayClient({ relayUrl: `ws://127.0.0.1:${port}`, appPush } as Config, identity, {} as E2eService, transport);
    client.onApplicationBootstrap();
    await ready;
    return { pushes, transport };
  }

  const request: PushRequest = { token: TOKEN, platform: 'android', kid: 'AbCdEfGhIjKlMnOp', message: toBase64Url(new Uint8Array(80)) };

  it('sends a Push frame when the relay offers push, and returns its answer', async () => {
    const { pushes, transport } = await relay(true, true);
    expect(transport.available()).toBe(true);
    expect(await transport.send(request)).toBe('sent');
    expect(pushes).toEqual([request]);
  });

  it('sends a status push only to a relay that promised to keep it silent (Ready statusPush)', async () => {
    const silent = { ...request, silent: true };
    const before = await relay(true, true);
    expect(before.transport.statusAvailable()).toBe(false);
    expect(await before.transport.send(silent)).toBe('disabled');
    expect(before.pushes).toEqual([]);
    client!.onModuleDestroy();
    await new Promise<void>((resolve) => wss!.close(() => resolve()));
    const after = await relay(true, true, true);
    expect(after.transport.statusAvailable()).toBe(true);
    expect(await after.transport.send(silent)).toBe('sent');
    expect(after.pushes).toEqual([silent]);
  });

  it('sends nothing to a relay that offers no push', async () => {
    const { pushes, transport } = await relay(false, true);
    expect(await transport.send(request)).toBe('disabled');
    expect(await client!.send(request)).toBe('disabled');
    expect(pushes).toEqual([]);
  });

  it('with APP_PUSH off is never attached, and sends nothing even when asked directly', async () => {
    const { pushes, transport } = await relay(true, false);
    expect(transport.available()).toBe(false);
    expect(await transport.send(request)).toBe('disabled');
    expect(await client!.send(request)).toBe('disabled');
    expect(pushes).toEqual([]);
  });
});
