import { HttpClient, HttpHeaders } from '@angular/common/http';
import { inject, Injectable, signal } from '@angular/core';
import {
  fingerprint,
  fromBase64Url,
  generateKeyPair,
  keyPairFromSecret,
  Method,
  parsePublicKey,
  sealRequest,
  toBase64Url,
} from '@kubernanny/protocol';
import { firstValueFrom, timeout } from 'rxjs';

import { DEMO_HOST } from '../../environments/build-flags';
import { LanguageService } from '../i18n/language.service';
import {
  AgentInfo,
  AgentPushView,
  BackupsView,
  ClusterConfig,
  EventView,
  HistoryView,
  IncidentsView,
  IssueActionType,
  Logs,
  NetworkView,
  NodeView,
  SettingsPatch,
  SettingsView,
  Snapshot,
  StorageView,
  SyncOptions,
  WorkloadView,
} from './agent.model';
import { AgentError, InsecureTransportError } from './agent-error';
import { DemoAgent } from './demo/demo-agent';
import {
  AgentPath,
  PathMemory,
  PROBE_TIMEOUT_MS,
  relayCallUrl,
  transportFailure,
  usableRelay,
} from './relay-route';

const TIMEOUT_MS = 20_000;
/** A rolling update of the agent hands over within a few seconds: a write refused meanwhile is sent again this often. */
const HANDOVER_RETRIES = 4;
const HANDOVER_RETRY_MS = 1500;

/** Raised by the demo host build (build-flags.ts) for anything but the built-in demo. */
export class DemoHostError extends Error {
  constructor() {
    super('the demo build talks to no agent');
    this.name = 'DemoHostError';
  }
}

// Re-exported: most callers import the client and its errors from here.
export { AgentError, InsecureTransportError };
export { describeError, isTransient } from './describe-error';

/**
 * Where the app may fetch an agent's key it has not pinned yet (manual pairing
 * without the QR code): https (TLS vouches), this machine (a port-forward), or
 * the origin this web UI came from (the same agent served the code that runs).
 * With a pinned key any transport is fine, plain http in the LAN included:
 * the end-to-end channel does not rely on it.
 */
export function transportAllowed(url: string, origin = globalThis.location?.origin): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || (origin && u.origin === origin)) {
      return true;
    }
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** "iPhone, Safari": a readable name for the device list and the agent's audit log; `fallback` when the OS is unknown. */
export function deviceName(userAgent: string, fallback: string): string {
  const os = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Mac OS X/.test(userAgent)
          ? 'Mac'
          : /Windows/.test(userAgent)
            ? 'Windows'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : fallback;
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /Firefox\//.test(userAgent)
      ? 'Firefox'
      : /Chrome\//.test(userAgent)
        ? 'Chrome'
        : /Safari\//.test(userAgent)
          ? 'Safari'
          : null;
  return browser ? `${os}, ${browser}` : os;
}

export interface DeviceView {
  id: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  current: boolean;
}

/** What a pairing yields: everything ClusterConfig needs besides id and name. */
export interface Pairing {
  url: string;
  agentKey: string;
  deviceKey: string;
  deviceId: string;
  cluster: string;
  /** From the pairing link; the relay is used only with the key from that same link. */
  relayUrl?: string;
}

type Target = Pick<ClusterConfig, 'url' | 'agentKey' | 'deviceKey'> &
  Partial<Pick<ClusterConfig, 'demo' | 'relayUrl' | 'relayOff'>>;

/**
 * The agent's API, end-to-end encrypted: every call is one Noise IK handshake
 * to the agent key pinned at pairing (docs/PROTOCOL.md). TLS, proxies, a
 * relay: whatever sits in between sees ciphertext and can neither read nor
 * change an answer without the call failing.
 */
@Injectable({ providedIn: 'root' })
export class AgentClient {
  private readonly http = inject(HttpClient);
  private readonly demo = inject(DemoAgent);
  private readonly language = inject(LanguageService);
  /** Agent clock minus ours, per agent, learned from authenticated answers. */
  private readonly clockOffset = new Map<string, number>();
  private readonly pathMemory = new PathMemory();
  private readonly pathState = signal<Record<string, AgentPath>>({});
  /** The path that last worked, per agent key: lets the cluster header say "über Relay". */
  readonly paths = this.pathState.asReadonly();

