import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';

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
  storeKey(options: { kid: string; secretKey: string; publicKey: string; agentKey: string; clusterId: string }): Promise<void>;
  removeKey(options: { kid: string }): Promise<void>;
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

  storeKey(options: { kid: string; secretKey: string; publicKey: string; agentKey: string; clusterId: string }): Promise<void> {
    return native.storeKey(options);
  }

  async removeKey(kid: string): Promise<void> {
    await native.removeKey({ kid }).catch(() => undefined);
  }
}
