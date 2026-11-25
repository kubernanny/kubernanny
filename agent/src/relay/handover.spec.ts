import { AddressInfo } from 'node:net';
import { FrameType, RegistrationChallenge, decodeFrame, encodeFrame, generateKeyPair, randomBytes } from '@kubernanny/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { IdentityService } from '../auth/identity.service';
import { Config } from '../config';
import { E2eService } from '../e2e/e2e.service';
import { until } from '../testing/fake-watch-api';
import { RelayClient } from './relay-client';

/**
 * During a rolling update only the pod in charge holds the relay
 * connection: the relay keeps one connection per agent key and closes the
 * older one as "replaced", so two pods would throw each other out in turns.
 */
describe('relay connection across a handover', () => {
  let wss: WebSocketServer | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
    wss = null;
  });

  function relay() {
    wss = new WebSocketServer({ port: 0 });
    const closes: number[] = [];
    let connections = 0;
    wss.on('connection', (ws) => {
      connections++;
      ws.on('message', (data: Buffer, binary: boolean) => {
        if (binary && decodeFrame(new Uint8Array(data)).type === FrameType.Proof) {
          ws.send(encodeFrame(FrameType.Ready, 0, new TextEncoder().encode('{}')));
        }
      });
      ws.on('close', (code) => closes.push(code));
      ws.send(new RegistrationChallenge(randomBytes(32), randomBytes(32)).frame());
    });
    return { url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, closes, connections: () => connections };
  }

  it('closes with 1001 on handOver, stays away, and connects again when in charge again', async () => {
    const r = relay();
    const client = new RelayClient({ relayUrl: r.url } as Config, { keyPair: generateKeyPair() } as IdentityService, { handle: async () => ({ kind: 'plain', status: 400, code: 'X' }) } as unknown as E2eService);
    client.onApplicationBootstrap();
    await until(() => client.status()?.connected === true, 5000);
    client.handOver();
    expect(client.status()?.connected).toBe(false);
    await until(() => r.closes.length === 1, 5000);
    expect(r.closes).toEqual([1001]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(r.connections()).toBe(1);

    client.onApplicationBootstrap();
    await until(() => client.status()?.connected === true, 5000);
    expect(r.connections()).toBe(2);
    client.onModuleDestroy();
  });
});