  status(cluster: ClusterConfig, refresh = false): Promise<Snapshot> {
    return refresh
      ? this.call(cluster, 'POST', '/status/refresh')
      : this.call(cluster, 'GET', '/status');
  }

  info(cluster: ClusterConfig): Promise<AgentInfo> {
    return this.call(cluster, 'GET', '/info');
  }

  nodes(cluster: ClusterConfig): Promise<NodeView[]> {
    return this.call(cluster, 'GET', '/nodes');
  }

  workloads(cluster: ClusterConfig): Promise<WorkloadView[]> {
    return this.call(cluster, 'GET', '/workloads');
  }

  storage(cluster: ClusterConfig): Promise<StorageView> {
    return this.call(cluster, 'GET', '/storage');
  }

  network(cluster: ClusterConfig): Promise<NetworkView> {
    return this.call(cluster, 'GET', '/network');
  }

  events(cluster: ClusterConfig): Promise<EventView[]> {
    return this.call(cluster, 'GET', '/events');
  }

  /** The issues of the last `days` days (1 to 7), as the agent followed them. */
  incidents(cluster: ClusterConfig, days = 7): Promise<IncidentsView> {
    return this.call(cluster, 'GET', `/incidents?${new URLSearchParams({ days: String(days) })}`);
  }

  backups(cluster: ClusterConfig): Promise<BackupsView> {
    return this.call(cluster, 'GET', '/backups');
  }

  history(cluster: ClusterConfig, hours: number): Promise<HistoryView> {
    return this.call(cluster, 'GET', `/history?${new URLSearchParams({ hours: String(hours) })}`);
  }

  runAction(
    cluster: ClusterConfig,
    issueId: string,
    type: IssueActionType,
    index: number,
    options?: SyncOptions,
  ): Promise<{ done: string }> {
    return this.call(
      cluster,
      'POST',
      `/actions/${type}?${new URLSearchParams({ issue: issueId, index: String(index) })}`,
      options,
    );
  }

  /** Rolls a manual-sync Argo CD app back to an entry of its history; the agent reads the revision itself. */
  rollbackArgoApp(
    cluster: ClusterConfig,
    namespace: string,
    app: string,
    id: number,
  ): Promise<{ done: string; revision: string }> {
    return this.call(cluster, 'POST', '/argocd/rollback', { namespace, app, id });
  }

  logs(cluster: ClusterConfig, issueId: string, index: number): Promise<Logs> {
    return this.call(
      cluster,
      'GET',
      `/logs?${new URLSearchParams({ issue: issueId, index: String(index) })}`,
    );
  }

  /** Silences an issue for 1, 8, 24 or 168 hours: still shown, but no light, score or notification. */
  silence(
    cluster: ClusterConfig,
    issueId: string,
    hours: number,
  ): Promise<{ silencedUntil: string }> {
    return this.call(
      cluster,
      'POST',
      `/issues/silence?${new URLSearchParams({ issue: issueId, hours: String(hours) })}`,
    );
  }

  unsilence(cluster: ClusterConfig, issueId: string): Promise<void> {
    return this.call(
      cluster,
      'POST',
      `/issues/unsilence?${new URLSearchParams({ issue: issueId })}`,
    );
  }

  /** Marks one advisory on one component as not applicable for 30, 90 or 365 days. */
  acceptAdvisory(
    cluster: ClusterConfig,
    component: string,
    advisory: string,
    days: number,
    reason?: string,
  ): Promise<{ acceptedUntil: string }> {
    return this.call(cluster, 'POST', '/vulnerabilities/accept', {
      component,
      advisory,
      days,
      ...(reason ? { reason } : {}),
    });
  }

  unacceptAdvisory(cluster: ClusterConfig, component: string, advisory: string): Promise<void> {
    return this.call(cluster, 'POST', '/vulnerabilities/unaccept', { component, advisory });
  }

  /** A maintenance window of 1, 2, 4, 8 or 24 hours: checks go on, notifications wait. */
  startMaintenance(cluster: ClusterConfig, hours: number): Promise<{ maintenanceUntil: string }> {
    return this.call(
      cluster,
      'POST',
      `/maintenance?${new URLSearchParams({ hours: String(hours) })}`,
    );
  }

