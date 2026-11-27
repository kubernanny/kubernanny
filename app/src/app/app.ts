import { Component, inject, viewChild } from '@angular/core';
import { Router } from '@angular/router';
import { App as CapApp } from '@capacitor/app';
import { IonApp, IonRouterOutlet, Platform } from '@ionic/angular/standalone';

import { ClusterStore } from './core/cluster-store.service';
import { registerIcons } from './core/icons';
import { pairingRoute } from './core/pairing-link';
import { PushNative } from './core/push/push-native';
import { PushRegistration } from './core/push/push-registration.service';
import { clusterIdForPushKey, knownClusterId } from './core/push/push-tap';
import { ScanPairing } from './core/scan/scan-pairing.service';
import { clusterLinkId, isRefreshLink } from './core/widget/widget-link';
import { WidgetRefresh } from './core/widget/widget-refresh.service';
import { WidgetSync } from './core/widget/widget-sync.service';

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
  private readonly widgetRefresh = inject(WidgetRefresh);
  private readonly outlet = viewChild(IonRouterOutlet);

  constructor() {
    registerIcons();
    // Android's back button. Capacitor hands it to the page (the document's "backbutton" event, which
    // Ionic turns into ionBackButton) only while a listener is registered; without one it only went back
    // in the WebView's history, behind an open sheet or dialog. With it, Ionic closes the topmost
    // overlay first (priority 100: sheets, alerts, action sheets, modals), then goes back a page
    // (priority 0). Last, on the first page, the app goes to the background as Android apps do.
    void CapApp.addListener('backButton', () => undefined).catch(() => undefined);
    inject(Platform).backButton.subscribeWithPriority(-1, () => {
      if (!this.outlet()?.canGoBack()) {
        void CapApp.minimizeApp().catch(() => undefined);
      }
    });
    // Scanning the QR code from the agent's logs opens the app with this link.
    void CapApp.addListener('appUrlOpen', ({ url }) => {
      const params = pairingRoute(url);
      if (params) {
        void this.router.navigate(['/pair'], { queryParams: params });
      }
      // The refresh button on an Android widget: ask the agents, update the widget, back to the home screen.
      if (isRefreshLink(url)) {
        void this.widgetRefresh.run();
        return;
      }
      // A tap on a home-screen widget or an Android push opens that cluster.
      this.openCluster(() => knownClusterId(clusterLinkId(url), this.store.clusters()));
    }).catch(() => undefined);
    // Android may stop the app while Google's scanner is open; the scan then arrives as a restored result.
    void CapApp.addListener('appRestoredResult', (restored) => {
      if (
        restored.pluginId === 'BarcodeScanner' &&
        restored.methodName === 'scan' &&
        restored.success
      ) {
        const text = (restored.data as { barcodes?: { rawValue?: string }[] } | undefined)
          ?.barcodes?.[0]?.rawValue;
        if (text) {
          void this.scanPairing.follow({ kind: 'text', text });
        }
      }
    }).catch(() => undefined);
    // A tap that cold-starts the app may only show up as the launch URL; a second navigation to the same cluster is harmless.
    void CapApp.getLaunchUrl()
      .then((launch) => {
        if (launch && isRefreshLink(launch.url)) {
          void this.widgetRefresh.run();
        } else if (launch) {
          this.openCluster(() => knownClusterId(clusterLinkId(launch.url), this.store.clusters()));
        }
      })
      .catch(() => undefined);
    // A tap on an iOS push names its key id; this device knows which cluster it registered that key for.
    inject(PushNative).onTap((kid) =>
      this.openCluster(() => clusterIdForPushKey(kid, this.store.clusters())),
    );
    // Starts keeping the home-screen widgets in step with every new snapshot.
    inject(WidgetSync);
    // A new FCM token (restored phone, rotated token) reaches every agent this device gets push from,
    // and so does a widget placed or removed while the app was in the background.
    const push = inject(PushRegistration);
    void this.store.loaded.then(() => push.refreshRegistrations()).catch(() => undefined);
    void CapApp.addListener('resume', () => {
      void this.store.loaded.then(() => push.refreshRegistrations()).catch(() => undefined);
    }).catch(() => undefined);
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
