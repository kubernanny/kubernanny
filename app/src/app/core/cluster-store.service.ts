import { Injectable, inject, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { ClusterConfig } from './agent.model';
import { DEMO_LABELS, DEMO_SCENARIOS } from './demo/demo-data';
import { DeviceKeyVault } from './device-key-vault';

const KEY = 'clusters';

/**
 * The agents the app talks to. Name, address and the agent's public key are
 * stored with Capacitor Preferences (UserDefaults / SharedPreferences
 * natively, localStorage on the web); this device's private key for each
 * cluster goes to the Keychain / Keystore through DeviceKeyVault.
 */
@Injectable({ providedIn: 'root' })
export class ClusterStore {
  private readonly vault = inject(DeviceKeyVault);
  private readonly state = signal<ClusterConfig[]>([]);
  readonly clusters = this.state.asReadonly();
  readonly loaded: Promise<void>;

  constructor() {
    this.loaded = this.load();
  }

  find(id: string): ClusterConfig | undefined {
    return this.state().find((c) => c.id === id);
  }

  /**
   * Adds or updates an entry. The keys of an existing entry (the pinned agent
   * key, this device's key in the vault) change only with `replaceKeys`,
   * which only the pairing page passes after the person confirmed: no other
   * path may swap the agent a cluster talks to.
   */
  async save(cluster: Omit<ClusterConfig, 'id'> & { id?: string }, options: { replaceKeys?: boolean } = {}): Promise<ClusterConfig> {
    const saved: ClusterConfig = {
      ...cluster,
      id: cluster.id ?? crypto.randomUUID(),
      url: cluster.url.trim().replace(/\/+$/, ''),
    };
    const before = this.state().find((c) => c.id === saved.id);
    if (before && !options.replaceKeys && (before.agentKey !== saved.agentKey || (before.deviceKey && saved.deviceKey && before.deviceKey !== saved.deviceKey))) {
      throw new Error(`refusing to change the keys of cluster ${saved.id} without confirmation`);
    }
    if (saved.deviceKey) {
      await this.vault.set(saved.id, saved.deviceKey);
    }
    const list = this.state();
    const index = list.findIndex((c) => c.id === saved.id);
    this.state.set(index === -1 ? [...list, saved] : list.map((c) => (c.id === saved.id ? saved : c)));
    await this.persist();
    return saved;
  }

  /** Adds the three demo clusters (red, yellow, green) once; they answer on the device, see DemoAgent. */
  async addDemo(): Promise<void> {
    await this.loaded;
    const missing = DEMO_SCENARIOS.filter((s) => !this.state().some((c) => c.demo === s));
    const demos: ClusterConfig[] = missing.map((scenario) => ({
      id: `demo-${scenario}`,
      name: DEMO_LABELS[scenario].name,
      url: `demo://${scenario}`,
      agentKey: '',
      deviceKey: '',
      deviceId: 'demo',
      demo: scenario,
    }));
    if (demos.length) {
      this.state.set([...this.state(), ...demos]);
      await this.persist();
    }
  }

  async removeDemo(): Promise<void> {
    this.state.set(this.state().filter((c) => !c.demo));
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.state.set(this.state().filter((c) => c.id !== id));
    await this.persist();
    await this.vault.remove(id);
  }

  private async load(): Promise<void> {
    let stored: ClusterConfig[];
    try {
      const { value } = await Preferences.get({ key: KEY });
      stored = value ? (JSON.parse(value) as ClusterConfig[]) : [];
    } catch {
      stored = [];
    }
    // Before the vault existed the private key sat in the list: move it, then rewrite the list without it.
    let moved = false;
    const clusters = await Promise.all(
      stored.map(async (c) => {
        if (c.deviceKey) {
          await this.vault.set(c.id, c.deviceKey);
          moved = true;
          return c;
        }
        return c.demo ? c : { ...c, deviceKey: (await this.vault.get(c.id).catch(() => null)) ?? '' };
      }),
    );
    this.state.set(clusters);
    if (moved) {
      await this.persist();
    }
  }

  /** The list without private keys: those live in the vault only. */
  private persist(): Promise<void> {
    return Preferences.set({ key: KEY, value: JSON.stringify(this.state().map((c) => ({ ...c, deviceKey: '' }))) });
  }
}
