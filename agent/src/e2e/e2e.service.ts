import {
  MAX_SEALED_REQUEST,
  OpenedRequest,
  openRequest,
  peekEphemeral,
  ProtocolError,
  toBase64Url,
} from '@kubernanny/protocol';

import { DEMO_DEVICE, DevicesService, MAX_DEVICES, Principal } from '../auth/devices.service';
import { IdentityService } from '../auth/identity.service';
import type { Config } from '../config';
import { Lang, raw, render, t, Text } from '../i18n/text';
import { Logger } from '../logger';
import { Notifier } from '../notify/notifier';
import { PairingService } from '../pairing/pairing';
import { DispatchBusyError, InternalServer } from './internal-server';
import { KeyedBuckets, RecentKeys, sourceKey, TokenBucket } from './rate-limit';

/** A GET whose clock is further off than this is refused (the app corrects its clock from the answer and retries). */
export const CLOCK_WINDOW_MS = 5 * 60_000;
/** The same for calls that change something (POST, DELETE): a captured one is worth less the sooner it expires. */
export const WRITE_CLOCK_WINDOW_MS = 60_000;
/** Ephemeral keys are remembered this long: past it, the clock check refuses a replay anyway. */
const REPLAY_TTL_MS = 2 * CLOCK_WINDOW_MS;
const REPLAY_CAPACITY = 20_000;
/** Requests dated further ahead than the replay TTL covers, remembered until their own window has passed. */
const FUTURE_CAPACITY = 1_000;
/**
 * Of those, at most this many per paired device: one device with a broken
 * clock (or a stolen key) cannot fill the map and leave every other
 * fast-clock device with E2E_BUSY instead of the sealed E2E_CLOCK_SKEW.
 */
export const FUTURE_PER_PRINCIPAL = 50;

/**
 * Rate limits (docs/PROTOCOL.md, "What the agent checks"). Opening message 1
 * costs two X25519 operations before anything is known about the caller, so
 * the ceiling on opens is spent by unauthenticated traffic. It is split so
 * that such traffic cannot lock paired devices out:
 *
 * - Direct and relayed calls have separate ceilings: a flood on one path
 *   leaves the other alone. Relayed calls are already limited per agent by
 *   the relay itself (docs/RELAY.md).
 * - Direct calls also have a bucket per source address (IPv6 per /64, at most
 *   SOURCE_KEYS buckets), so one in-cluster caller cannot spend the ceiling.
 * - A share of the direct ceiling (OPEN_RESERVE) is kept for source
 *   addresses that made an authenticated call in the last TRUSTED_SOURCE_MS.
 *   The device key is only known after the handshake, so the address is the
 *   cheapest thing to go by. Behind an ingress every direct call has the
 *   controller's address: the per-address bucket and the reserve then do not
 *   separate callers, and the relay path is the way around a flood.
 * - After the handshake: each paired device has a bucket of its own; unknown
 *   keys and pairing attempts share one small bucket. Strangers compete only
 *   with each other, never with paired devices.
 */
export const OPEN_LIMIT = { capacity: 300, perSecond: 150 };
export const OPEN_RESERVE = { capacity: 100, perSecond: 50 };
const RELAY_OPEN_LIMIT = { capacity: 400, perSecond: 200 };
export const SOURCE_LIMIT = { capacity: 100, perSecond: 50 };
const SOURCE_KEYS = 4096;
const TRUSTED_SOURCE_MS = 10 * 60_000;
export const DEVICE_LIMIT = { capacity: 60, perSecond: 20 };
export const STRANGER_LIMIT = { capacity: 20, perSecond: 2 };
/**
 * The replay cache lives in memory only, so a request captured before a
 * restart would pass again after it. Requests dated before the process
 * started (minus this margin for clock jitter) are refused.
 */
const START_MARGIN_MS = 5_000;

export type E2eResult = { kind: 'sealed'; body: Uint8Array } | { kind: 'plain'; status: number; code: string };

const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const error = (code: string, message: Text, lang: Lang) => json({ code, message: render(message, lang) });
const plain = (status: number, code: string): E2eResult => ({ kind: 'plain', status, code });