  endMaintenance(cluster: ClusterConfig): Promise<void> {
    return this.call(cluster, 'POST', '/maintenance/end');
  }

  devices(cluster: ClusterConfig): Promise<DeviceView[]> {
    return this.call(cluster, 'GET', '/devices');
  }

  revokeDevice(cluster: ClusterConfig, id: string): Promise<void> {
    return this.call(cluster, 'DELETE', `/devices/${encodeURIComponent(id)}`);
  }

  /** A pairing code for another device. */
  newPairingCode(
    cluster: ClusterConfig,
  ): Promise<{ code: string; app: string; web: string | null }> {
    return this.call(cluster, 'POST', '/pair/code');
  }

  /** What the agent runs: modules, action types, notifications. */
  settings(cluster: ClusterConfig): Promise<SettingsView> {
    return this.call(cluster, 'GET', '/settings');
  }

  changeSettings(cluster: ClusterConfig, patch: SettingsPatch): Promise<SettingsView> {
    return this.call(cluster, 'POST', '/settings', patch);
  }

  testNotification(cluster: ClusterConfig): Promise<{ channels: string[] }> {
    return this.call(cluster, 'POST', '/notify/test');
  }

  /** Native push for this device (docs/NOTIFICATIONS.md, "Native push"). */
  pushState(cluster: ClusterConfig): Promise<AgentPushView> {
    return this.call(cluster, 'GET', '/push');
  }

  /** Registers this device's FCM token and its push public key for this cluster. */
  /** `widget`: this device has a home-screen widget showing the cluster; `deadman`: the dead man's switch grace in minutes, or false. */
  registerPush(
    cluster: ClusterConfig,
    registration: {
      token: string;
      platform: 'ios' | 'android';
      key: string;
      widget: boolean;
      deadman: number | false;
    },
  ): Promise<void> {
    return this.call(cluster, 'POST', '/push/register', registration);
  }

  unregisterPush(cluster: ClusterConfig): Promise<void> {
    return this.call(cluster, 'DELETE', '/push/register');
  }

  testPush(cluster: ClusterConfig): Promise<{ outcome: string }> {
    return this.call(cluster, 'POST', '/push/test');
  }

  /**
   * The agent's public key, for pairing without a key in the link. Only over
   * a transport that vouches for it (see transportAllowed); the result is
   * pinned from then on.
   */
  async identity(url: string): Promise<{ publicKey: string; fingerprint: string }> {
    if (DEMO_HOST) {
      throw new DemoHostError();
    }
    if (!transportAllowed(url)) {
      throw new InsecureTransportError(url);
    }
    const answer = await firstValueFrom(
      this.http.get<{ publicKey: string }>(`${url}/api/identity`).pipe(timeout(TIMEOUT_MS)),
    );
    const key = parsePublicKey(answer.publicKey);
    // Recomputed here: a fingerprint the server sends proves nothing.
    return { publicKey: toBase64Url(key), fingerprint: fingerprint(key) };
  }

  /** Registers a fresh key pair of this device with the agent, using a one-time code. */
  async pair(
    url: string,
    agentKey: string,
    code: string,
    name: string,
    relayUrl?: string,
  ): Promise<Pairing> {
    const device = generateKeyPair();
    const target = {
      url,
      agentKey,
      deviceKey: toBase64Url(device.secretKey),
      ...(relayUrl ? { relayUrl } : {}),
    };
    const { deviceId, cluster } = await this.call<{ deviceId: string; cluster: string }>(
      target,
      'POST',
      '/pair',
      { code, name },
    );
    return { ...target, deviceId, cluster };
  }

