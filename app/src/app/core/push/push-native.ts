import { Injectable } from '@angular/core';
import { Capacitor, PluginListenerHandle, registerPlugin } from '@capacitor/core';

export type PushPlatform = 'ios' | 'android';

/** What this build can do: push needs the iOS or Android app built with the Firebase config files. */
export interface NativePushStatus {
  available: boolean;
  platform: PushPlatform | null;
}

/**
 * The native side (`app/native/push`, Swift and Java; the iOS Notification
 * Service Extension in `ios/App/KubernannyPushExtension`): permission, FCM
 * token, and the push keys it keeps where the code that opens pushes
 * without the app can read them (a shared keychain group on iOS, the
 * Android Keystore on Android).
 */
interface KubernannyPushPlugin {
  isAvailable(): Promise<{ available: boolean; platform: PushPlatform }>;
  requestPermission(): Promise<{ granted: boolean }>;
  getToken(): Promise<{ token: string }>;
  storeKey(options: {
    kid: string;
    secretKey: string;
    publicKey: string;
    agentKey: string;
    clusterId: string;
  }): Promise<void>;
  removeKey(options: { kid: string }): Promise<void>;
  /** The authenticity marker (push-marker.ts), kept next to the push keys and nowhere else. */
  getMarker(): Promise<{ marker: string | null }>;
  setMarker(options: { marker: string }): Promise<void>;
  /** iOS: a tap on a push, with the key id it carried (Android opens kubernanny://cluster?id=… instead). */
  addListener(
    event: 'pushTapped',
    listener: (tap: { kid?: unknown }) => void,
  ): Promise<PluginListenerHandle>;
}

const native = registerPlugin<KubernannyPushPlugin>('KubernannyPush');

/**
 * The app's handle on native push. A class of its own so tests swap in a
 * fake and see exactly what would reach the device.
 */
@Injectable({ providedIn: 'root' })
export class PushNative {
  /** Never throws: on the web, in an older build without the plugin, or without Firebase config, push is simply unavailable. */
  async status(): Promise<NativePushStatus> {
    if (!Capacitor.isNativePlatform()) {
      return { available: false, platform: null };
    }
    try {
      const { available, platform } = await native.isAvailable();
      return { available, platform: available ? platform : null };
    } catch {
      return { available: false, platform: null };
    }
  }

  async requestPermission(): Promise<boolean> {
    return (await native.requestPermission()).granted;
  }

  async token(): Promise<string> {
    return (await native.getToken()).token;
  }

  storeKey(options: {
    kid: string;
    secretKey: string;
    publicKey: string;
    agentKey: string;
    clusterId: string;
  }): Promise<void> {
    return native.storeKey(options);
  }

  async removeKey(kid: string): Promise<void> {
    await native.removeKey({ kid }).catch(() => undefined);
  }

  /** Null when none was chosen yet, and in builds without the plugin. */
  async marker(): Promise<string | null> {
    try {
      return (await native.getMarker()).marker || null;
    } catch {
      return null;
    }
  }

  setMarker(marker: string): Promise<void> {
    return native.setMarker({ marker });
  }

  /** Quiet where there is nothing to listen to (web, a build without the plugin). */
  onTap(listener: (kid: unknown) => void): void {
    if (!Capacitor.isNativePlatform()) {
      return;
    }
    void native.addListener('pushTapped', (tap) => listener(tap?.kid)).catch(() => undefined);
  }
}