/** What `pair` needs of the call it answers. */
interface PairContext {
  opened: OpenedRequest;
  seal: (status: number, payload: Uint8Array) => E2eResult;
  lang: Lang;
  via: 'direct' | 'relay';
  /** Set in DEMO mode only: every unknown key is the demo device there. */
  demoPrincipal: Principal | null;
}

/**
 * POST /api/e2e: one encrypted, authenticated API call (docs/PROTOCOL.md).
 *
 * 1. Size and version byte, then the replay cache on the request's
 *    ephemeral key: free, before any cryptography.
 * 2. The open ceiling, then Noise IK message 1: proves the sender holds the
 *    private key of the device key inside it, and decrypts the request.
 * 3. The caller's own budget: per paired device, shared for strangers.
 * 4. The replay entry, the clock window, then the device list: a known key is
 *    dispatched to the internal API as that device; an unknown key may only pair.
 * 5. The answer goes back in message 2 and transport frames, readable only by
 *    the sender of exactly this request.
 *
 * Before step 2 nothing can be authenticated, so failures there are plain
 * JSON with a code and no detail.
 */
export class E2eService {
  private readonly audit = new Logger('audit');
  private readonly logger = new Logger(E2eService.name);
  /** Insertion order is expiry order (fixed TTL). */
  private readonly seen = new Map<string, number>();
  /**
   * Requests of paired devices dated ahead of the clock: each kept until its
   * own window has passed, so a replay at that time still fails. Never filled
   * by unknown keys (see `handle`).
   */
  private readonly future = new Map<string, { until: number; owner: string }>();
  /** Entries in `future` per principal id. */
  private readonly futurePerOwner = new Map<string, number>();
  private readonly opens: TokenBucket;
  private readonly reserve: TokenBucket;
  private readonly relayOpens: TokenBucket;
  private readonly perSource = new KeyedBuckets(SOURCE_LIMIT.capacity, SOURCE_LIMIT.perSecond, SOURCE_KEYS);
  private readonly trustedSources = new RecentKeys(TRUSTED_SOURCE_MS, 256);
  /** Requests dated earlier were made before this process could remember them. */
  private startedAt = Date.now();
  private readonly perDevice = new KeyedBuckets(DEVICE_LIMIT.capacity, DEVICE_LIMIT.perSecond, 2 * MAX_DEVICES);
  private readonly strangers: TokenBucket;
  /** DEMO mode lets every key in as one demo device; it gets a device's budget, not the strangers' one. */
  private readonly demo: TokenBucket;

  constructor(
    private readonly identity: IdentityService,
    private readonly devices: DevicesService,
    private readonly pairing: PairingService,
    private readonly internal: InternalServer,
    private readonly config: Config,
    private readonly notifier: Notifier,
    /** Pairing writes the device list: only the pod holding the lease does it (lease/leader.ts). */
    private readonly isLeader: () => boolean = () => true,
  ) {
    this.opens = new TokenBucket(OPEN_LIMIT.capacity, OPEN_LIMIT.perSecond);
    this.reserve = new TokenBucket(OPEN_RESERVE.capacity, OPEN_RESERVE.perSecond);
    this.relayOpens = new TokenBucket(RELAY_OPEN_LIMIT.capacity, RELAY_OPEN_LIMIT.perSecond);
    this.strangers = new TokenBucket(STRANGER_LIMIT.capacity, STRANGER_LIMIT.perSecond);
    this.demo = new TokenBucket(DEVICE_LIMIT.capacity, DEVICE_LIMIT.perSecond);
  }

