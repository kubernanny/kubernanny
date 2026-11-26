import { randomUUID } from 'node:crypto';

import { parsePublicKey, pushKeyId, PushPlatform, toBase64Url } from '@kubernanny/protocol';

import type { Config } from '../config';
import { KubeClient, KubeError } from '../kube/kube-client';
import { Logger } from '../logger';
import { Serial } from '../util/serial';
import { NotLoadedError, readAtStartup } from '../util/startup-read';

const DEVICES_SECRET = 'kubernanny-devices';
export const MAX_DEVICES = 50;

export interface Device {
  id: string;
  name: string;
  /** The device's static X25519 public key, base64url. Its private key never leaves the device. */
  publicKey: string;
  createdAt: string;
  /** Native push to this device (docs/NOTIFICATIONS.md), set by the device itself. The token is its address at FCM: never logged, never listed. */
  push?: DevicePush;
}

export interface DevicePush {
  /** FCM registration token. */
  token: string;
  platform: PushPlatform;
  /** The device's push public key (base64url), made for this cluster only; pushes are sealed for it. */
  key: string;
  /** pushKeyId(key), sent next to each message so the phone picks the key. */
  kid: string;
  since: string;
  /**
   * The device has a home-screen widget showing this cluster (the app says so
   * at registration and again when it changes): it then gets a silent status
   * push when nothing else reached it for WIDGET_REFRESH_MINUTES. Absent: no
   * widget, no such push.
   */
  widget?: boolean;
  /**
   * The dead man's switch for this device (docs/NOTIFICATIONS.md, "When the
   * agent goes silent"): the grace in minutes (10, 15, 30 or 60) after which
   * the relay sends it a deposited "agent silent" message. Absent: off, and
   * from apps before it, which do not know the message.
   */
  deadman?: number;
}

/** A device to push to: its id and push registration. */
export interface PushTarget {
  deviceId: string;
  push: DevicePush;
}

export interface Principal {
  /** admin: the CLI inside the pod (`kubectl exec`). demo: anyone, in DEMO mode only. */
  kind: 'admin' | 'device' | 'demo';
  id: string;
  name: string;
}

export interface DeviceView {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** Native push is registered for this device; never the token itself. */
  push: boolean;
}

export const ADMIN: Principal = { kind: 'admin', id: 'admin', name: 'Admin (kubectl)' };
export const DEMO_DEVICE: Principal = { kind: 'demo', id: 'demo', name: 'Demo' };

