import { TestBed } from '@angular/core/testing';
import { Preferences } from '@capacitor/preferences';
import { beforeEach, describe, expect, it } from 'vitest';
import { ClusterStore } from './cluster-store.service';
import { DeviceKeyVault } from './device-key-vault';

/** Stands in for the Keychain / Keystore. */
class FakeVault {
  readonly keys = new Map<string, string>();
  async get(id: string) {
    return this.keys.get(id) ?? null;
  }
  async set(id: string, key: string) {
    this.keys.set(id, key);
  }
  async remove(id: string) {
    this.keys.delete(id);
  }
}

const cluster = { name: 'home', url: 'https://k.example/', agentKey: 'A'.repeat(43), deviceKey: 'secret-key', deviceId: 'd1' };
const storedList = async () => (await Preferences.get({ key: 'clusters' })).value ?? '';

describe('ClusterStore', () => {
  let vault: FakeVault;

  const open = async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [{ provide: DeviceKeyVault, useValue: vault }] });
    const store = TestBed.inject(ClusterStore);
    await store.loaded;
    return store;
  };

  beforeEach(async () => {
    vault = new FakeVault();
    await Preferences.clear();
  });

  it('keeps the private key in the vault, never in the preferences', async () => {
    const saved = await (await open()).save(cluster);
    expect(saved.url).toBe('https://k.example');
    expect(await storedList()).not.toContain('secret-key');
    expect(vault.keys.get(saved.id)).toBe('secret-key');

    const reopened = await open();
    expect(reopened.find(saved.id)?.deviceKey).toBe('secret-key');
    await reopened.remove(saved.id);
    expect(vault.keys.has(saved.id)).toBe(false);
  });

  it('moves a key stored by an older version into the vault', async () => {
    await Preferences.set({ key: 'clusters', value: JSON.stringify([{ ...cluster, id: 'old' }]) });
    const store = await open();
    expect(store.find('old')?.deviceKey).toBe('secret-key');
    expect(vault.keys.get('old')).toBe('secret-key');
    expect(await storedList()).not.toContain('secret-key');
  });

  it('never swaps the keys of an existing cluster without the confirmed pairing flow', async () => {
    const store = await open();
    const saved = await store.save(cluster);
    await expect(store.save({ ...saved, agentKey: 'B'.repeat(43) })).rejects.toThrow(/without confirmation/);
    await expect(store.save({ ...saved, deviceKey: 'attacker-key' })).rejects.toThrow(/without confirmation/);
    expect(vault.keys.get(saved.id)).toBe('secret-key');
    expect(store.find(saved.id)?.agentKey).toBe('A'.repeat(43));
    // Renaming keeps working, and the confirmed replacement goes through.
    await store.save({ ...saved, name: 'lab' });
    await store.save({ ...saved, agentKey: 'B'.repeat(43), deviceKey: 'new-key' }, { replaceKeys: true });
    expect(vault.keys.get(saved.id)).toBe('new-key');
  });
});
