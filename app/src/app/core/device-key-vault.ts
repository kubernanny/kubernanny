import { Injectable } from '@angular/core';
import { KeychainAccess, SecureStorage } from '@aparajita/capacitor-secure-storage';

/**
 * Where a device's private key per cluster lives: the iOS Keychain and the
 * Android Keystore (encrypted storage), never in plain preferences. Marked
 * "this device only": not synced through iCloud Keychain, not restored onto
 * another phone from a backup, so a copied backup is not a copied device.
 * In the browser it falls back to the origin's storage.
 */
@Injectable({ providedIn: 'root' })
export class DeviceKeyVault {
  private readonly ready = SecureStorage.setKeyPrefix('kubernanny.').catch(() => undefined);

  async get(clusterId: string): Promise<string | null> {
    await this.ready;
    const value = await SecureStorage.get(this.key(clusterId), false, false);
    return typeof value === 'string' ? value : null;
  }

  async set(clusterId: string, privateKey: string): Promise<void> {
    await this.ready;
    await SecureStorage.set(this.key(clusterId), privateKey, false, false, KeychainAccess.whenUnlockedThisDeviceOnly);
  }

  async remove(clusterId: string): Promise<void> {
    await this.ready;
    await SecureStorage.remove(this.key(clusterId), false).catch(() => false);
  }

  private key(clusterId: string): string {
    return `device-key.${clusterId}`;
  }
}
