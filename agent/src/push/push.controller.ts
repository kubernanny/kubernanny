import { Body, Controller, Delete, Get, HttpCode, Inject, Post } from '@nestjs/common';
import type { PushOutcome } from '@kubernanny/protocol';
import type { Principal } from '../auth/devices.service';
import { CurrentPrincipal } from '../auth/principal.guard';
import { CONFIG, Config } from '../config';
import { render, t } from '../i18n/text';
import { AppPushService, AppPushView } from './app-push.service';

/**
 * Native push for the calling device (docs/API.md). The principal is the
 * device the end-to-end handshake proved; a device registers and removes
 * only itself. With APP_PUSH off every write answers 404 PUSH_OFF before
 * anything is read or stored; GET answers `locked`, so the app can show why.
 */
@Controller('push')
export class PushController {
  constructor(
    @Inject(AppPushService) private readonly push: AppPushService,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  @Get()
  view(@CurrentPrincipal() who: Principal): AppPushView {
    return this.push.view(who);
  }

  /** `{ token, platform: "ios" | "android", key }`: the FCM token and this device's push public key for this cluster. */
  @Post('register')
  @HttpCode(204)
  async register(@CurrentPrincipal() who: Principal, @Body() body: unknown): Promise<void> {
    this.push.assertEnabled();
    await this.push.register(who, body);
  }

  @Delete('register')
  @HttpCode(204)
  async unregister(@CurrentPrincipal() who: Principal): Promise<void> {
    this.push.assertEnabled();
    await this.push.unregister(who);
  }

  /** One test message to this device only. */
  @Post('test')
  @HttpCode(200)
  async test(@CurrentPrincipal() who: Principal): Promise<{ outcome: PushOutcome }> {
    this.push.assertEnabled();
    const lang = this.config.language;
    const message = { title: render(t('push.test.title', { cluster: this.config.clusterName }), lang), body: render(t('push.test.body'), lang), priority: 3 };
    return { outcome: await this.push.test(who, message) };
  }
}
