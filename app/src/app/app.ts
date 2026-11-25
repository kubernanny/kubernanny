import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { App as CapApp } from '@capacitor/app';
import { IonApp, IonRouterOutlet } from '@ionic/angular/standalone';
import { registerIcons } from './core/icons';
import { pairingRoute } from './core/pairing-link';
import { ScanPairing } from './core/scan/scan-pairing.service';
import { clusterLinkId } from './core/widget/widget-link';
import { WidgetSync } from './core/widget/widget-sync.service';
import { ClusterStore } from './core/cluster-store.service';
import { PushRegistration } from './core/push/push-registration.service';
import { PushNative } from './core/push/push-native';
import { clusterIdForPushKey, knownClusterId } from './core/push/push-tap';

// Kept importable from here for the specs written against it.
export { pairingRoute } from './core/pairing-link';

@Component({
  selector: 'app-root',
  imports: [IonApp, IonRouterOutlet],
  template: `<ion-app><ion-router-outlet /></ion-app>`,
})
export class App {
  private readonly router = inject(Router);
  private readonly store = inject(ClusterStore);
  private readonly scanPairing = inject(ScanPairing);

  constructor() {
    registerIcons();
    // Scanning the QR code from the agent's logs opens the app with this link.
    void CapApp.addListener('appUrlOpen', ({ url }) => {
      const params = pairingRoute(url);
      if (params) {
        void this.router.navigate(['/pair'], { queryParams: params });
      }
      // A tap on a home-screen widget or an Android push opens that cluster.
      this.openCluster(() => knownClusterId(clusterLinkId(url), this.store.clusters()));
    }).catch(() => undefined);
    // Android may stop the app while Google's scanner is open; the scan then arrives as a restored result.
    void CapApp.addListener('appRestoredResult', (restored) => {
      if (restored.pluginId === 'BarcodeScanner' && restored.methodName === 'scan' && restored.success) {
        const text = (restored.data as { barcodes?: { rawValue?: string }[] } | undefined)?.barcodes?.[0]?.rawValue;
        if (text) {
          void this.scanPairing.follow({ kind: 'text', text });
        }
      }
    }).catch(() => undefined);
    // A tap that cold-starts the app may only show up as the launch URL; a second navigation to the same cluster is harmless.
    void CapApp.getLaunchUrl()
      .then((launch) => {
        if (launch) {
          this.openCluster(() => knownClusterId(clusterLinkId(launch.url), this.store.clusters()));
        }
      })
      .catch(() => undefined);
    // A tap on an iOS push names its key id; this device knows which cluster it registered that key for.
    inject(PushNative).onTap((kid) => this.openCluster(() => clusterIdForPushKey(kid, this.store.clusters())));
    // Starts keeping the home-screen widgets in step with every new snapshot.
    inject(WidgetSync);
    // A new FCM token (restored phone, rotated token) reaches every agent this device gets push from.
    const push = inject(PushRegistration);
    void this.store.loaded.then(() => push.refreshTokens()).catch(() => undefined);
  }

  /** Only once the list is loaded, and only to a cluster in it: the id comes from outside the app. */
  private openCluster(resolve: () => string | null): void {
    void this.store.loaded
      .then(() => {
        const id = resolve();
        if (id) {
          void this.router.navigate(['/c', id]);
        }
      })
      .catch(() => undefined);
  }
}

