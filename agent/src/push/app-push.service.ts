import { BadRequestException, ConflictException, NotFoundException } from '../http/errors';
import { Logger } from '../logger';
import { DEADMAN_GRACE_MINUTES, PUSH_PLATFORMS, PushContent, PushOutcome, PushPlatform, PushStatus, encodePushContent, isPushToken, parsePublicKey, sealPush, statusPushContent, toBase64Url } from '@kubernanny/protocol';
import { DevicesService, Principal, PushTarget, validKey } from '../auth/devices.service';
import { IdentityService } from '../auth/identity.service';
import type { Config } from '../config';
import { t } from '../i18n/text';
import { UnregisteredStrikes } from '../relay/unregistered-strikes';
import { PushTransport } from './push-transport';

/**
 * on: devices may register. locked: APP_PUSH is off in the deployment, the
 * app shows a lock and cannot change it. no-relay: the agent has no relay,
 * the only way a push could leave.
 */
export type AppPushState = 'on' | 'locked' | 'no-relay';

export interface AppPushView {
  state: AppPushState;
  /** The relay is connected and delivers native push right now. */
  relay: boolean;
  /** This device has push registered. */
  registered: boolean;
  /**
   * The dead man's switch (docs/NOTIFICATIONS.md, "When the agent goes
   * silent"). `state` on: available; locked: DEADMAN=off in the deployment;
   * relay: the connected relay does not hold deposits. `grace`: this
   * device's choice in minutes, null when off.
   */
  deadman: { state: 'on' | 'locked' | 'relay'; grace: number | null };
}

export interface AppPushMessage {
  title: string;
  body: string;
  priority: number;
  /** The cluster's state for the phone's widget (push-status.ts); absent where the sender has no snapshot. */
  status?: PushStatus;
}

/** A status push that did not go out is tried again after this long. */
const RETRY_MS = 10 * 60_000;

/**
 * The "app" notification channel (docs/NOTIFICATIONS.md, "Native push"):
 * each registered device gets every message sealed for its own push key
 * (protocol/src/push.ts) and handed to the relay, which passes it to
 * Firebase Cloud Messaging. Neither sees the text.
 *
 * With APP_PUSH off this service refuses every registration before it
 * touches anything, removes registrations stored earlier on start, and
 * never hands anything to the relay (which, in turn, is never attached as a
 * carrier: RelayClient checks the same switch).
 */
export class AppPushService {
  private readonly logger = new Logger('push');
  private readonly audit = new Logger('audit');
  /** The relay's `unregistered` is believed only after repeated strikes (a hostile relay must not wipe registrations). */
  private readonly unregistered = new UnregisteredStrikes();
  /** When a push (of any kind) last reached each device, by device id; in memory, so it starts over with the pod. */
  private readonly lastSent = new Map<string, number>();
  /** Until a full interval has passed since start, a device counts as just pushed to: a restart or a new leader does not send a round at once. */
  private readonly startedAt: number;
  /** After a status push that did not go out: not before this again (ms), so a refusing relay is not asked on every run. */
  private readonly retryAt = new Map<string, number>();
  /** Status pushes by outcome, for the metrics (`kubernanny_widget_pushes_total`). */
  private readonly widgetOutcomes = new Map<PushOutcome, number>();

  constructor(
    private readonly config: Config,
    private readonly devices: DevicesService,
    private readonly identity: IdentityService,
    private readonly transport: PushTransport,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = now();
  }

  /** After every onModuleInit, so the device list is loaded. */
  async onApplicationBootstrap(): Promise<void> {
    if (this.config.appPush) {
      return;
    }
    try {
      const removed = await this.devices.clearPush();
      if (removed > 0) {
        this.logger.log(`APP_PUSH is off: removed the push registration of ${removed} device(s)`);
      }
    } catch (err) {
      this.logger.warn(`APP_PUSH is off, but stored push registrations could not be removed (${err instanceof Error ? err.message : err}); none is used`);
    }
  }

