import type { PushOutcome } from '@kubernanny/protocol';

import type { Principal } from '../auth/devices.service';
import type { Config } from '../config';
import type { Route } from '../http/server';
import { render, t } from '../i18n/text';
import { AppPushService, AppPushView } from './app-push.service';

/**
 * Native push for the calling device (docs/API.md). The principal is the
 * device the end-to-end handshake proved; a device registers and removes
 * only itself. With APP_PUSH off every write answers 404 PUSH_OFF before
 * anything is read or stored; GET answers `locked`, so the app can show why.
 */
export class PushApi {
  constructor(
    private readonly push: AppPushService,
    private readonly config: Config,
  ) {}

  view(who: Principal): AppPushView {
    return this.push.view(who);
  }

  /** `{ token, platform: "ios" | "android", key }`: the FCM token and this device's push public key for this cluster. */
  async register(who: Principal, body: unknown): Promise<void> {
    this.push.assertEnabled();
    await this.push.register(who, body);
  }

  async unregister(who: Principal): Promise<void> {
    this.push.assertEnabled();
    await this.push.unregister(who);
  }

  /** One test message to this device only. */
  async test(who: Principal): Promise<{ outcome: PushOutcome }> {
    this.push.assertEnabled();
    const lang = this.config.language;
    const message = {
      title: render(t('push.test.title', { cluster: this.config.clusterName }), lang),
      body: render(t('push.test.body'), lang),
      priority: 3,
    };
    return { outcome: await this.push.test(who, message) };
  }
}

export function pushRoutes(c: PushApi): Route[] {
  return [
    { method: 'GET', path: '/api/push', handle: (r) => c.view(r.principal) },
    {
      method: 'POST',
      write: true,
      path: '/api/push/register',
      status: 204,
      handle: (r) => c.register(r.principal, r.body),
    },
    {
      method: 'DELETE',
      write: true,
      path: '/api/push/register',
      status: 204,
      handle: (r) => c.unregister(r.principal),
    },
    { method: 'POST', write: true, path: '/api/push/test', handle: (r) => c.test(r.principal) },
  ];
}
