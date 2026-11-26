import { DEADMAN_MAX_VALIDITY_MS, DeadmanItem, DepositOutcome, PushStatus, deadmanPushContent, encodePushContent, parsePublicKey, sealPush, toBase64Url } from '@kubernanny/protocol';
import { DevicesService } from '../auth/devices.service';
import { IdentityService } from '../auth/identity.service';
import type { Config } from '../config';
import { render, t } from '../i18n/text';
import { Logger } from '../logger';
import { AppPushService } from './app-push.service';
import { PushTransport, RelayReady } from './push-transport';

/** A deposit is renewed this often, so what the relay holds was sealed at most this long before the agent went silent. */
export const DEADMAN_REFRESH_MS = 30 * 60_000;
/** A deposit the relay refused is tried again after this long. */
const RETRY_MS = 5 * 60_000;
/** How long the relay may keep a deposit (plus a maintenance window it waits out). Renewed every 30 min, so 3 h leaves room for missed renewals. */
export const DEADMAN_VALIDITY_MS = 3 * 3_600_000;

/** What the run loop knows when it ticks the switch. */
export interface DeadmanContext {
  /** Notifications reach phones now: on in the app and not locked in the chart. Off: nothing is deposited (and what was is cleared). */
  armed: boolean;
  /** The end of a maintenance window (ms), if one runs: the relay sends nothing before it. */
  holdUntil: number | null;
  /** The cluster's state, carried by the "reachable again" push for the widget. */
  status?: PushStatus;
}

/**
 * The agent's side of the dead man's switch (docs/NOTIFICATIONS.md, "When
 * the agent goes silent"; docs/RELAY.md, "Dead man's switch").
 *
 * For every device that asked for it, it seals an "agent silent" message
 * ahead of time and deposits the set with the relay over the connection the
 * agent already holds. It renews the deposit every 30 minutes (after a run),
 * at once when a device's registration or the switches change, and on every
 * new relay connection (a new leader after a rollout deposits again). The
 * relay sends a device its message when no connection of this agent comes
 * back within the device's grace. When the agent registers again after that,
 * the relay names the key ids it sent to, and those devices get a normal,
 * sealed "reachable again" push.
 *
 * Only the pod holding the lease has the relay connection, so only it
 * deposits. Never throws.
 */
export class DeadmanService {
  private readonly logger = new Logger('deadman');
  /** Null until the run loop ticked once on this pod: before that nothing is deposited (nor cleared). */
  private context: DeadmanContext | null = null;
  /** The relay connection the agent is on now (RelayReady.connection), and whether it holds deposits. */
  private connection = 0;
  /** What was last deposited, on which connection and when; null: nothing on this connection yet. */
  private last: { fingerprint: string; connection: number; at: number; ok: boolean } | null = null;
  /** Key ids the relay sent to while the agent was away, waiting for their "reachable again" push. */
  private welcomeBack: { kids: string[]; awayMs: number } | null = null;
  private running: Promise<void> | null = null;
  private again = false;

  constructor(
    private readonly config: Config,
    private readonly devices: DevicesService,
    private readonly identity: IdentityService,
    private readonly transport: PushTransport,
    private readonly appPush: AppPushService,
    private readonly now: () => number = () => Date.now(),
  ) {
    transport.onReady((event) => this.ready(event));
    appPush.onChange = () => void this.tick();
  }

  /** After each run on the pod in charge (and whenever a registration changes, with the last context). */
  tick(context: DeadmanContext | null = this.context): Promise<void> {
    this.context = context;
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.run();
        } while (this.again);
      } catch (err) {
        this.logger.warn(`dead man's switch: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  /** A new relay connection: deposit again at once, and say "back" to the devices that heard the agent was silent. */
  private ready(event: RelayReady): void {
    this.connection = event.connection;
    if (event.fired) {
      this.welcomeBack = event.fired;
    }
    void this.tick();
  }

  private async run(): Promise<void> {
    const context = this.context;
    if (!context || !this.transport.deadmanAvailable()) {
      return;
    }
    const now = this.now();
    if (this.welcomeBack && context.armed) {
      await this.sayBack(this.welcomeBack, context);
      this.welcomeBack = null;
    }
    const on = this.config.appPush && this.config.deadman !== false && context.armed;
    const targets = on ? this.devices.pushTargets().filter((target) => target.push.deadman) : [];
    const holdUntil = context.holdUntil && context.holdUntil > now ? context.holdUntil : null;
    const lang = this.config.language;
    const fingerprint = JSON.stringify([lang, this.config.clusterName, holdUntil, targets.map((t) => [t.deviceId, t.push.token, t.push.platform, t.push.kid, t.push.deadman])]);
    const last = this.last?.connection === this.connection ? this.last : null;
    const due = !last || last.fingerprint !== fingerprint || now - last.at >= (last.ok ? DEADMAN_REFRESH_MS : RETRY_MS);
    // Nothing held and nothing to hold: no frame at all, except once per connection (it clears what an earlier pod left).
    if (!due || (targets.length === 0 && last?.fingerprint === fingerprint)) {
      return;
    }
    const holdMs = holdUntil ? Math.min(holdUntil - now, DEADMAN_MAX_VALIDITY_MS - DEADMAN_VALIDITY_MS) : 0;
    const validityMs = DEADMAN_VALIDITY_MS + holdMs;
    const items: DeadmanItem[] = [];
    for (const { push } of targets) {
      const grace = push.deadman!;
      const content = deadmanPushContent(
        render(t('push.deadman.title', { cluster: this.config.clusterName }), lang),
        render(t('push.deadman.body', { minutes: grace }), lang),
        now,
        now + validityMs,
        grace,
      );
      try {
        const sealed = sealPush(this.identity.keyPair, parsePublicKey(push.key), encodePushContent(content));
        items.push({ token: push.token, platform: push.platform, kid: push.kid, message: toBase64Url(sealed), lang, graceMinutes: grace });
      } catch {
        // A key that does not parse: that device gets none (it registered with a broken key).
      }
    }
    const connection = this.connection;
    const outcome: DepositOutcome = await this.transport.deposit({ validitySeconds: Math.floor(validityMs / 1000), holdSeconds: Math.ceil(holdMs / 1000), items });
    this.last = { fingerprint, connection, at: now, ok: outcome === 'stored' };
    if (outcome === 'stored') {
      this.logger.log(items.length > 0 ? `dead man's switch armed for ${items.length} device(s)${holdUntil ? ', waiting out the maintenance window' : ''}` : "dead man's switch cleared");
    } else {
      this.logger.warn(`dead man's switch: the relay did not take the deposit (${outcome}), trying again later`);
    }
  }

  /** The normal, sealed "reachable again" push to the devices the relay told that the agent was silent. */
  private async sayBack(fired: { kids: string[]; awayMs: number }, context: DeadmanContext): Promise<void> {
    const ids = this.devices
      .pushTargets()
      .filter((t) => fired.kids.includes(t.push.kid))
      .map((t) => t.deviceId);
    if (ids.length === 0) {
      return;
    }
    const lang = this.config.language;
    const minutes = Math.max(1, Math.round(fired.awayMs / 60_000));
    const outcomes = await this.appPush.deliverTo(ids, {
      title: render(t('push.deadman.backTitle', { cluster: this.config.clusterName }), lang),
      body: render(t('push.deadman.backBody', { minutes }), lang),
      priority: 2,
      ...(context.status ? { status: context.status } : {}),
    });
    this.logger.log(`back after ${minutes} min: told ${outcomes.filter((o) => o === 'sent').length} of ${ids.length} device(s)`);
  }
}
