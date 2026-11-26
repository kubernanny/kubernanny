import { generateKeyPair, KeyPair, Method, sealRequest, toBase64Url } from '@kubernanny/protocol';
import { describe, expect, it } from 'vitest';

import { DevicesService, Principal } from '../auth/devices.service';
import { IdentityService } from '../auth/identity.service';
import { Config } from '../config';
import { Notifier } from '../notify/notifier';
import { PairingService } from '../pairing/pairing';
import {
  CLOCK_WINDOW_MS,
  DEVICE_LIMIT,
  E2eResult,
  E2eService,
  FUTURE_PER_PRINCIPAL,
  OPEN_LIMIT,
  OPEN_RESERVE,
  SOURCE_LIMIT,
  STRANGER_LIMIT,
  tunnelsIntoItself,
  WRITE_CLOCK_WINDOW_MS,
} from './e2e.service';
import { DispatchBusyError, InternalServer } from './internal-server';
import { sourceKey } from './rate-limit';

const NOW = 1_800_000_000_000;

function setup(options: { dispatch?: () => Promise<{ status: number; body: Buffer }> } = {}) {
  const agent = generateKeyPair();
  const known = new Map<string, Principal>();
  const devices = {
    persistent: true,
    byKey: (key: Uint8Array) => known.get(toBase64Url(key)) ?? null,
    add: async (name: string, key: Uint8Array) => {
      known.set(toBase64Url(key), { kind: 'device', id: name, name });
      return { id: name, name, createdAt: '', lastSeenAt: null };
    },
  } as unknown as DevicesService;
  const identity = { keyPair: agent, persistent: true } as IdentityService;
  const config = { language: 'en', clusterName: 'home', demo: null } as unknown as Config;
  const internal = {
    dispatch: options.dispatch ?? (async () => ({ status: 200, body: Buffer.from('{"ok":true}') })),
  } as unknown as InternalServer;
  const alerts: unknown[][] = [];
  const notifier = { securityAlert: async (...args: unknown[]) => void alerts.push(args) } as unknown as Notifier;
  const pairing = new PairingService(config, identity);
  const service = new E2eService(identity, devices, pairing, internal, config, notifier);
  const pair = (name: string): KeyPair => {
    const device = generateKeyPair();
    known.set(toBase64Url(device.publicKey), { kind: 'device', id: name, name });
    return device;
  };
  const call = async (device: KeyPair, method: Method, path: string, time = NOW, now = NOW, body?: unknown) => {
    const sealed = sealRequest(device, agent.publicKey, {
      method,
      path,
      time,
      ...(body !== undefined ? { body } : {}),
    });
    const result = await service.handle(sealed.body, now);
    return { result, sealed, ...answer(result, sealed.open) };
  };
  return { service, pair, call, agent, pairing, alerts };
}

function answer(
  result: E2eResult,
  open: (body: Uint8Array) => { status: number; body: Uint8Array },
): { status: number; code?: string } {
  if (result.kind === 'plain') {
    return { status: result.status, code: result.code };
  }
  const inner = open(result.body);
  const text = new TextDecoder().decode(inner.body);
  return {
    status: inner.status,
    code: text.startsWith('{') ? (JSON.parse(text) as { code?: string }).code : undefined,
  };
}

