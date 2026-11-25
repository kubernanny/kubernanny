import { RelayClose } from '@kubernanny/protocol';
import { describe, expect, it } from 'vitest';
import { IdentityService } from '../auth/identity.service';
import { loadConfig } from '../config';
import { PairingService } from '../pairing/pairing';
import { RECONNECT_MAX_MS, cleanReason, reconnectDelay } from './relay-client';
import { checkRelayUrl, relayHttpUrl, relaySocketUrl } from './relay-url';

describe('RELAY_URL', () => {
  it('is off unless set', () => {
    expect(checkRelayUrl(undefined)).toBeUndefined();
    expect(checkRelayUrl('')).toBeUndefined();
  });

  it('takes wss anywhere and ws only locally or in the cluster', () => {
    expect(checkRelayUrl('wss://relay.kubernanny.app/')).toBe('wss://relay.kubernanny.app');
    expect(checkRelayUrl('wss://example.com/relay')).toBe('wss://example.com/relay');
    expect(checkRelayUrl('ws://kubernanny-relay.relay.svc:8080')).toBe('ws://kubernanny-relay.relay.svc:8080');
    expect(checkRelayUrl('ws://127.0.0.1:9000')).toBe('ws://127.0.0.1:9000');
    expect(() => checkRelayUrl('ws://relay.example.com')).toThrow(/wss/);
    expect(() => checkRelayUrl('https://relay.example.com')).toThrow(/wss/);
    expect(() => checkRelayUrl('wss://user:pw@relay.example.com')).toThrow(/credentials/);
    expect(() => checkRelayUrl('nope')).toThrow(/not a URL/);
  });

  it('maps to the app-facing https address and the agent socket path', () => {
    expect(relayHttpUrl('wss://relay.kubernanny.app')).toBe('https://relay.kubernanny.app');
    expect(relayHttpUrl('ws://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
    expect(relaySocketUrl('wss://r.example', 'abc')).toBe('wss://r.example/v1/agents/abc/ws');
  });

  it('puts the relay into the pairing links', () => {
    process.env.PUBLIC_URL = 'https://k.example.com';
    process.env.WEB_ROOT = '/app/web';
    process.env.RELAY_URL = 'wss://relay.kubernanny.app';
    const identity = { publicKey: 'A'.repeat(43), fingerprint: 'X' } as IdentityService;
    const links = new PairingService(loadConfig(), identity).links('ABCDE23456');
    expect(new URL(links.app).searchParams.get('relay')).toBe('https://relay.kubernanny.app');
    expect(new URLSearchParams(links.web!.split('?')[1]).get('relay')).toBe('https://relay.kubernanny.app');
    delete process.env.RELAY_URL;
    expect(new PairingService(loadConfig(), identity).links('ABCDE23456').app).not.toContain('relay=');
    delete process.env.PUBLIC_URL;
    delete process.env.WEB_ROOT;
  });
});

describe('reconnectDelay', () => {
  it('grows from about a second to a minute, with jitter', () => {
    expect(reconnectDelay(0, 1006, 0)).toBe(500);
    expect(reconnectDelay(0, 1006, 1)).toBe(1000);
    expect(reconnectDelay(3, 1006, 0.5)).toBe(6000);
    expect(reconnectDelay(50, 1006, 1)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(50, 1006, 0)).toBe(RECONNECT_MAX_MS / 2);
  });

  it('backs off for good when the relay refuses the proof, and long when replaced', () => {
    expect(reconnectDelay(0, RelayClose.ProofFailed, 0)).toBe(RECONNECT_MAX_MS);
    expect(reconnectDelay(0, RelayClose.Replaced, 0)).toBeGreaterThanOrEqual(30_000);
  });
});

describe('close reasons from the relay (review: log forging)', () => {
  it('strips control characters and caps the length', () => {
    expect(cleanReason('replaced\n[Nest] 1  - LOG [auth] admin signed in')).toBe('replaced [Nest] 1 - LOG [auth] admin signed in');
    expect(cleanReason('a\u0000b\u001b[31mc\u202ed')).toBe('a b [31mc d');
    expect(cleanReason('x'.repeat(500))).toHaveLength(100);
  });
});
