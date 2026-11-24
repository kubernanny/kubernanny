import { describe, expect, it } from 'vitest';
import { checkNotifyUrl, parseDemo } from './config';
import { checkRelayUrl } from './relay/relay-url';
import { isInClusterHost } from './security/in-cluster-host';

describe('DEMO is parsed explicitly (review)', () => {
  it.each([undefined, '', '0', 'false', 'off', ' OFF '])('%s is a real cluster', (value) => {
    expect(parseDemo(value)).toBeNull();
  });

  it.each([
    ['broken', 'broken'],
    ['warning', 'warning'],
    ['healthy', 'healthy'],
    ['1', 'broken'],
    ['true', 'broken'],
  ])('%s runs the demo (%s)', (value, scenario) => {
    expect(parseDemo(value)).toBe(scenario);
  });

  it.each(['no', 'yes', 'helthy', '2'])('%s stops the start instead of guessing', (value) => {
    expect(() => parseDemo(value)).toThrow(/DEMO must be/);
  });
});

describe('plain HTTP only to this machine or the cluster, one rule for every URL', () => {
  it('knows in-cluster hosts', () => {
    for (const host of ['ntfy.ntfy.svc', 'relay.kubernanny.svc.cluster.local', 'localhost', '127.0.0.1', '[::1]']) {
      expect(isInClusterHost(host), host).toBe(true);
    }
    for (const host of ['ntfy.sh', 'svc.example.org', 'localhost.example.org', '127.0.0.1.nip.io']) {
      expect(isInClusterHost(host), host).toBe(false);
    }
  });

  it('applies it to notification and relay URLs alike', () => {
    expect(checkNotifyUrl('NTFY_URL', 'http://[::1]:8080/x')).toBe('http://[::1]:8080/x');
    expect(() => checkNotifyUrl('NTFY_URL', 'http://ntfy.sh/x')).toThrow();
    expect(checkRelayUrl('ws://relay.kubernanny.svc:8080')).toBe('ws://relay.kubernanny.svc:8080');
    expect(() => checkRelayUrl('ws://relay.example.org')).toThrow();
  });
});