describe('E2eService rate limits (review: one global bucket before auth)', () => {
  it('lets strangers use up only their own shared budget, never a paired device’s', async () => {
    const { call, pair } = setup();
    const phone = pair('phone');
    const codes: (string | undefined)[] = [];
    for (let i = 0; i < STRANGER_LIMIT.capacity + 10; i++) {
      codes.push((await call(generateKeyPair(), 'GET', '/status')).code);
    }
    expect(codes.slice(0, STRANGER_LIMIT.capacity).every((c) => c === 'DEVICE_UNKNOWN')).toBe(true);
    expect(codes.slice(STRANGER_LIMIT.capacity).every((c) => c === 'E2E_RATE_LIMITED')).toBe(true);
    // The paired device is not affected, at the same instant.
    expect((await call(phone, 'GET', '/status')).status).toBe(200);
  });

  it('charges each paired device its own bucket', async () => {
    const { call, pair } = setup();
    const busy = pair('busy');
    const other = pair('other');
    for (let i = 0; i < DEVICE_LIMIT.capacity; i++) {
      expect((await call(busy, 'GET', '/status')).status).toBe(200);
    }
    expect((await call(busy, 'GET', '/status')).code).toBe('E2E_RATE_LIMITED');
    expect((await call(other, 'GET', '/status')).status).toBe(200);
    // Refilled after a second.
    expect((await call(busy, 'GET', '/status', NOW + 1000, NOW + 1000)).status).toBe(200);
  });

  it('spends nothing on bodies that fail the free structural checks', async () => {
    const { service, call, pair } = setup();
    const phone = pair('phone');
    for (let i = 0; i < OPEN_LIMIT.capacity * 3; i++) {
      expect(await service.handle(Uint8Array.of(2, 1, 2), NOW)).toEqual({
        kind: 'plain',
        status: 400,
        code: 'E2E_VERSION',
      });
    }
    expect(await service.handle(new Uint8Array(70_000).fill(1), NOW)).toEqual({
      kind: 'plain',
      status: 413,
      code: 'E2E_TOO_LARGE',
    });
    expect((await call(phone, 'GET', '/status')).status).toBe(200);
  });

  it('keeps a ceiling on handshakes as CPU protection, refilled quickly', async () => {
    const { service, call, pair } = setup();
    const phone = pair('phone');
    const junk = () => {
      const body = new Uint8Array(120);
      body[0] = 1;
      crypto.getRandomValues(body.subarray(1));
      return body;
    };
    // From many addresses, so no per-address bucket stops it first.
    for (let i = 0; i < OPEN_LIMIT.capacity; i++) {
      expect(
        ((await service.handle(junk(), NOW, 'direct', `10.0.${i >> 8}.${i & 255}`)) as { code: string }).code,
      ).toBe('E2E_HANDSHAKE');
    }
    expect(((await service.handle(junk(), NOW, 'direct', '10.9.9.9')) as { code: string }).code).toBe(
      'E2E_RATE_LIMITED',
    );
    expect((await call(phone, 'GET', '/status', NOW + 100, NOW + 100)).status).toBe(200);
  });
});