  state(): AppPushState {
    if (!this.config.appPush) {
      return 'locked';
    }
    return this.config.relayUrl ? 'on' : 'no-relay';
  }

  view(who: Principal): AppPushView {
    const state = this.state();
    const relay = state === 'on' && this.transport.available();
    const own = who.kind === 'device' ? this.devices.pushTargets().find((t) => t.deviceId === who.id) : undefined;
    const deadmanState = this.config.deadman === false ? 'locked' : relay && !this.transport.deadmanAvailable() ? 'relay' : 'on';
    return { state, relay, registered: state !== 'locked' && own !== undefined, deadman: { state: deadmanState, grace: own?.push.deadman ?? null } };
  }

  /** The routes call this first: with APP_PUSH off nothing past it runs. */
  assertEnabled(): void {
    if (!this.config.appPush) {
      throw new NotFoundException({ code: 'PUSH_OFF', message: t('error.pushOff') });
    }
  }

  async register(who: Principal, body: unknown): Promise<void> {
    this.assertEnabled();
    if (who.kind !== 'device') {
      throw new BadRequestException({ code: 'PUSH_DEVICE_ONLY', message: t('error.pushDeviceOnly') });
    }
    if (!this.config.relayUrl) {
      throw new ConflictException({ code: 'PUSH_NO_RELAY', message: t('error.pushNoRelay') });
    }
    const { token, platform, key, widget, deadman } = (body ?? {}) as { token?: unknown; platform?: unknown; key?: unknown; widget?: unknown; deadman?: unknown };
    // `widget` and `deadman` are optional (apps before them never send them); anything else of the wrong type is a malformed call.
    const deadmanOk = deadman === undefined || deadman === false || (typeof deadman === 'number' && DEADMAN_GRACE_MINUTES.includes(deadman));
    if (!isPushToken(token) || !PUSH_PLATFORMS.includes(platform as PushPlatform) || !validKey(key) || (widget !== undefined && typeof widget !== 'boolean') || !deadmanOk) {
      throw new BadRequestException({ code: 'PUSH_INVALID', message: t('error.pushInvalid') });
    }
    const grace = typeof deadman === 'number' ? deadman : undefined;
    if (!(await this.devices.setPush(who.id, { token, platform: platform as PushPlatform, key, widget: widget === true, ...(grace ? { deadman: grace } : {}) }))) {
      throw new NotFoundException({ code: 'DEVICE_UNKNOWN', message: t('error.pushDeviceOnly') });
    }
    this.audit.log(`push registered for "${who.name}" (${who.id}), ${platform}${widget === true ? ', with a widget' : ''}${grace ? `, dead man's switch after ${grace} min` : ''}`);
    this.onChange?.();
  }

  /** Called after a registration changed (the dead man's switch deposits again at once). */
  onChange?: () => void;

  async unregister(who: Principal): Promise<void> {
    this.assertEnabled();
    if (who.kind === 'device' && (await this.devices.clearPush([who.id])) > 0) {
      this.audit.log(`push removed for "${who.name}" (${who.id})`);
      this.onChange?.();
    }
  }

  /** Whether anyone could get a push now: on, and at least one device registered. */
  hasTargets(): boolean {
    return this.config.appPush && this.devices.pushTargets().length > 0;
  }

  /**
   * Sends one message to every registered device; true when at least one
   * took it (the notifier then counts the channel as delivered). Tokens FCM
   * no longer knows are forgotten.
   */
  async deliver(message: AppPushMessage): Promise<boolean> {
    const outcomes = await this.sendTo(this.config.appPush ? this.devices.pushTargets() : [], message);
    return outcomes.includes('sent');
  }

  /** One test message to the calling device only (the button next to "Push to this device"). */
  async test(who: Principal, message: AppPushMessage): Promise<PushOutcome> {
    this.assertEnabled();
    const target = this.devices.pushTargets().find((p) => who.kind === 'device' && p.deviceId === who.id);
    if (!target) {
      throw new ConflictException({ code: 'PUSH_NOT_REGISTERED', message: t('error.pushNotRegistered') });
    }
    const [outcome] = await this.sendTo([target], message);
    return outcome!;
  }

  /**
   * The silent status push for home-screen widgets (docs/NOTIFICATIONS.md,
   * "The home-screen widget"): to every device that registered with a widget
   * and got no push of any kind for WIDGET_REFRESH_MINUTES, the cluster's
   * state alone (`p: 0`, no text), marked silent for the relay. Only to a
   * relay that promised to deliver it silently (Ready `statusPush`). The
   * notifier calls it after each run on the pod that holds the lease.
   */
  async refreshWidgets(status: PushStatus): Promise<{ due: number; sent: number }> {
    const minutes = this.config.widgetRefreshMinutes ?? 60;
    if (!this.config.appPush || minutes <= 0 || !this.transport.statusAvailable()) {
      return { due: 0, sent: 0 };
    }
    const now = this.now();
    const interval = minutes * 60_000;
    const due = this.devices
      .pushTargets()
      .filter((target) => target.push.widget === true && now - Math.max(this.startedAt, this.lastSent.get(target.deviceId) ?? 0) >= interval && now >= (this.retryAt.get(target.deviceId) ?? 0));
    if (due.length === 0) {
      return { due: 0, sent: 0 };
    }
    const outcomes = await this.sendTo(due, statusPushContent(status, now), true);
    outcomes.forEach((outcome, i) => {
      this.widgetOutcomes.set(outcome, (this.widgetOutcomes.get(outcome) ?? 0) + 1);
      // Every refused push still costs the agent's allowance at the relay: try again in ten minutes, not every run.
      if (outcome !== 'sent') {
        this.retryAt.set(due[i]!.deviceId, now + RETRY_MS);
      }
    });
    const sent = outcomes.filter((o) => o === 'sent').length;
    this.logger.log(`widget status push: ${sent} of ${due.length} device(s)`);
    return { due: due.length, sent };
  }

  /** One message to the given devices only (the dead man's switch's "reachable again"); the outcomes in their order. */
  async deliverTo(deviceIds: readonly string[], message: AppPushMessage): Promise<PushOutcome[]> {
    return this.sendTo(this.config.appPush ? this.devices.pushTargets().filter((t) => deviceIds.includes(t.deviceId)) : [], message);
  }

  /** Status pushes by outcome since start (metrics). */
  widgetPushCounts(): ReadonlyMap<PushOutcome, number> {
    return this.widgetOutcomes;
  }

  private async sendTo(targets: PushTarget[], message: AppPushMessage | PushContent, silent = false): Promise<PushOutcome[]> {
    if (targets.length === 0) {
      return [];
    }
    const content = encodePushContent('t' in message ? message : { t: message.title, b: message.body, p: message.priority, s: this.now(), ...(message.status ? { w: message.status } : {}) });
    const outcomes = await Promise.all(
      targets.map(async ({ push }) => {
        try {
          const sealed = sealPush(this.identity.keyPair, parsePublicKey(push.key), content);
          return await this.transport.send({ token: push.token, platform: push.platform, kid: push.kid, message: toBase64Url(sealed), lang: this.config.language, ...(silent ? { silent: true } : {}) });
        } catch {
          return 'failed' as const;
        }
      }),
    );
    const now = this.now();
    targets.forEach((target, i) => {
      if (outcomes[i] === 'sent') {
        this.lastSent.set(target.deviceId, now);
      }
    });
    const gone = targets.filter((target, i) => this.unregistered.record(target.push.token, outcomes[i]!, now)).map((target) => target.deviceId);
    if (gone.length > 0) {
      await this.devices.clearPush(gone).catch(() => undefined);
      this.logger.log(`forgot the push token of ${gone.length} device(s): FCM no longer knows it`);
    }
    const failed = outcomes.filter((o) => o !== 'sent');
    if (failed.length > 0) {
      // Outcomes only: never a token or a device's key.
      this.logger.warn(`app push: ${outcomes.length - failed.length} of ${outcomes.length} delivered (${[...new Set(failed)].join(', ')})`);
    }
    return outcomes;
  }
}

