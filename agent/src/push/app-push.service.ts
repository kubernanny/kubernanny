import { BadRequestException, ConflictException, NotFoundException } from '../http/errors';
import { Logger } from '../logger';
import { PUSH_PLATFORMS, PushOutcome, PushPlatform, encodePushContent, isPushToken, parsePublicKey, sealPush, toBase64Url } from '@kubernanny/protocol';
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
}

export interface AppPushMessage {
  title: string;
  body: string;
  priority: number;
}

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

  constructor(
    private readonly config: Config,
    private readonly devices: DevicesService,
    private readonly identity: IdentityService,
    private readonly transport: PushTransport,
  ) {}

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
    return { state, relay: state === 'on' && this.transport.available(), registered: state !== 'locked' && who.kind === 'device' && this.devices.hasPush(who.id) };
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
    const { token, platform, key } = (body ?? {}) as { token?: unknown; platform?: unknown; key?: unknown };
    if (!isPushToken(token) || !PUSH_PLATFORMS.includes(platform as PushPlatform) || !validKey(key)) {
      throw new BadRequestException({ code: 'PUSH_INVALID', message: t('error.pushInvalid') });
    }
    if (!(await this.devices.setPush(who.id, { token, platform: platform as PushPlatform, key }))) {
      throw new NotFoundException({ code: 'DEVICE_UNKNOWN', message: t('error.pushDeviceOnly') });
    }
    this.audit.log(`push registered for "${who.name}" (${who.id}), ${platform}`);
  }

  async unregister(who: Principal): Promise<void> {
    this.assertEnabled();
    if (who.kind === 'device' && (await this.devices.clearPush([who.id])) > 0) {
      this.audit.log(`push removed for "${who.name}" (${who.id})`);
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

  private async sendTo(targets: PushTarget[], message: AppPushMessage): Promise<PushOutcome[]> {
    if (targets.length === 0) {
      return [];
    }
    const content = encodePushContent({ t: message.title, b: message.body, p: message.priority, s: Date.now() });
    const outcomes = await Promise.all(
      targets.map(async ({ push }) => {
        try {
          const sealed = sealPush(this.identity.keyPair, parsePublicKey(push.key), content);
          return await this.transport.send({ token: push.token, platform: push.platform, kid: push.kid, message: toBase64Url(sealed), lang: this.config.language });
        } catch {
          return 'failed' as const;
        }
      }),
    );
    const now = Date.now();
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

