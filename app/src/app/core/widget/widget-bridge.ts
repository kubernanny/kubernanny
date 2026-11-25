import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { WidgetCluster, validWidgetList } from './widget-summary';

/**
 * The native side (`app/native/widget-bridge`, Swift and Kotlin): keeps the
 * list in shared storage the home-screen widgets read (iOS App Group
 * UserDefaults `group.app.kubernanny`, Android SharedPreferences) and asks the
 * OS to redraw them.
 */
interface WidgetBridgePlugin {
  read(): Promise<{ clusters: WidgetCluster[] }>;
  write(options: { clusters: WidgetCluster[] }): Promise<void>;
}

/** On the web there are no widgets: nothing stored, nothing written. */
const native = registerPlugin<WidgetBridgePlugin>('WidgetBridge', {
  web: {
    read: async () => ({ clusters: [] }),
    write: async () => undefined,
  },
});

/**
 * The app's handle on the widget storage. A class of its own so tests swap
 * in a fake and can see exactly what would reach the device's shared storage.
 */
@Injectable({ providedIn: 'root' })
export class WidgetBridge {
  /** Widgets exist only in the iOS and Android apps; the settings are hidden elsewhere. */
  readonly supported = Capacitor.isNativePlatform();

  /** What the widgets show now; empty when nothing was written yet or it cannot be read. */
  async read(): Promise<WidgetCluster[]> {
    const { clusters } = await native.read();
    return validWidgetList(clusters);
  }

  /** Replaces the whole list: a cluster left out is gone from the device at once. */
  write(clusters: WidgetCluster[]): Promise<void> {
    return native.write({ clusters });
  }
}
