import { describe, expect, it } from 'vitest';
import { ClusterConfig } from '../core/agent.model';
import { checkPairing } from './pairing-check';

const KEY_A = 'A'.repeat(43);
const KEY_B = 'B'.repeat(43);
const home: ClusterConfig = { id: 'c1', name: 'homelab', url: 'https://k.example', agentKey: KEY_A, deviceKey: 'd', deviceId: 'x' };
const demo: ClusterConfig = { id: 'demo-broken', name: 'homelab', url: 'demo://broken', agentKey: '', deviceKey: '', deviceId: 'demo', demo: 'broken' };

describe('checkPairing', () => {
  it('adds a cluster nothing in the app looks like', () => {
    expect(checkPairing([home, demo], 'https://other.example', 'office', KEY_B)).toEqual({ kind: 'new' });
  });

  it('refuses by default when the address or the name pins another key', () => {
    expect(checkPairing([home], 'https://k.example/', undefined, KEY_B)).toEqual({ kind: 'keyChanged', existing: home });
    expect(checkPairing([home], 'https://elsewhere.example', 'homelab', KEY_B)).toEqual({ kind: 'keyChanged', existing: home });
  });

  it('knows the same agent again', () => {
    expect(checkPairing([home], 'https://k.example', 'homelab', KEY_A)).toEqual({ kind: 'again', existing: home });
  });

  it('never matches the demo clusters', () => {
    expect(checkPairing([demo], 'demo://broken', 'homelab', KEY_B)).toEqual({ kind: 'new' });
  });
});
