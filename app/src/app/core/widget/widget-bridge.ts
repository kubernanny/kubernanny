import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

import { validWidgetList, WidgetCluster } from './widget-summary';

/**
 * The native side (`app/native/widget-bridge`, Swift and Kotlin): keeps the
 * list in shared storage the home-screen widgets read (iOS App Group
 * UserDefaults `group.app.kubernanny`, Android SharedPreferences) and asks the
 * OS to redraw them.
 */
interface WidgetBridgePlugin {
  read(): Promise<{ clusters: WidgetCluster[] }>;
  write(options: { clusters: WidgetCluster[] }): Promise<void>;
  /** How many widgets of the app are placed on the home screen (and, on iOS, the Lock Screen), of every kind. */
  placed(): Promise<{ count: number }>;
  /** Android only: sends the app to the background, back to the home screen it was opened from. */
  moveToBack(): Promise<{ moved: boolean }>;
}

/** On the web there are no widgets: nothing stored, nothing written. */
const native = registerPlugin<WidgetBridgePlugin>('WidgetBridge', {
  web: {
    read: async () => ({ clusters: [] }),
    write: async () => undefined,
    placed: async () => ({ count: 0 }),
    moveToBack: async () => ({ moved: false }),
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

  /**
   * Whether any widget of the app is placed. Every kind shows every cluster
   * of the list or the worst of them, so one placed widget counts for all
   * clusters in the list. False on the web and in builds before the method.
   */
  async placed(): Promise<boolean> {
    if (!this.supported) {
      return false;
    }
    try {
      return (await native.placed()).count > 0;
    } catch {
      return false;
    }
  }

  /**
   * After a refresh from the widget's button: back to the home screen. Only
   * Android has the button (and the method); elsewhere, and on any failure, the
   * app simply stays open.
   */
  async moveToBack(): Promise<boolean> {
    if (Capacitor.getPlatform() !== 'android') {
      return false;
    }
    try {
      return (await native.moveToBack()).moved;
    } catch {
      return false;
    }
  }

  /** Replaces the whole list: a cluster left out is gone from the device at once. */
  write(clusters: WidgetCluster[]): Promise<void> {
    return native.write({ clusters });
  }
}