  /**
   * `via`: 'relay' for calls the relay forwarded (RelayClient); they have a
   * ceiling of their own. `source`: the caller's address, for direct calls.
   */
  async handle(
    body: Uint8Array,
    now = Date.now(),
    via: 'direct' | 'relay' = 'direct',
    source?: string,
  ): Promise<E2eResult> {
    if (body.length > MAX_SEALED_REQUEST) {
      return plain(413, 'E2E_TOO_LARGE');
    }
    const ephemeral = peekEphemeral(body);
    if (!ephemeral) {
      return plain(400, 'E2E_VERSION');
    }
    const replayKey = toBase64Url(ephemeral);
    this.prune(now);
    if (this.seen.has(replayKey) || this.future.has(replayKey)) {
      return plain(400, 'E2E_REPLAY');
    }
    // `now` is Date.now() in production; tests that pass an earlier clock move the start with it.
    this.startedAt = Math.min(this.startedAt, now);
    const sourceId = via === 'direct' ? sourceKey(source) : null;
    if (!this.mayOpen(sourceId, now)) {
      return plain(429, 'E2E_RATE_LIMITED');
    }

    let opened: OpenedRequest;
    try {
      opened = openRequest(this.identity.keyPair, body);
    } catch (err) {
      return plain(400, err instanceof ProtocolError ? err.code : 'E2E_HANDSHAKE');
    }
    const seal = (status: number, payload: Uint8Array): E2eResult => ({
      kind: 'sealed',
      body: opened.respond(status, payload, Date.now()),
    });
    // The app's language for every text in the answer; the agent's default when the request names none.
    const lang = opened.request.language ?? this.config.language;
    const device = this.devices.byKey(opened.devicePublicKey);
    const demoPrincipal = !device && this.config.demo ? DEMO_DEVICE : null;
    const principal = device ?? demoPrincipal;
    const pairing = opened.request.method === 'POST' && opened.request.path === '/pair';

    // A paired device spends its own budget; strangers share one.
    const allowed = device
      ? this.perDevice.take(device.id, now)
      : (demoPrincipal ? this.demo : this.strangers).take(now);
    if (!allowed) {
      return plain(429, 'E2E_RATE_LIMITED');
    }

    if (!principal && !pairing) {
      // No side effect, so no replay entry: unknown keys cannot fill the cache.
      return this.checkClock(opened, now) ?? seal(401, error('DEVICE_UNKNOWN', t('error.deviceUnknown'), lang));
    }
    if (!principal) {
      // Pairing from an unknown key: refused outside the clock window before anything is remembered, so strangers never
      // occupy the future map. Letting such a request pass once its time comes is harmless: the code is single-use and
      // pairs the key inside the request, which only its sender holds.
      const strangerSkew = this.checkClock(opened, now);
      if (strangerSkew) {
        return strangerSkew;
      }
    }
    // Remembered before the clock check: a request refused as dated too far ahead must not pass once that time comes.
    if (!this.remember(replayKey, opened, now, principal?.id ?? '')) {
      return plain(503, 'E2E_BUSY');
    }
    const skew = this.checkClock(opened, now) ?? this.checkStart(opened, lang);
    if (skew) {
      return skew;
    }
    if (principal && sourceId) {
      // Authenticated: this address may use the reserved share of the ceiling for a while.
      this.trustedSources.add(sourceId, now);
    }

    if (pairing) {
      return this.pair({ opened, seal, lang, via, demoPrincipal });
    }
    // The channel does not tunnel into itself (Express matches paths case-insensitively and decoded).
    if (tunnelsIntoItself(opened.request.path)) {
      return seal(404, error('NOT_FOUND', t('error.unknownPath'), lang));
    }
    try {
      const response = await this.internal.dispatch(
        principal!.kind === 'demo' ? 'demo' : principal!.id,
        opened.request.method,
        opened.request.path,
        opened.request.body,
        lang,
      );
      return seal(response.status, response.body);
    } catch (err) {
      if (err instanceof DispatchBusyError) {
        return seal(503, error('E2E_BUSY', t('error.internal'), lang));
      }
      // The device gets a sealed answer it can trust, not a dropped connection.
      this.logger.warn(`internal dispatch failed: ${err instanceof Error ? err.message : err}`);
      return seal(502, error('E2E_INTERNAL', t('error.internal'), lang));
    }
  }

  /** The open ceilings: the relay's own, or per source address plus the shared direct one with its reserve. */
  private mayOpen(sourceId: string | null, now: number): boolean {
    if (sourceId === null) {
      return this.relayOpens.take(now);
    }
    if (!this.perSource.take(sourceId, now)) {
      return false;
    }
    return this.opens.take(now) || (this.trustedSources.has(sourceId, now) && this.reserve.take(now));
  }

  /** A request dated before this process started cannot be told from a replay of one seen before the restart. */
  private checkStart(opened: OpenedRequest, lang: Lang): E2eResult | null {
    if (opened.request.time >= this.startedAt - START_MARGIN_MS) {
      return null;
    }
    return {
      kind: 'sealed',
      body: opened.respond(401, error('E2E_CLOCK_SKEW', t('error.clockSkew'), lang), Date.now()),
    };
  }

