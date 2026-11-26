import { provideHttpClient } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Preferences } from '@capacitor/preferences';
import { fingerprint, generateKeyPair, toBase64Url } from '@kubernanny/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ClusterConfig } from '../core/agent.model';
import { AgentClient } from '../core/agent-client.service';
import { ClusterStore } from '../core/cluster-store.service';
import { DeviceKeyVault } from '../core/device-key-vault';
import { PushRegistration } from '../core/push/push-registration.service';
import { StatusStore } from '../core/status-store.service';
import { provideI18nTesting } from '../i18n/provide-i18n';
import { PairPage } from './pair.page';

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

const realKey = generateKeyPair().publicKey;
const attackerKey = generateKeyPair().publicKey;
const REAL = toBase64Url(realKey);
const ATTACKER = toBase64Url(attackerKey);

describe('PairPage', () => {
  let client: {
    identity: ReturnType<typeof vi.fn>;
    pair: ReturnType<typeof vi.fn>;
    revokeDevice: ReturnType<typeof vi.fn>;
  };
  let push: { forget: ReturnType<typeof vi.fn> };
  let vault: FakeVault;
  let navigate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await Preferences.clear();
    vault = new FakeVault();
    client = {
      identity: vi.fn(),
      pair: vi.fn(async (url: string, agentKey: string) => ({
        url,
        agentKey,
        deviceKey: 'new-device-key',
        deviceId: 'dev-new',
        cluster: 'homelab',
      })),
      revokeDevice: vi.fn(async () => undefined),
    };
    push = { forget: vi.fn(async () => undefined) };
    navigate = vi.fn(async () => true);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideI18nTesting('en'),
        { provide: DeviceKeyVault, useValue: vault },
        { provide: AgentClient, useValue: client },
        { provide: PushRegistration, useValue: push },
        {
          provide: StatusStore,
          useValue: { refresh: vi.fn(async () => undefined), forget: vi.fn() },
        },
        { provide: Router, useValue: { navigate, navigateByUrl: navigate } },
      ],
    });
  });

  const open = async (params: Record<string, string>) => {
    const fixture = TestBed.createComponent(PairPage);
    for (const [k, v] of Object.entries(params)) {
      fixture.componentRef.setInput(k, v);
    }
    await fixture.whenStable();
    await TestBed.inject(ClusterStore).loaded;
    await fixture.whenStable();
    return fixture;
  };
  const text = (el: HTMLElement) => el.textContent ?? '';
  const button = (el: HTMLElement, label: string) =>
    [...el.querySelectorAll<HTMLElement>('ion-button')].find((b) => text(b).trim() === label)!;

  it('shows what the link would pair with, the fingerprint included, and connects only on confirmation', async () => {
    const fixture = await open({
      url: 'https://k.example',
      code: 'ABCDE23456',
      name: 'homelab',
      key: REAL,
      relay: 'https://relay.kubernanny.app',
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(text(el)).toContain('Pair with this agent?');
    expect(text(el)).toContain('https://k.example');
    expect(text(el)).toContain('https://relay.kubernanny.app');
    expect(text(el)).toContain(fingerprint(realKey));
    expect(client.pair).not.toHaveBeenCalled();

    await fixture.componentInstance.connect();
    expect(client.pair).toHaveBeenCalledWith(
      'https://k.example',
      REAL,
      'ABCDE23456',
      expect.any(String),
      'https://relay.kubernanny.app',
    );
    expect(TestBed.inject(ClusterStore).clusters()).toHaveLength(1);
  });

  it('refuses a link that would give an existing cluster another agent key, unless replaced explicitly', async () => {
    const store = TestBed.inject(ClusterStore);
    await store.loaded;
    const existing: ClusterConfig = await store.save({
      name: 'homelab',
      url: 'https://k.example',
      agentKey: REAL,
      deviceKey: 'old-device-key',
      deviceId: 'dev-old',
      push: { kid: 'kid', key: 'k', token: 't' },
      relayOff: true,
    });

    const fixture = await open({
      url: 'https://k.example',
      code: 'ABCDE23456',
      key: ATTACKER,
      relay: 'https://evil.example',
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(text(el)).toContain('The agent key changed');
    expect(text(el)).toContain(fingerprint(realKey));
    expect(text(el)).toContain(fingerprint(attackerKey));
    expect(client.pair).not.toHaveBeenCalled();

    // Cancel leaves the cluster exactly as it was.
    button(el, 'Cancel').click();
    expect(navigate).toHaveBeenCalledWith('/clusters', { replaceUrl: true });
    expect(store.find(existing.id)).toEqual(existing);
    expect(vault.keys.get(existing.id)).toBe('old-device-key');

    // The explicit replacement pairs, keeps the entry and its switches, and retires the old device.
    fixture.componentInstance.replace();
    await vi.waitFor(() => expect(store.find(existing.id)?.agentKey).toBe(ATTACKER));
    const replaced = store.find(existing.id)!;
    expect(replaced.push).toBeUndefined();
    expect(replaced.relayOff).toBe(true);
    expect(vault.keys.get(existing.id)).toBe('new-device-key');
    await vi.waitFor(() =>
      expect(client.revokeDevice).toHaveBeenCalledWith(
        expect.objectContaining({ deviceKey: 'old-device-key' }),
        'dev-old',
      ),
    );
    expect(push.forget).toHaveBeenCalledWith(expect.objectContaining({ push: existing.push }));
  });

  it('asks for the key of a foreign address only after the confirmation', async () => {
    client.identity.mockResolvedValue({ publicKey: REAL, fingerprint: fingerprint(realKey) });
    const fixture = await open({ url: 'https://k.example', code: 'ABCDE23456' });
    expect(text(fixture.nativeElement)).toContain('fetched from the address when you continue');
    expect(client.identity).not.toHaveBeenCalled();
    await fixture.componentInstance.connect();
    expect(client.identity).toHaveBeenCalledWith('https://k.example');
    expect(client.pair).toHaveBeenCalled();
  });
});
