import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { App as CapApp } from '@capacitor/app';
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
import { registerIcons } from './core/icons';
import { relayUrlAllowed } from './core/relay-route';

/** "kubernanny://pair?url=…&code=…&key=…[&relay=…]" -> the /pair page's params, or null for anything else. */
export function pairingRoute(link: string): { url: string; code: string; name?: string; key?: string; relay?: string } | null {
  try {
    const u = new URL(link);
    if (u.protocol !== 'kubernanny:' || (u.hostname !== 'pair' && !u.pathname.endsWith('pair'))) {
      return null;
    }
    const url = u.searchParams.get('url');
    const code = u.searchParams.get('code');
    const key = u.searchParams.get('key') ?? undefined;
    if (!url || !code || !/^https?:\/\//.test(url) || (key !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(key))) {
      return null;
    }
    // The relay only counts next to a key: without one the app fetches the key directly, never through a relay.
    const relay = u.searchParams.get('relay');
    const withRelay = key && relay && relayUrlAllowed(relay) ? { relay } : {};
    return { url, code, name: u.searchParams.get('name') ?? undefined, ...(key ? { key } : {}), ...withRelay };
  } catch {
    return null;
  }
}

@Component({
  selector: 'app-root',
  imports: [IonApp, IonRouterOutlet],
  template: `<ion-app><ion-router-outlet /></ion-app>`,
})
export class App {
  private readonly router = inject(Router);

  constructor() {
    registerIcons();
    // Scanning the QR code from the agent's logs opens the app with this link.
    void CapApp.addListener('appUrlOpen', ({ url }) => {
      const params = pairingRoute(url);
      if (params) {
        void this.router.navigate(['/pair'], { queryParams: params });
      }
    }).catch(() => undefined);
  }
}

