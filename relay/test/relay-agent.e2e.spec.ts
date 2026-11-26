import { connect } from 'node:net';

import {
  answerChallenge,
  decodeFrame,
  encodeReply,
  FrameType,
  generateKeyPair,
  parsePublicKey,
  relayAgentId,
  RelayClose,
  sealRequest,
} from '@kubernanny/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { DemoAgent, startDemoAgent } from '../../agent/src/testing/demo-agent';
import { RunningRelay, startRelay } from '../src/bootstrap';

/**
 * The whole path: a real agent in demo mode dials out to a real relay, and a
 * device calls it through the relay with a sealed request, exactly as the
 * app does when the agent's own address is out of reach.
 */
describe('relay and agent end to end', () => {
  let relay: RunningRelay;
  let agent: DemoAgent;
  let base: string;
  let agentId: string;
  const device = generateKeyPair();

  async function until(condition: () => boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > end) {
        throw new Error('timed out waiting');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  function call(body: Uint8Array, id = agentId) {
    return fetch(`${base}/v1/agents/${id}/e2e`, {
      method: 'POST',
      body: Buffer.from(body),
      headers: { 'content-type': 'application/octet-stream', origin: 'capacitor://localhost' },
    });
  }

  async function status() {
    const sealed = sealRequest(device, parsePublicKey(agent.publicKey), {
      method: 'GET',
      path: '/status',
      time: Date.now(),
    });
    const res = await call(sealed.body);
    expect(res.status).toBe(200);
    const answer = sealed.open(new Uint8Array(await res.arrayBuffer()));
    return { status: answer.status, body: JSON.parse(new TextDecoder().decode(answer.body)) };
  }

  beforeAll(async () => {
    process.env.RELAY_REGISTER_TIMEOUT_MS = '500';
    // Small pools so the flood tests stay quick; the address comes from x-forwarded-for, so one test machine can play many clients.
    process.env.RELAY_MAX_PENDING_REGISTRATIONS = '40';
    process.env.TRUST_PROXY = 'x-forwarded-for';
    relay = await startRelay({ port: 0, metricsPort: 0, logger: false });
    base = `http://127.0.0.1:${relay.port}`;
    agent = await startDemoAgent({ RELAY_URL: `ws://127.0.0.1:${relay.port}` });
    agentId = relayAgentId(parsePublicKey(agent.publicKey));
    await until(() => agent.relay.status()?.connected === true);
  });

  afterAll(async () => {
    await agent?.close();
    await relay?.close();
    delete process.env.RELAY_REGISTER_TIMEOUT_MS;
    delete process.env.RELAY_MAX_PENDING_REGISTRATIONS;
    delete process.env.TRUST_PROXY;
  });

  it('carries a sealed call to the agent and its sealed answer back', async () => {
    const answer = await status();
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ cluster: 'homelab-demo', light: expect.any(String) });
  });

  it('passes the agent plain refusals through unchanged (a replay here)', async () => {
    const sealed = sealRequest(device, parsePublicKey(agent.publicKey), {
      method: 'GET',
      path: '/info',
      time: Date.now(),
    });
    expect((await call(sealed.body)).status).toBe(200);
    const replay = await call(sealed.body);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ code: 'E2E_REPLAY' });
  });

  it('answers for itself when the agent is unknown, the body too large or malformed, with CORS', async () => {
    const other = relayAgentId(generateKeyPair().publicKey);
    const offline = await call(Uint8Array.of(1, 2, 3), other);
    expect(offline.status).toBe(503);
    expect(offline.headers.get('access-control-allow-origin')).toBe('*');
    expect(await offline.json()).toEqual({ code: 'RELAY_AGENT_OFFLINE' });
    const large = await call(new Uint8Array(70_000));
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ code: 'RELAY_TOO_LARGE' });
    expect((await call(new Uint8Array(0))).status).toBe(400);
    expect((await fetch(`${base}/v1/agents/nope/e2e`, { method: 'POST', body: 'x' })).status).toBe(404);
    const preflight = await fetch(`${base}/v1/agents/${agentId}/e2e`, {
      method: 'OPTIONS',
      headers: { origin: 'https://k.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-headers')).toBe('content-type');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });

  it('does not let anyone else take the agent id', async () => {
    const squatter = generateKeyPair();
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/agents/${agentId}/ws`);
    const code = await new Promise<number>((resolve) => {
      ws.on('message', (data: Buffer) => {
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.type === FrameType.Challenge) {
          ws.send(answerChallenge(squatter, frame.payload, `ws://127.0.0.1:${relay.port}`));
        }
      });
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(RelayClose.ProofFailed);
    expect((await status()).status).toBe(200);
  });

  it('closes a connection that never proves anything', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/agents/${relayAgentId(generateKeyPair().publicKey)}/ws`);
    expect(await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)))).toBe(
      RelayClose.RegistrationTimeout,
    );
  });

  it('answers the heartbeat', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/agents/${relayAgentId(generateKeyPair().publicKey)}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send('ping');
    const pong = await new Promise<string>((resolve) =>
      ws.on('message', (data: Buffer, binary: boolean) => !binary && resolve(data.toString())),
    );
    expect(pong).toBe('pong');
    ws.close();
  });

  /** Raw TCP sockets that complete the WebSocket upgrade and then never say anything. */
  function holdUnproven(count: number, forwardedFor: (i: number) => string) {
    const id = relayAgentId(generateKeyPair().publicKey);
    return Array.from({ length: count }, (_, i) => {
      const socket = connect(relay.port, '127.0.0.1', () =>
        socket.write(
          `GET /v1/agents/${id}/ws HTTP/1.1\r\nHost: 127.0.0.1:${relay.port}\r\nX-Forwarded-For: ${forwardedFor(i)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        ),
      );
      socket.on('error', () => undefined);
      socket.pause();
      return socket;
    });
  }

  /** A fresh, well-behaved agent: 'registered' or what stopped it. */
  function legitimate(forwardedFor: string): Promise<string> {
    const keys = generateKeyPair();
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/agents/${relayAgentId(keys.publicKey)}/ws`, {
      headers: { 'x-forwarded-for': forwardedFor },
    });
    return new Promise((resolve) => {
      ws.on('unexpected-response', (_req, res) => resolve(`refused ${res.statusCode}`));
      ws.on('message', (data: Buffer) => {
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.type === FrameType.Challenge) {
          ws.send(answerChallenge(keys, frame.payload, `ws://127.0.0.1:${relay.port}`));
        } else if (frame.type === FrameType.Ready) {
          resolve('registered');
          ws.close();
        }
      });
      ws.on('error', (e) => resolve(`error ${e.message}`));
    });
  }

  it('survives a request target that is not a path (review C1)', async () => {
    for (const target of ['http://[', 'http://a:99999/v1', 'http://%/']) {
      await new Promise<void>((resolve) => {
        const socket = connect(relay.port, '127.0.0.1', () =>
          socket.write(
            `GET ${target} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
          ),
        );
        socket.on('data', () => socket.destroy());
        socket.on('close', () => resolve());
        socket.on('error', () => resolve());
      });
    }
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await status()).status).toBe(200);
  });

  it('answers unknown routes with its own code', async () => {
    const res = await fetch(`${base}/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: 'RELAY_NOT_FOUND' });
  });

  it('lets a real agent in while one address floods unproven connections (review H2)', async () => {
    const held = holdUnproven(30, () => '6.6.6.6');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await legitimate('7.7.7.7')).toBe('registered');
    expect(await legitimate('6.6.6.6')).toBe('refused 503'); // the flooding address only blocks itself
    held.forEach((s) => s.destroy());
  });

  it('lets a real agent in while many addresses fill the whole pool (review H2)', async () => {
    const held = holdUnproven(60, (i) => `10.1.${i >> 8}.${i & 255}`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await legitimate('7.7.7.8')).toBe('registered');
    held.forEach((s) => s.destroy());
  });

  it('passes on only 200 or a plain refusal from an agent (hardening)', async () => {
    const keys = generateKeyPair();
    const id = relayAgentId(keys.publicKey);
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/v1/agents/${id}/ws`);
    await new Promise<void>((resolve) =>
      ws.on('message', (data: Buffer) => {
        const frame = decodeFrame(new Uint8Array(data));
        if (frame.type === FrameType.Challenge) {
          ws.send(answerChallenge(keys, frame.payload, `ws://127.0.0.1:${relay.port}`));
        } else if (frame.type === FrameType.Ready) {
          resolve();
        } else if (frame.type === FrameType.Call) {
          for (const reply of encodeReply(frame.callId, 301, new TextEncoder().encode('<script>alert(1)</script>'))) {
            ws.send(reply);
          }
        }
      }),
    );
    const res = await call(Uint8Array.of(1), id);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: 'RELAY_BAD_AGENT_RESPONSE' });
    ws.close();
  });

  it('reconnects after the relay restarts', async () => {
    const port = relay.port;
    await relay.close();
    await until(() => agent.relay.status()?.connected === false);
    relay = await startRelay({ port, metricsPort: 0, logger: false });
    await until(() => agent.relay.status()?.connected === true, 15_000);
    expect((await status()).body).toMatchObject({ cluster: 'homelab-demo' });
  });
});
