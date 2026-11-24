import 'reflect-metadata';
import { AddressInfo } from 'node:net';
import { FrameType, KeyPair, RegistrationChallenge, decodeFrame, encodeFrame, generateKeyPair } from '@kubernanny/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { IdentityService } from '../auth/identity.service';
import { Config } from '../config';
import { E2eService } from '../e2e/e2e.service';
import { CODE_TTL_MS, FAILURE_WINDOW_MS, MAX_FAILURES_PER_WINDOW, PairingService } from '../pairing/pairing';
import { MAX_IN_FLIGHT, RelayClient } from './relay-client';

/**
 * A relay that registers the agent properly and then attacks it. The agent
 * must not spend more on it than on a direct caller (security review M1).
 */
describe('agent behind a hostile relay', () => {
  let wss: WebSocketServer | null = null;
  let client: RelayClient | null = null;

  afterEach(async () => {
    client?.onModuleDestroy();
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
    wss = null;
    client = null;
  });

  async function until(condition: () => boolean, ms = 5000): Promise<void> {
    const end = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > end) {
        throw new Error('timed out waiting');
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /** Starts the hostile relay and an agent connected to it; resolves with the relay's side of the socket. */
  async function setup(handle: E2eService['handle'] = async () => ({ kind: 'plain', status: 400, code: 'X' })) {
    const keys: KeyPair = generateKeyPair();
    wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as AddressInfo).port;
    const relaySide = new Promise<{ ws: WebSocket; messages: Uint8Array[]; closed: Promise<number> }>((resolve) => {
      wss!.on('connection', (ws) => {
        const challenge = new RegistrationChallenge();
        const messages: Uint8Array[] = [];
        const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
        ws.on('message', (data: Buffer, binary: boolean) => {
          if (!binary) {
            return;
          }
          const bytes = new Uint8Array(data);
          if (decodeFrame(bytes).type === FrameType.Proof) {
            ws.send(encodeFrame(FrameType.Ready, 0, new TextEncoder().encode('{}')));
            resolve({ ws, messages, closed });
          } else {
            messages.push(bytes);
          }
        });
        ws.send(challenge.frame());
      });
    });
    client = new RelayClient({ relayUrl: `ws://127.0.0.1:${port}` } as Config, { keyPair: keys } as IdentityService, { handle } as unknown as E2eService);
    client.onApplicationBootstrap();
    const side = await relaySide;
    await until(() => client!.status()?.connected === true);
    return side;
  }

  it('ignores cancels for calls it is not working on, so they cannot pile up', async () => {
    const { ws } = await setup();
    for (let id = 1; id <= 20_000; id++) {
      ws.send(encodeFrame(FrameType.Cancel, id));
    }
    ws.send('ping');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(client!.stats().cancelled).toBe(0);
    expect(client!.status()?.connected).toBe(true);
  });

  it('honours a cancel for a call in flight and sends no answer for it', async () => {
    let release!: () => void;
    const { ws, messages } = await setup(() => new Promise((resolve) => (release = () => resolve({ kind: 'plain', status: 400, code: 'X' }))));
    ws.send(encodeFrame(FrameType.Call, 7, Uint8Array.of(1)));
    await until(() => client!.stats().inFlight === 1);
    ws.send(encodeFrame(FrameType.Cancel, 7));
    await until(() => client!.stats().cancelled === 1);
    release();
    await until(() => client!.stats().inFlight === 0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(messages).toHaveLength(0);
    expect(client!.stats().cancelled).toBe(0);
  });

  it('answers a second challenge by closing, not by computing', async () => {
    const { ws, closed } = await setup();
    ws.send(new RegistrationChallenge().frame());
    expect(await closed).toBe(4000);
  });

  it('refuses a message larger than one request before buffering it', async () => {
    const { ws, closed } = await setup();
    const big = new Uint8Array(2 * 1024 * 1024);
    big[0] = FrameType.Call;
    ws.send(big);
    expect(await closed).toBe(1009);
  });

  it('caps calls in flight and takes a call id only once', async () => {
    let calls = 0;
    const { ws, messages } = await setup(() => {
      calls++;
      return new Promise(() => undefined); // never answers
    });
    ws.send(encodeFrame(FrameType.Call, 1, Uint8Array.of(1)));
    ws.send(encodeFrame(FrameType.Call, 1, Uint8Array.of(1)));
    for (let id = 2; id <= MAX_IN_FLIGHT + 10; id++) {
      ws.send(encodeFrame(FrameType.Call, id, Uint8Array.of(1)));
    }
    await until(() => messages.length === 10);
    expect(calls).toBe(MAX_IN_FLIGHT);
    expect(messages.map((m) => decodeFrame(m).type).every((t) => t === FrameType.ReplyEnd)).toBe(true);
    expect(new TextDecoder().decode(decodeFrame(messages[0]!).payload.subarray(2))).toContain('E2E_RATE_LIMITED');
  });
});

describe('relayed calls are marked as such', () => {
  it('hands them to E2eService with via = relay, for the audit log', async () => {
    const seen: unknown[][] = [];
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as AddressInfo).port;
    wss.on('connection', (ws) => {
      ws.on('message', (data: Buffer, binary: boolean) => {
        if (binary && decodeFrame(new Uint8Array(data)).type === FrameType.Proof) {
          ws.send(encodeFrame(FrameType.Ready, 0, new TextEncoder().encode('{}')));
          ws.send(encodeFrame(FrameType.Call, 1, Uint8Array.of(1)));
        }
      });
      ws.send(new RegistrationChallenge().frame());
    });
    const handle = async (...args: unknown[]) => {
      seen.push(args);
      return { kind: 'plain' as const, status: 400, code: 'X' };
    };
    const client = new RelayClient({ relayUrl: `ws://127.0.0.1:${port}` } as Config, { keyPair: generateKeyPair() } as IdentityService, { handle } as unknown as E2eService);
    client.onApplicationBootstrap();
    const end = Date.now() + 5000;
    while (seen.length === 0 && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    client.onModuleDestroy();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    expect(seen[0]?.[2]).toBe('relay');
  });
});

describe('reconnect backoff after a silent drop (review)', () => {
  it('starts over after a connection that held, also when the heartbeat found it dead', () => {
    const client = new RelayClient({ relayUrl: 'ws://127.0.0.1:1' } as Config, { keyPair: generateKeyPair() } as IdentityService, {} as E2eService);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = client as any;
    let terminated = false;
    const session = { socket: { terminate: () => (terminated = true), readyState: 1 }, answered: true, readyAt: Date.now() - 120_000, inFlight: new Set(), cancelled: new Set() };
    c.session = session;
    c.attempt = 7;
    c.lastHeard = Date.now() - 120_000;
    c.beat(session);
    expect(terminated).toBe(true);
    // Reset to 0, then counted once for the reconnect it scheduled.
    expect(c.attempt).toBe(1);
    // The late 'close' of the terminated socket changes nothing.
    c.lost(session, 1006, 'late');
    expect(c.attempt).toBe(1);
    client.onModuleDestroy();
  });
});

describe('pairing codes against strangers (review M2, re-review)', () => {
  const pairing = () => new PairingService({ clusterName: 'c' } as Config, {} as IdentityService);

  it('counts a blank code as a wrong attempt and keeps the real code working', () => {
    const p = pairing();
    const code = p.issue(0);
    expect(p.redeem('', 1)).toBe('invalid');
    expect(p.redeem('   ', 2)).toBe('invalid');
    expect(p.redeem(code, 3)).toBe('ok');
  });

  it('throttles wrong guesses, but never burns the code nor blocks the right one', () => {
    const p = pairing();
    const code = p.issue(0);
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW; i++) {
      expect(p.redeem('WRONGCODE0', 10 + i)).toBe('invalid');
    }
    for (let i = 0; i < 100; i++) {
      expect(p.redeem('WRONGCODE0', 100 + i)).toBe('throttled');
    }
    // A stranger hammering wrong codes does not stand between the owner and the pairing.
    expect(p.redeem(code, 300)).toBe('ok');
    expect(p.redeem(code, 301)).not.toBe('ok');
  });

  it('lets wrong attempts count again after the window', () => {
    const p = pairing();
    p.issue(0);
    for (let i = 0; i <= MAX_FAILURES_PER_WINDOW; i++) {
      p.redeem('WRONGCODE0', i);
    }
    expect(p.redeem('WRONGCODE0', 10)).toBe('throttled');
    expect(p.redeem('WRONGCODE0', FAILURE_WINDOW_MS + 100)).toBe('invalid');
  });

  it('ends a code at expiry, whatever was tried', () => {
    const q = pairing();
    const second = q.issue(0);
    expect(q.redeem(second, CODE_TTL_MS + 1)).toBe('invalid');
  });
});
