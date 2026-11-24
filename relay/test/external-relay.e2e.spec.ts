import { FrameType, RelayClose, answerChallenge, decodeFrame, generateKeyPair, parsePublicKey, relayAgentId, sealRequest } from '@kubernanny/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { DemoAgent, startDemoAgent } from '../../agent/src/testing/demo-agent';

/**
 * The same path against a relay that is already running somewhere else,
 * typically the Cloudflare Worker under `wrangler dev`:
 *
 *   cd relay/cloudflare && npx wrangler dev --port 8787
 *   cd relay && RELAY_E2E_URL=http://127.0.0.1:8787 npx vitest run test/external-relay.e2e.spec.ts
 *
 * Skipped without RELAY_E2E_URL.
 */
const base = process.env.RELAY_E2E_URL?.replace(/\/+$/, '');

describe.skipIf(!base)(`a running relay at ${base}`, () => {
  let agent: DemoAgent;
  let agentId: string;
  const device = generateKeyPair();
  const wsBase = base?.replace(/^http/, 'ws') ?? '';

  async function until(condition: () => boolean, ms = 15_000): Promise<void> {
    const end = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > end) {
        throw new Error('timed out waiting');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const call = (body: Uint8Array, id = agentId) =>
    fetch(`${base}/v1/agents/${id}/e2e`, { method: 'POST', body: Buffer.from(body), headers: { 'content-type': 'application/octet-stream', origin: 'https://app.example' } });

  beforeAll(async () => {
    agent = await startDemoAgent({ RELAY_URL: wsBase });
    agentId = relayAgentId(parsePublicKey(agent.publicKey));
    await until(() => agent.relay.status()?.connected === true);
  });

  afterAll(async () => {
    await agent?.close();
  });

  it('carries a sealed call and its answer, and passes plain refusals through', async () => {
    const sealed = sealRequest(device, parsePublicKey(agent.publicKey), { method: 'GET', path: '/status', time: Date.now() });
    const res = await call(sealed.body);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const answer = sealed.open(new Uint8Array(await res.arrayBuffer()));
    expect(answer.status).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(answer.body))).toMatchObject({ cluster: 'homelab-demo' });
    const replay = await call(sealed.body);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ code: 'E2E_REPLAY' });
  });

  it('answers for itself for an agent that is not connected, and for a body too large', async () => {
    const offline = await call(Uint8Array.of(1, 2, 3), relayAgentId(generateKeyPair().publicKey));
    expect(offline.status).toBe(503);
    expect(await offline.json()).toEqual({ code: 'RELAY_AGENT_OFFLINE' });
    expect((await call(new Uint8Array(70_000))).status).toBe(413);
  });

  it('refuses a squatter and keeps the real agent', async () => {
    const ws = new WebSocket(`${wsBase}/v1/agents/${agentId}/ws`);
    const squatter = generateKeyPair();
    const code = await new Promise<number>((resolve) => {
      ws.on('message', (data: Buffer, binary: boolean) => {
        if (binary && decodeFrame(new Uint8Array(data)).type === FrameType.Challenge) {
          ws.send(answerChallenge(squatter, decodeFrame(new Uint8Array(data)).payload));
        }
      });
      ws.on('close', (c) => resolve(c));
    });
    expect(code).toBe(RelayClose.ProofFailed);
    const sealed = sealRequest(device, parsePublicKey(agent.publicKey), { method: 'GET', path: '/info', time: Date.now() });
    expect((await call(sealed.body)).status).toBe(200);
  });

  it('answers the heartbeat', async () => {
    const ws = new WebSocket(`${wsBase}/v1/agents/${relayAgentId(generateKeyPair().publicKey)}/ws`);
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send('ping');
    expect(await new Promise<string>((resolve) => ws.on('message', (data: Buffer, binary: boolean) => !binary && resolve(data.toString())))).toBe('pong');
    ws.close();
  });
});