/**
 * The paired devices: one public key each, kept in the Secret
 * `kubernanny-devices`. Nothing in there is secret any more (public keys and
 * names), the Secret only keeps it out of ConfigMap readers. A device is who
 * proves its private key in the handshake; revoking it is deleting its entry.
 */
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);
  private devices: Device[] = [];
  private readonly lastSeen = new Map<string, Date>();
  /** add and revoke rewrite the whole list: one at a time, so neither undoes the other. */
  private readonly writes = new Serial();
  /** True once the stored list was read (or found missing). Pairing and every write wait for it: a write would replace the stored list. */
  private loaded = false;

  constructor(
    private readonly config: Config,
    private readonly kube: KubeClient,
  ) {}

  private get path(): string {
    return `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}/secrets`;
  }

  /** Reads the paired devices, retrying transient errors; throws when they stay unreadable, so the process ends and restarts. */
  async onModuleInit(delaysMs?: readonly number[]): Promise<void> {
    const secret = await readAtStartup(
      `Secret ${DEVICES_SECRET}`,
      () => this.kube.get<{ data?: { devices?: string } }>(`${this.path}/${DEVICES_SECRET}`),
      {
        onRetry: (err, attempt) =>
          this.logger.warn(
            `cannot read Secret ${DEVICES_SECRET} (${err instanceof Error ? err.message : err}), attempt ${attempt}; retrying`,
          ),
        ...(delaysMs ? { delaysMs } : {}),
      },
    );
    let parsed: Device[] = [];
    try {
      parsed = secret
        ? (JSON.parse(Buffer.from(secret.data?.devices ?? '', 'base64').toString('utf8') || '[]') as Device[])
        : [];
    } catch {
      // Not overwritten with an empty list: someone may still repair it by hand.
      throw new Error(`Secret ${DEVICES_SECRET} holds no readable device list; fix or delete its key "devices"`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Secret ${DEVICES_SECRET} holds no readable device list; fix or delete its key "devices"`);
    }
    this.devices = parsed
      .filter((d) => typeof d.id === 'string' && validKey(d.publicKey))
      .map((d) => (d.push && !validPush(d.push) ? withoutPush(d) : d));
    this.loaded = true;
  }
  /**
   * Reads it again once, throwing on any failure but 404 and keeping nothing
   * old: a pod taking over the lease, or answering next to the pod in charge
   * during a rolling update, must not act on state the other pod changed
   * (a revoked device, an action switched off). See agent.ts.
   */
  reload(): Promise<void> {
    return this.onModuleInit([]);
  }

  /** False until the stored list was read: pairing then fails instead of pairing devices over a list it never saw. */
  get persistent(): boolean {
    return this.loaded;
  }

  /** The device holding this key, or null. */
  byKey(publicKey: Uint8Array): Principal | null {
    const key = toBase64Url(publicKey);
    const device = this.devices.find((d) => d.publicKey === key);
    if (!device) {
      return null;
    }
    this.lastSeen.set(device.id, new Date());
    return { kind: 'device', id: device.id, name: device.name };
  }

  byId(id: string): Principal | null {
    const device = this.devices.find((d) => d.id === id);
    return device ? { kind: 'device', id: device.id, name: device.name } : null;
  }

  /** Pairs a key; pairing the same key again keeps its entry and takes the new name. */
  add(name: string, publicKey: Uint8Array): Promise<DeviceView> {
    return this.writes.run(() => this.doAdd(name, publicKey));
  }

  private async doAdd(name: string, publicKey: Uint8Array): Promise<DeviceView> {
    const key = toBase64Url(publicKey);
    const existing = this.devices.find((d) => d.publicKey === key);
    if (!existing && this.devices.length >= MAX_DEVICES) {
      throw new Error(`more than ${MAX_DEVICES} devices; revoke unused ones first`);
    }
    const device: Device = existing
      ? { ...existing, name: cleanName(name) }
      : { id: randomUUID(), name: cleanName(name), publicKey: key, createdAt: new Date().toISOString() };
    await this.save([...this.devices.filter((d) => d.id !== device.id), device]);
    this.logger.log(`device paired: "${device.name}" (${device.id})`);
    return this.view(device);
  }

  revoke(id: string): Promise<boolean> {
    return this.writes.run(() => this.doRevoke(id));
  }

  private async doRevoke(id: string): Promise<boolean> {
    const device = this.devices.find((d) => d.id === id);
    if (!device) {
      return false;
    }
    await this.save(this.devices.filter((d) => d.id !== id));
    this.lastSeen.delete(id);
    this.logger.log(`device revoked: "${device.name}" (${device.id})`);
    return true;
  }

  list(): DeviceView[] {
    return this.devices.map((d) => this.view(d));
  }

  /** Stores (or replaces) a device's push registration. The caller checked the token, the key and APP_PUSH. */
  setPush(id: string, push: Omit<DevicePush, 'kid' | 'since'>): Promise<boolean> {
    return this.writes.run(async () => {
      const device = this.devices.find((d) => d.id === id);
      if (!device) {
        return false;
      }
      const kid = pushKeyId(parsePublicKey(push.key));
      const before = device.push;
      // The app says again when only its widget changed: an unchanged registration is not written again.
      if (
        before &&
        before.token === push.token &&
        before.platform === push.platform &&
        before.key === push.key &&
        (before.widget === true) === (push.widget === true) &&
        before.deadman === push.deadman
      ) {
        return true;
      }
      const { widget, deadman, ...rest } = push;
      const entry: DevicePush = {
        ...rest,
        kid,
        since: new Date().toISOString(),
        ...(widget ? { widget: true } : {}),
        ...(deadman ? { deadman } : {}),
      };
      await this.save(this.devices.map((d) => (d.id === id ? { ...d, push: entry } : d)));
      return true;
    });
  }

  /** Forgets push for the given devices (all of them without ids); a no-op write is skipped. */
  clearPush(ids?: readonly string[]): Promise<number> {
    return this.writes.run(async () => {
      const affected = this.devices.filter((d) => d.push && (!ids || ids.includes(d.id)));
      if (affected.length > 0) {
        await this.save(this.devices.map((d) => (affected.includes(d) ? withoutPush(d) : d)));
      }
      return affected.length;
    });
  }

  pushTargets(): PushTarget[] {
    return this.devices
      .filter((d): d is Device & { push: DevicePush } => d.push !== undefined)
      .map((d) => ({ deviceId: d.id, push: d.push }));
  }

  hasPush(id: string): boolean {
    return this.devices.some((d) => d.id === id && d.push !== undefined);
  }

  private view(d: Device): DeviceView {
    return {
      id: d.id,
      name: d.name,
      createdAt: d.createdAt,
      lastSeenAt: this.lastSeen.get(d.id)?.toISOString() ?? null,
      push: d.push !== undefined,
    };
  }

  private async save(next: Device[]): Promise<void> {
    if (!this.loaded) {
      throw new NotLoadedError(`Secret ${DEVICES_SECRET}`);
    }
    const stringData = { devices: JSON.stringify(next) };
    try {
      await this.kube.mergePatch(`${this.path}/${DEVICES_SECRET}`, { stringData });
    } catch (err) {
      if (!(err instanceof KubeError && err.status === 404)) {
        throw err;
      }
      await this.kube.create(this.path, {
        apiVersion: 'v1',
        kind: 'Secret',
        metadata: { name: DEVICES_SECRET, labels: { 'app.kubernetes.io/name': 'kubernanny' } },
        type: 'Opaque',
        stringData,
      });
    }
    // Only after the write succeeded: a device that is not stored must not work.
    this.devices = next;
  }
}

function withoutPush(device: Device): Device {
  const { push: _gone, ...rest } = device;
  return rest;
}

function validPush(push: DevicePush): boolean {
  return (
    typeof push.token === 'string' &&
    (push.platform === 'ios' || push.platform === 'android') &&
    validKey(push.key) &&
    typeof push.kid === 'string'
  );
}

/** A base64url X25519 public key: device keys and push keys alike. */
export function validKey(key: unknown): key is string {
  try {
    return typeof key === 'string' && parsePublicKey(key).length === 32;
  } catch {
    return false;
  }
}

/**
 * A device name for logs and the device list: printable and short. Control
 * characters (line breaks!) become spaces, so a name can never forge a log line.
 */
function cleanName(name: string): string {
  const cleaned = name
    .replace(/\p{C}/gu, ' ')
    .replace(/[^\p{L}\p{N} .,()_'-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return cleaned || 'Device';
}