  /** One call, retried once when the agent says our clock is off (it tells its own time, authenticated). */
  private async call<T>(target: Target, method: Method, path: string, body?: unknown): Promise<T> {
    if (target.demo) {
      return this.demo.call<T>(target.demo, method, path, body, this.language.lang());
    }
    // The demo host build talks to no agent at all, whatever ended up in its storage.
    if (DEMO_HOST) {
      throw new DemoHostError();
    }
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once<T>(target, method, path, body);
      } catch (err) {
        if (attempt === 0 && err instanceof AgentError && err.code === 'E2E_CLOCK_SKEW') {
          continue;
        }
        // A pod being replaced refused before doing anything: safe to send again, also for actions.
        if (
          attempt < HANDOVER_RETRIES &&
          err instanceof AgentError &&
          err.code === 'AGENT_HANDOVER'
        ) {
          await new Promise((resolve) => setTimeout(resolve, HANDOVER_RETRY_MS));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Direct first, the relay as fallback (decisions/0005-relay-protocol.md).
   * Whether the direct address answers is checked with a quick GET /healthz
   * instead of a short timeout on the call itself: a slow answer is not an
   * unreachable agent, and a call that timed out may still have reached it.
   * So a failed direct call goes to the relay only for GET; an action is
   * never sent twice.
   */
  private once<T>(target: Target, method: Method, path: string, body?: unknown): Promise<T> {
    const relay = usableRelay(target);
    // Not async on this path: the exchange's own promise, with no extra hop, is what callers and tests wait on.
    return relay
      ? this.directOrRelay<T>(target, relay, method, path, body)
      : this.exchange<T>(target, `${target.url}/api/e2e`, method, path, body);
  }

  private async directOrRelay<T>(
    target: Target,
    relay: string,
    method: Method,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const key = target.agentKey;
    const via =
      this.pathMemory.get(key, Date.now()) ?? ((await this.probe(target.url)) ? 'direct' : 'relay');
    if (via === 'direct') {
      try {
        const result = await this.exchange<T>(target, `${target.url}/api/e2e`, method, path, body);
        this.remember(key, 'direct');
        return result;
      } catch (err) {
        if (err instanceof AgentError) {
          this.remember(key, 'direct');
        }
        if (!transportFailure(err) || method !== 'GET') {
          if (!(err instanceof AgentError)) {
            this.forget(key);
          }
          throw err;
        }
      }
    }
    try {
      const result = await this.exchange<T>(
        target,
        relayCallUrl(relay, target.agentKey),
        method,
        path,
        body,
      );
      this.remember(key, 'relay');
      return result;
    } catch (err) {
      if (err instanceof AgentError) {
        this.remember(key, 'relay');
      } else {
        this.forget(key);
      }
      throw err;
    }
  }

  /** True when the agent's own address answers at all, within a few seconds. */
  private async probe(url: string): Promise<boolean> {
    try {
      await firstValueFrom(
        this.http.get(`${url}/healthz`, { responseType: 'text' }).pipe(timeout(PROBE_TIMEOUT_MS)),
      );
      return true;
    } catch {
      return false;
    }
  }

  private remember(key: string, path: AgentPath): void {
    this.pathMemory.set(key, path, Date.now());
    if (this.pathState()[key] !== path) {
      this.pathState.update((paths) => ({ ...paths, [key]: path }));
    }
  }

  private forget(key: string): void {
    this.pathMemory.forget(key);
    if (key in this.pathState()) {
      this.pathState.update(({ [key]: _gone, ...rest }) => rest);
    }
  }

  /** One sealed request to `endpoint` (the agent's /api/e2e or the relay's) and its opened answer. */
  private async exchange<T>(
    target: Target,
    endpoint: string,
    method: Method,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const sealed = sealRequest(
      keyPairFromSecret(fromBase64Url(target.deviceKey)),
      parsePublicKey(target.agentKey),
      {
        method,
        path,
        time: Date.now() + (this.clockOffset.get(target.url) ?? 0),
        ...(body !== undefined ? { body } : {}),
        // The agent writes its texts (issues, summaries, errors) in the UI language.
        language: this.language.lang(),
      },
    );
    const sentAt = Date.now();
    const raw = await firstValueFrom(
      this.http
        .post(endpoint, sealed.body.slice().buffer, {
          responseType: 'arraybuffer',
          headers: new HttpHeaders({ 'content-type': 'application/octet-stream' }),
        })
        .pipe(timeout(TIMEOUT_MS)),
    );
    const answer = sealed.open(new Uint8Array(raw));
    this.clockOffset.set(target.url, answer.time - Math.round((sentAt + Date.now()) / 2));
    const text = new TextDecoder().decode(answer.body);
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (answer.status >= 400) {
      const e = (parsed ?? {}) as { code?: string; message?: string | string[] };
      throw new AgentError(
        answer.status,
        e.code,
        Array.isArray(e.message) ? e.message.join(' ') : e.message,
      );
    }
    return parsed as T;
  }
}