  /** Answered sealed, so the app learns the agent's time authentically and can retry. */
  private checkClock(opened: OpenedRequest, now: number): E2eResult | null {
    if (Math.abs(opened.request.time - now) <= windowFor(opened.request.method)) {
      return null;
    }
    const lang = opened.request.language ?? this.config.language;
    return {
      kind: 'sealed',
      body: opened.respond(401, error('E2E_CLOCK_SKEW', t('error.clockSkew'), lang), Date.now()),
    };
  }

  /** False when the cache is full, or `owner` already holds its share of the future map. */
  private remember(replayKey: string, opened: OpenedRequest, now: number, owner: string): boolean {
    const until = opened.request.time + windowFor(opened.request.method);
    if (until > now + REPLAY_TTL_MS) {
      const held = this.futurePerOwner.get(owner) ?? 0;
      if (this.future.size >= FUTURE_CAPACITY || held >= FUTURE_PER_PRINCIPAL) {
        return false;
      }
      this.future.set(replayKey, { until, owner });
      this.futurePerOwner.set(owner, held + 1);
      return true;
    }
    if (this.seen.size >= REPLAY_CAPACITY) {
      return false;
    }
    this.seen.set(replayKey, now + REPLAY_TTL_MS);
    return true;
  }

  private async pair({ opened, seal, lang, via, demoPrincipal }: PairContext): Promise<E2eResult> {
    const body = (opened.request.body ?? {}) as { code?: unknown; name?: unknown };
    const code = typeof body.code === 'string' ? body.code.slice(0, 64) : '';
    const name = typeof body.name === 'string' && body.name.trim() ? body.name : render(t('device.defaultName'), lang);
    if (demoPrincipal) {
      return seal(200, json({ deviceId: 'demo', cluster: this.config.clusterName }));
    }
    if (!this.identity.persistent || !this.devices.persistent) {
      return seal(503, error('PAIRING_UNAVAILABLE', t('error.pairingUnavailable'), lang));
    }
    if (!this.isLeader()) {
      return seal(503, error('AGENT_HANDOVER', t('error.agentHandover'), lang));
    }
    const redeemed = this.pairing.redeem(code);
    if (redeemed === 'throttled') {
      return seal(429, error('PAIRING_RATE_LIMITED', t('error.pairingRateLimited'), lang));
    }
    if (redeemed !== 'ok') {
      return seal(401, error('PAIRING_CODE_INVALID', t('error.pairingCodeInvalid'), lang));
    }
    try {
      const device = await this.devices.add(name, opened.devicePublicKey);
      this.audit.log(
        `pairing code redeemed by "${device.name}" (${device.id})${via === 'relay' ? ' through the relay' : ''}`,
      );
      await this.notifier.securityAlert(device.name, [{ kind: 'devicePaired' }]);
      return seal(200, json({ deviceId: device.id, cluster: this.config.clusterName }));
    } catch (err) {
      return seal(
        503,
        error('PAIRING_UNAVAILABLE', err instanceof Error ? raw(err.message) : t('error.deviceNotSaved'), lang),
      );
    }
  }

  private prune(now: number): void {
    for (const [key, expires] of this.seen) {
      if (expires > now) {
        break;
      }
      this.seen.delete(key);
    }
    // Small (FUTURE_CAPACITY), so a full pass is cheap.
    for (const [key, { until, owner }] of this.future) {
      if (until <= now) {
        this.future.delete(key);
        const held = (this.futurePerOwner.get(owner) ?? 1) - 1;
        if (held > 0) {
          this.futurePerOwner.set(owner, held);
        } else {
          this.futurePerOwner.delete(owner);
        }
      }
    }
  }
}

function windowFor(method: string): number {
  return method === 'GET' ? CLOCK_WINDOW_MS : WRITE_CLOCK_WINDOW_MS;
}

/** `/e2e`, `/E2E/x`, `/%65%32%65`: anything that would reach the e2e route again. */
export function tunnelsIntoItself(path: string): boolean {
  let decoded = path;
  try {
    decoded = decodeURIComponent(path.split('?')[0]!);
  } catch {
    // Not decodable: compared as it came.
  }
  return /^\/+e2e(\/|\?|$)/i.test(decoded) || /^\/+e2e(\/|\?|$)/i.test(path);
}
