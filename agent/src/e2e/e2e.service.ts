import { Inject, Injectable, Logger } from '@nestjs/common';
import { MAX_SEALED_REQUEST, OpenedRequest, ProtocolError, openRequest, peekEphemeral, toBase64Url } from '@kubernanny/protocol';
import { DEMO_DEVICE, DevicesService, MAX_DEVICES, Principal } from '../auth/devices.service';
import { IdentityService } from '../auth/identity.service';
import { CONFIG, Config } from '../config';
import { Lang, Text, raw, render, t } from '../i18n/text';
import { Notifier } from '../notify/notifier';
import { PairingService } from '../pairing/pairing';
import { InternalServer } from './internal-server';
import { KeyedBuckets, TokenBucket } from './rate-limit';

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
 * Rate limits, in three layers (docs/PROTOCOL.md, "What the agent checks"):
 *
 * - Opening message 1 (two X25519 operations) for anyone: a generous ceiling
 *   that only protects the CPU the checks need.
 * - Each paired device: a bucket of its own, so nobody else can use it up.
 * - Unknown keys and pairing attempts: one small shared bucket. Strangers
 *   compete only with each other, never with paired devices.
 */
export const OPEN_LIMIT = { capacity: 400, perSecond: 200 };
export const DEVICE_LIMIT = { capacity: 60, perSecond: 20 };
export const STRANGER_LIMIT = { capacity: 20, perSecond: 2 };

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
@Injectable()
export class E2eService {
  private readonly audit = new Logger('audit');
  private readonly logger = new Logger(E2eService.name);
  /** Insertion order is expiry order (fixed TTL). */
  private readonly seen = new Map<string, number>();
  /** Requests dated ahead of the clock: each kept until its own window has passed, so a replay at that time still fails. */
  private readonly future = new Map<string, number>();
  private readonly opens: TokenBucket;
  private readonly perDevice = new KeyedBuckets(DEVICE_LIMIT.capacity, DEVICE_LIMIT.perSecond, 2 * MAX_DEVICES);
  private readonly strangers: TokenBucket;
  /** DEMO mode lets every key in as one demo device; it gets a device's budget, not the strangers' one. */
  private readonly demo: TokenBucket;

  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(DevicesService) private readonly devices: DevicesService,
    @Inject(PairingService) private readonly pairing: PairingService,
    @Inject(InternalServer) private readonly internal: InternalServer,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(Notifier) private readonly notifier: Notifier,
  ) {
    this.opens = new TokenBucket(OPEN_LIMIT.capacity, OPEN_LIMIT.perSecond);
    this.strangers = new TokenBucket(STRANGER_LIMIT.capacity, STRANGER_LIMIT.perSecond);
    this.demo = new TokenBucket(DEVICE_LIMIT.capacity, DEVICE_LIMIT.perSecond);
  }

  /** `via`: 'relay' for calls the relay forwarded (RelayClient); it only shows in the audit log. */
  async handle(body: Uint8Array, now = Date.now(), via: 'direct' | 'relay' = 'direct'): Promise<E2eResult> {
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
    if (!this.opens.take(now)) {
      return plain(429, 'E2E_RATE_LIMITED');
    }

    let opened: OpenedRequest;
    try {
      opened = openRequest(this.identity.keyPair, body);
    } catch (err) {
      return plain(400, err instanceof ProtocolError ? err.code : 'E2E_HANDSHAKE');
    }
    const seal = (status: number, payload: Uint8Array): E2eResult => ({ kind: 'sealed', body: opened.respond(status, payload, Date.now()) });
    // The app's language for every text in the answer; the agent's default when the request names none.
    const lang = opened.request.language ?? this.config.language;
    const device = this.devices.byKey(opened.devicePublicKey);
    const demoPrincipal = !device && this.config.demo ? DEMO_DEVICE : null;
    const principal = device ?? demoPrincipal;
    const pairing = opened.request.method === 'POST' && opened.request.path === '/pair';

    // A paired device spends its own budget; strangers share one.
    const allowed = device ? this.perDevice.take(device.id, now) : (demoPrincipal ? this.demo : this.strangers).take(now);
    if (!allowed) {
      return plain(429, 'E2E_RATE_LIMITED');
    }

    if (!principal && !pairing) {
      // No side effect, so no replay entry: unknown keys cannot fill the cache.
      return this.checkClock(opened, now) ?? seal(401, error('DEVICE_UNKNOWN', t('error.deviceUnknown'), lang));
    }
    // Remembered before the clock check: a request refused as dated too far ahead must not pass once that time comes.
    if (!this.remember(replayKey, opened, now)) {
      return plain(503, 'E2E_BUSY');
    }
    const skew = this.checkClock(opened, now);
    if (skew) {
      return skew;
    }

    if (pairing) {
      return this.pair({ opened, seal, lang, via, demoPrincipal });
    }
    // The channel does not tunnel into itself (Express matches paths case-insensitively and decoded).
    if (tunnelsIntoItself(opened.request.path)) {
      return seal(404, error('NOT_FOUND', t('error.unknownPath'), lang));
    }
    try {
      const response = await this.internal.dispatch(principal!.kind === 'demo' ? 'demo' : principal!.id, opened.request.method, opened.request.path, opened.request.body, lang);
      return seal(response.status, response.body);
    } catch (err) {
      // The device gets a sealed answer it can trust, not a dropped connection.
      this.logger.warn(`internal dispatch failed: ${err instanceof Error ? err.message : err}`);
      return seal(502, error('E2E_INTERNAL', t('error.internal'), lang));
    }
  }

  /** Answered sealed, so the app learns the agent's time authentically and can retry. */
  private checkClock(opened: OpenedRequest, now: number): E2eResult | null {
    if (Math.abs(opened.request.time - now) <= windowFor(opened.request.method)) {
      return null;
    }
    const lang = opened.request.language ?? this.config.language;
    return { kind: 'sealed', body: opened.respond(401, error('E2E_CLOCK_SKEW', t('error.clockSkew'), lang), Date.now()) };
  }

  /** False when the cache is full. */
  private remember(replayKey: string, opened: OpenedRequest, now: number): boolean {
    const until = opened.request.time + windowFor(opened.request.method);
    if (until > now + REPLAY_TTL_MS) {
      if (this.future.size >= FUTURE_CAPACITY) {
        return false;
      }
      this.future.set(replayKey, until);
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
    const redeemed = this.pairing.redeem(code);
    if (redeemed === 'throttled') {
      return seal(429, error('PAIRING_RATE_LIMITED', t('error.pairingRateLimited'), lang));
    }
    if (redeemed !== 'ok') {
      return seal(401, error('PAIRING_CODE_INVALID', t('error.pairingCodeInvalid'), lang));
    }
    try {
      const device = await this.devices.add(name, opened.devicePublicKey);
      this.audit.log(`pairing code redeemed by "${device.name}" (${device.id})${via === 'relay' ? ' through the relay' : ''}`);
      await this.notifier.securityAlert(device.name, [{ kind: 'devicePaired' }]);
      return seal(200, json({ deviceId: device.id, cluster: this.config.clusterName }));
    } catch (err) {
      return seal(503, error('PAIRING_UNAVAILABLE', err instanceof Error ? raw(err.message) : t('error.deviceNotSaved'), lang));
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
    for (const [key, expires] of this.future) {
      if (expires <= now) {
        this.future.delete(key);
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
    // Not decodable: Express would answer 400, never the e2e route.
  }
  return /^\/+e2e(\/|\?|$)/i.test(decoded) || /^\/+e2e(\/|\?|$)/i.test(path);
}
