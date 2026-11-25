import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { Logger } from '../logger';
import QRCode from 'qrcode';
import { IdentityService } from '../auth/identity.service';
import type { Config } from '../config';
import { Text, render, t } from '../i18n/text';
import { relayHttpUrl } from '../relay/relay-url';

/** No 0/O, 1/I/L: the code is also typed by hand. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
export const CODE_TTL_MS = 60 * 60_000;
/**
 * Wrong attempts, direct or through the relay, are counted per window. Past
 * the limit a wrong attempt is answered `throttled` (429) instead of
 * `invalid`, and the agent logs once per window that someone is guessing.
 *
 * The code itself is never burnt by wrong attempts, and the right code is
 * compared before the throttle: a stranger who keeps sending wrong codes can
 * neither invalidate the code nor keep its owner from pairing. What bounds
 * guessing is the code's size (31^10, about 8 * 10^14) against the agent's
 * shared budget for unknown keys (E2eService: about 7200 attempts an hour at
 * most, so under 10^-11 per code), not this counter.
 */
export const MAX_FAILURES_PER_WINDOW = 5;
export const FAILURE_WINDOW_MS = 10 * 60_000;

export type RedeemResult = 'ok' | 'invalid' | 'throttled';

const digest = (s: string) => createHash('sha256').update(s).digest();

export interface PairingLinks {
  /** Opens the native app (custom URL scheme), also from the phone's camera. */
  app: string;
  /** The web UI the agent serves itself; the code travels in the fragment, which never reaches a server log. */
  web: string | null;
  /** How to reach the agent when it has no public URL. */
  portForward: string;
}

/**
 * One-time pairing codes. A code lets one device register its public key,
 * once, for an hour (10 characters of 31 symbols, see MAX_FAILURES_PER_WINDOW
 * for what limits guessing). Pod logs are often shipped to Loki
 * and readable by many: a code there is worth little, it expires and works
 * only once, and the device that used it shows up in every device list.
 *
 * The links also carry the agent's public key (`key=`): the app pins it, so
 * it talks to this agent and nobody in between, whatever the network does.
 */
export class PairingService {
  private readonly logger = new Logger(PairingService.name);
  private current: { hash: Buffer; expires: number } | null = null;
  /** Times of recent wrong attempts, oldest first. */
  private failures: number[] = [];
  private warnedAt = -Infinity;

  constructor(
    private readonly config: Config,
    private readonly identity: IdentityService,
  ) {}

  /** A fresh code; any earlier one stops working. */
  issue(now = Date.now()): string {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += ALPHABET[randomInt(ALPHABET.length)];
    }
    this.current = { hash: digest(code), expires: now + CODE_TTL_MS };
    this.failures = [];
    return code;
  }

  /**
   * `ok` once for the right, unexpired code (which is then used up). A wrong
   * one is `invalid`, or `throttled` past MAX_FAILURES_PER_WINDOW wrong ones
   * in the window. The comparison comes first, so the throttle never stands
   * between the code's owner and the pairing.
   */
  redeem(candidate: string, now = Date.now()): RedeemResult {
    const code = candidate.trim().toUpperCase().replace(/[\s-]/g, '');
    if (this.current && now > this.current.expires) {
      this.current = null;
    }
    if (this.current && this.matches(code)) {
      this.current = null;
      this.failures = [];
      return 'ok';
    }
    // A blank code is an ordinary wrong attempt.
    this.failures = this.failures.filter((at) => now - at < FAILURE_WINDOW_MS);
    this.failures.push(now);
    if (this.failures.length <= MAX_FAILURES_PER_WINDOW) {
      return 'invalid';
    }
    if (now - this.warnedAt >= FAILURE_WINDOW_MS) {
      this.warnedAt = now;
      this.logger.warn(`more than ${MAX_FAILURES_PER_WINDOW} wrong pairing codes in ${FAILURE_WINDOW_MS / 60_000} minutes; someone may be guessing (the code stays valid)`);
    }
    // Bounded: only the window's attempts are kept, and they cost one comparison each.
    this.failures = this.failures.slice(-MAX_FAILURES_PER_WINDOW - 1);
    return 'throttled';
  }

  private matches(code: string): boolean {
    return code.length > 0 && timingSafeEqual(digest(code), this.current!.hash);
  }

  links(code: string): PairingLinks {
    const url = this.config.publicUrl ?? 'http://localhost:8080';
    const key = this.identity.publicKey;
    // The app falls back to the relay when the address is out of reach; it addresses the agent there by its key.
    const relay: Record<string, string> = this.config.relayUrl ? { relay: relayHttpUrl(this.config.relayUrl) } : {};
    const app = `kubernanny://pair?${new URLSearchParams({ url, code, name: this.config.clusterName, key, ...relay })}`;
    const web = this.config.webRoot ? `${url}/#/pair?${new URLSearchParams({ code, name: this.config.clusterName, key, ...relay })}` : null;
    return { app, web, portForward: `kubectl -n ${this.config.namespace} port-forward svc/kubernanny 8080:80` };
  }

  /** The block the agent logs on start: `kubectl logs deploy/kubernanny` is the whole pairing step. */
  async banner(code: string): Promise<string> {
    const links = this.links(code);
    const qr = await QRCode.toString(links.app, { type: 'terminal', small: true, errorCorrectionLevel: 'L' });
    // Pod logs have no reader to ask, so the banner speaks the agent's LANGUAGE.
    const s = (text: Text) => render(text, this.config.language);
    const lines = ['', s(t('banner.ready', { cluster: this.config.clusterName })), '', s(t('banner.scan')), qr, s(t('banner.link', { link: links.app }))];
    if (links.web) {
      lines.push('', s(t('banner.web', { link: links.web })));
    }
    if (!this.config.publicUrl) {
      lines.push('', s(t('banner.noIngress', { command: links.portForward })), s(t('banner.thenLocalhost')));
    }
    lines.push(
      '',
      s(t('banner.code', { code: `${code.slice(0, 5)}-${code.slice(5)}` })),
      s(t('banner.key', { fingerprint: this.identity.fingerprint })),
      s(t('banner.expired', { command: `kubectl -n ${this.config.namespace} exec deploy/kubernanny -- node dist/cli.js pair` })),
      '',
    );
    return lines.join('\n');
  }
}
