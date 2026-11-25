import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPair, toBase64Url } from '@kubernanny/protocol';
import { loadConfig } from '../config';
import { KubeClient, KubeError } from '../kube/kube-client';
import { SettingsService } from '../settings/settings.service';
import { SilenceService } from '../silence/silence.service';
import { IdentityService } from '../auth/identity.service';
import { DevicesService } from '../auth/devices.service';
import { AcceptanceService } from '../modules/vulnerabilities/acceptance.service';
import { NotLoadedError, StartupReadError, readAtStartup } from './startup-read';

const who = { kind: 'device' as const, id: 'd1', name: 'Test' };
const noWait = { sleep: async () => undefined };

/** Answers `get` with the queued errors first, then with `data`; records every write. */
class HiccupKube extends KubeClient {
  writes: unknown[] = [];
  gets = 0;
  constructor(
    private readonly failures: number,
    private readonly data: Record<string, string> | null,
  ) {
    super();
  }
  override async get<T>(): Promise<T> {
    this.gets++;
    if (this.gets <= this.failures) {
      throw new KubeError(503, 'etcdserver: leader changed');
    }
    if (!this.data) {
      throw new KubeError(404, 'not found');
    }
    return { data: this.data } as T;
  }
  override async mergePatch(_path: string, body: unknown): Promise<void> {
    this.writes.push(body);
  }
  override async create(_path: string, body: unknown): Promise<void> {
    this.writes.push(body);
  }
}

/** Runs an init with fake timers, so the backoff takes no real time. */
async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  const result = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  return result;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('readAtStartup', () => {
  it('returns null for a 404, retries other errors and gives up after the last delay', async () => {
    expect(await readAtStartup('x', async () => Promise.reject(new KubeError(404, 'gone')), noWait)).toBeNull();
    let calls = 0;
    const value = await readAtStartup(
      'x',
      async () => {
        if (++calls < 3) {
          throw new KubeError(500, 'boom');
        }
        return 'ok';
      },
      { ...noWait, delaysMs: [1, 1, 1] },
    );
    expect(value).toBe('ok');
    expect(calls).toBe(3);
    calls = 0;
    await expect(
      readAtStartup(
        'ConfigMap x',
        async () => {
          calls++;
          throw new KubeError(403, 'forbidden');
        },
        { ...noWait, delaysMs: [1, 1] },
      ),
    ).rejects.toBeInstanceOf(StartupReadError);
    expect(calls).toBe(3);
  });
});

describe('state read at start-up (review: a transient error failed open or lost data)', () => {
  it('settings: a switched-off action stays off across API errors at start-up', async () => {
    vi.useFakeTimers();
    const kube = new HiccupKube(3, { settings: JSON.stringify({ disabledActions: ['restart', 'argocd-sync'] }) });
    const settings = new SettingsService(loadConfig(), kube);
    // Not read yet: every action is off, and nothing is written.
    expect(settings.actionState('restart')).toBe('off');
    expect(settings.actionState('cnpg-backup')).toBe('off');
    await expect(settings.update({ actions: { 'cnpg-backup': false } }, who)).rejects.toBeInstanceOf(NotLoadedError);
    expect(kube.writes).toEqual([]);

    expect((await settle(settings.onModuleInit())).ok).toBe(true);
    expect(settings.actionState('restart')).toBe('off');
    expect(settings.actionState('argocd-sync')).toBe('off');
    expect(settings.actionState('cnpg-backup')).toBe('on');
  });

  it('settings, silences, acceptances, devices, identity: an API that stays down ends the start, nothing is written', async () => {
    vi.useFakeTimers();
    const config = loadConfig();
    const kube = new HiccupKube(Number.MAX_SAFE_INTEGER, {});
    const settings = new SettingsService(config, kube);
    const silences = new SilenceService(config, kube);
    const acceptances = new AcceptanceService(config, kube, settings);
    const devices = new DevicesService(config, kube);
    const identity = new IdentityService(config, kube);
    const inits = [settings, silences, acceptances, devices, identity].map((s) => s.onModuleInit().then(() => null, (err: unknown) => err));
    await vi.runAllTimersAsync();
    for (const err of await Promise.all(inits)) {
      expect(err).toBeInstanceOf(StartupReadError);
    }
    // No throwaway agent key, no empty device list or silences written over the stored ones.
    expect(() => identity.keyPair).toThrow();
    await expect(silences.startMaintenance(2, who)).rejects.toBeInstanceOf(NotLoadedError);
    await expect(devices.add('Phone', generateKeyPair().publicKey)).rejects.toBeInstanceOf(NotLoadedError);
    expect(devices.persistent).toBe(false);
    expect(kube.writes).toEqual([]);
  });

  it('silences and devices: loaded after a hiccup, the next write keeps what was stored', async () => {
    vi.useFakeTimers();
    const phone = generateKeyPair().publicKey;
    const stored = [{ id: 'a', name: 'Phone', publicKey: toBase64Url(phone), createdAt: '2026-01-01T00:00:00.000Z' }];
    const kube = new HiccupKube(2, {
      silenced: JSON.stringify({ 'pods/x': { until: Date.now() + 3_600_000, severity: 'warning' } }),
      devices: Buffer.from(JSON.stringify(stored)).toString('base64'),
    });
    const silences = new SilenceService(loadConfig(), kube);
    expect((await settle(silences.onModuleInit())).ok).toBe(true);
    await silences.silence('pods/y', 1, who);
    const written = JSON.parse((kube.writes.at(-1) as { data: { silenced: string } }).data.silenced) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(['pods/x', 'pods/y']);

    const devices = new DevicesService(loadConfig(), new HiccupKube(2, { devices: Buffer.from(JSON.stringify(stored)).toString('base64') }));
    expect((await settle(devices.onModuleInit())).ok).toBe(true);
    expect(devices.byKey(phone)).toMatchObject({ id: 'a' });
  });

  it('identity: only a missing Secret makes a new key', async () => {
    const kube = new HiccupKube(0, null);
    const identity = new IdentityService(loadConfig(), kube);
    await identity.onModuleInit();
    expect(identity.persistent).toBe(true);
    expect(kube.writes).toHaveLength(1);
  });
});