describe('E2eService open ceilings (security review M6: unauthenticated callers locking out devices)', () => {
  const junk = () => {
    const body = new Uint8Array(120);
    body[0] = 1;
    crypto.getRandomValues(body.subarray(1));
    return body;
  };
  const code = (r: E2eResult) => (r.kind === 'plain' ? r.code : 'sealed');

  it('gives every source address a bucket of its own, so one flooding caller cannot spend the ceiling', async () => {
    const { service, agent, pair } = setup();
    const phone = pair('phone');
    for (let i = 0; i < SOURCE_LIMIT.capacity; i++) {
      await service.handle(junk(), NOW, 'direct', '10.1.1.1');
    }
    expect(code(await service.handle(junk(), NOW, 'direct', '10.1.1.1'))).toBe('E2E_RATE_LIMITED');
    const sealed = sealRequest(phone, agent.publicKey, { method: 'GET', path: '/status', time: NOW });
    expect(code(await service.handle(sealed.body, NOW, 'direct', '10.2.2.2'))).toBe('sealed');
  });

  it('keeps a reserve of the direct ceiling for addresses that recently authenticated', async () => {
    const { service, agent, pair } = setup();
    const phone = pair('phone');
    const seal = () => sealRequest(phone, agent.publicKey, { method: 'GET', path: '/status', time: NOW }).body;
    expect(code(await service.handle(seal(), NOW, 'direct', '192.168.1.20'))).toBe('sealed');
    // A distributed flood spends the general ceiling ...
    for (let i = 0; i < OPEN_LIMIT.capacity; i++) {
      await service.handle(junk(), NOW, 'direct', `10.0.${i >> 8}.${i & 255}`);
    }
    expect(code(await service.handle(junk(), NOW, 'direct', '10.8.8.8'))).toBe('E2E_RATE_LIMITED');
    // ... but the phone's address still gets through, from the reserve.
    for (let i = 0; i < 20; i++) {
      expect(code(await service.handle(seal(), NOW, 'direct', '192.168.1.20'))).toBe('sealed');
    }
    expect(OPEN_RESERVE.capacity).toBeGreaterThanOrEqual(20);
  });

  it('keeps relayed calls on a ceiling of their own', async () => {
    const { service, agent, pair } = setup();
    const phone = pair('phone');
    for (let i = 0; i < OPEN_LIMIT.capacity; i++) {
      await service.handle(junk(), NOW, 'direct', `10.0.${i >> 8}.${i & 255}`);
    }
    const sealed = sealRequest(phone, agent.publicKey, { method: 'GET', path: '/status', time: NOW });
    expect(code(await service.handle(sealed.body, NOW, 'relay'))).toBe('sealed');
  });

  it('buckets IPv6 by /64 and unwraps IPv4-mapped addresses', () => {
    expect(sourceKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(sourceKey('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    // More than eight groups (pentest): one shared bucket, no RangeError.
    expect(sourceKey('1:2:3:4:5:6:7:8:9::1')).toBe('invalid');
    expect(sourceKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(sourceKey('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(sourceKey(undefined)).toBe('unknown');
  });
});

describe('E2eService replay after a restart (security review)', () => {
  it('refuses a request dated before the process started, since the replay cache did not exist then', async () => {
    const { service, agent, pair } = setup();
    const phone = pair('phone');
    const now = Date.now() + 1_000;
    const old = sealRequest(phone, agent.publicKey, { method: 'GET', path: '/status', time: now - 120_000 });
    const result = await service.handle(old.body, now, 'direct', '10.0.0.1');
    expect(answer(result, old.open).code).toBe('E2E_CLOCK_SKEW');
    const fresh = sealRequest(phone, agent.publicKey, { method: 'GET', path: '/status', time: now });
    expect(answer(await service.handle(fresh.body, now, 'direct', '10.0.0.1'), fresh.open).status).toBe(200);
  });
});

describe('E2eService dispatch (security review)', () => {
  it('answers busy, sealed, when too many calls are in flight', async () => {
    const { service, agent, pair } = setup({ dispatch: async () => Promise.reject(new DispatchBusyError()) });
    const phone = pair('phone');
    const sealed = sealRequest(phone, agent.publicKey, { method: 'GET', path: '/status', time: NOW });
    expect(answer(await service.handle(sealed.body, NOW), sealed.open)).toEqual({ status: 503, code: 'E2E_BUSY' });
  });
});

describe('E2eService replay and clock (review)', () => {
  it('remembers a request refused as dated ahead, so it cannot pass once that time comes', async () => {
    const { service, call, pair } = setup();
    const phone = pair('phone');
    const ahead = NOW + CLOCK_WINDOW_MS + 60_000;
    const first = await call(phone, 'GET', '/status', ahead, NOW);
    expect(first.code).toBe('E2E_CLOCK_SKEW');
    // Replayed when its time has come, and later still, past the normal replay TTL.
    expect(await service.handle(first.sealed.body, ahead)).toEqual({ kind: 'plain', status: 400, code: 'E2E_REPLAY' });
    expect(await service.handle(first.sealed.body, ahead + CLOCK_WINDOW_MS - 1)).toEqual({
      kind: 'plain',
      status: 400,
      code: 'E2E_REPLAY',
    });
  });

  it('gives calls that change something a 60 s window, reads 5 minutes', async () => {
    const { call, pair } = setup();
    const phone = pair('phone');
    expect(WRITE_CLOCK_WINDOW_MS).toBe(60_000);
    expect((await call(phone, 'POST', '/status/refresh', NOW - 90_000)).code).toBe('E2E_CLOCK_SKEW');
    expect((await call(phone, 'DELETE', '/devices/x', NOW + 90_000)).code).toBe('E2E_CLOCK_SKEW');
    expect((await call(phone, 'GET', '/status', NOW - 90_000)).status).toBe(200);
    expect((await call(phone, 'POST', '/status/refresh', NOW - 30_000)).status).toBe(200);
  });
});

describe('E2eService dispatch', () => {
  it('answers a failed dispatch sealed with 502 E2E_INTERNAL instead of dropping the answer', async () => {
    const { call, pair } = setup({
      dispatch: async () => {
        throw new Error('socket hang up');
      },
    });
    const res = await call(pair('phone'), 'GET', '/status');
    expect(res.result.kind).toBe('sealed');
    expect(res).toMatchObject({ status: 502, code: 'E2E_INTERNAL' });
  });

  it('never tunnels into itself, whatever the case or encoding', () => {
    for (const path of ['/e2e', '/E2E', '/e2e/', '/E2e?x=1', '/%65%32%65', '//e2e']) {
      expect(tunnelsIntoItself(path), path).toBe(true);
    }
    for (const path of ['/status', '/e2ex', '/events', '/%zz']) {
      expect(tunnelsIntoItself(path), path).toBe(false);
    }
  });
});

describe('E2eService pairing (review)', () => {
  it('pairs with the right code after strangers sent many wrong ones, and announces the new device', async () => {
    const { call, pairing, alerts } = setup();
    const code = pairing.issue(NOW);
    const answers: (string | undefined)[] = [];
    for (let i = 0; i < 10; i++) {
      answers.push((await call(generateKeyPair(), 'POST', '/pair', NOW, NOW, { code: 'WRONGCODE0' })).code);
    }
    expect(answers.slice(0, 5).every((c) => c === 'PAIRING_CODE_INVALID')).toBe(true);
    expect(answers.slice(5).every((c) => c === 'PAIRING_RATE_LIMITED')).toBe(true);
    const owner = generateKeyPair();
    expect((await call(owner, 'POST', '/pair', NOW, NOW, { code, name: 'Nicos iPhone' })).status).toBe(200);
    expect(alerts).toEqual([['Nicos iPhone', [{ kind: 'devicePaired' }]]]);
    expect((await call(owner, 'GET', '/status')).status).toBe(200);
  });
});

describe('E2eService future replay entries (review: strangers could fill them)', () => {
  it('never remembers a pairing attempt from an unknown key dated far ahead; a fast-clock phone still gets E2E_CLOCK_SKEW', async () => {
    const { call, pair } = setup();
    const phone = pair('phone');
    const farAhead = NOW + 365 * 24 * 3_600_000;
    // Spread over time so the strangers' shared bucket refills: far more than FUTURE_CAPACITY attempts.
    for (let i = 0; i < 1_200; i++) {
      const now = NOW + i * 1_000;
      const attempt = await call(generateKeyPair(), 'POST', '/pair', farAhead, now, { code: 'x', name: 'x' });
      expect(attempt.code).toBe('E2E_CLOCK_SKEW');
    }
    const later = NOW + 1_200 * 1_000;
    const fast = await call(phone, 'GET', '/status', later + CLOCK_WINDOW_MS + 60_000, later);
    expect(fast.code).toBe('E2E_CLOCK_SKEW');
  }, 60_000);

  it('caps the entries one paired device holds; another device is not affected', async () => {
    const { call, pair } = setup();
    const broken = pair('broken');
    const other = pair('other');
    const ahead = NOW + 30 * 24 * 3_600_000;
    const codes: (string | undefined)[] = [];
    for (let i = 0; i < FUTURE_PER_PRINCIPAL + 5; i++) {
      // A second apart, so the device's own bucket never runs dry.
      codes.push((await call(broken, 'GET', '/status', ahead, NOW + i * 1_000)).code);
    }
    expect(codes.slice(0, FUTURE_PER_PRINCIPAL).every((c) => c === 'E2E_CLOCK_SKEW')).toBe(true);
    expect(codes.slice(FUTURE_PER_PRINCIPAL).every((c) => c === 'E2E_BUSY')).toBe(true);
    const at = NOW + (FUTURE_PER_PRINCIPAL + 5) * 1_000;
    expect((await call(other, 'GET', '/status', at + CLOCK_WINDOW_MS + 60_000, at)).code).toBe('E2E_CLOCK_SKEW');
  });

  it('still refuses a replayed pairing attempt inside the clock window', async () => {
    const { service, call, pairing } = setup();
    const code = pairing.issue();
    const first = await call(generateKeyPair(), 'POST', '/pair', NOW, NOW, { code, name: 'Phone' });
    expect(first.status).toBe(200);
    expect(await service.handle(first.sealed.body, NOW + 1_000)).toEqual({
      kind: 'plain',
      status: 400,
      code: 'E2E_REPLAY',
    });
  });
});
