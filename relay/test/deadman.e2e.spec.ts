import { parsePublicKey, relayAgentId, toBase64Url } from '@kubernanny/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DemoAgent, startDemoAgent } from '../../agent/src/testing/demo-agent';
import { AgentHub } from '../src/agent-hub.service';
import { RunningRelay, startRelay } from '../src/bootstrap';
import { RelayMetrics } from '../src/metrics';

/**
 * A real agent and a real relay with push on (a service account that is
 * never used to send here): the agent's RelayClient sees `deadman` in Ready,
 * deposits over its connection and gets `stored`; the relay arms the switch
 * when the agent goes away and disarms it when it comes back.
 */
describe("dead man's switch, agent and relay end to end", () => {
  let relay: RunningRelay;
  let agent: DemoAgent;
  let agentId: string;

  async function until(condition: () => boolean, ms = 10_000): Promise<void> {
    const end = Date.now() + ms;
    while (!condition()) {
      if (Date.now() > end) {
        throw new Error('timed out waiting');
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  beforeAll(async () => {
    process.env.FCM_SERVICE_ACCOUNT = JSON.stringify({ client_email: 'r@x.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n', project_id: 'kubernanny-test' });
    relay = await startRelay({ port: 0, metricsPort: 0, logger: false });
    agent = await startDemoAgent({ RELAY_URL: `ws://127.0.0.1:${relay.port}` });
    agentId = relayAgentId(parsePublicKey(agent.publicKey));
    await until(() => agent.relay.status()?.connected === true);
  });

  afterAll(async () => {
    await agent?.close();
    await relay?.close();
    delete process.env.FCM_SERVICE_ACCOUNT;
  });

  it('deposits over the agent connection and arms when the agent leaves', async () => {
    expect(agent.relay.deadmanAvailable()).toBe(true);
    // The agent's own first deposit on this connection (nobody asked for the switch: it clears) comes first.
    const metrics = relay.app.get(RelayMetrics);
    await until(() => metrics.render().includes('event="deposit_stored"'));
    const item = { token: 'cXVpdGUtYS10b2tlbg:APA91bHPRgkF-test_token', platform: 'android' as const, kid: 'AbCdEfGhIjKlMnOp', message: toBase64Url(new Uint8Array(150).fill(3)), lang: 'en' as const, graceMinutes: 10 };
    expect(await agent.relay.deposit({ validitySeconds: 3600, holdSeconds: 0, items: [item] })).toBe('stored');
    const hub = relay.app.get(AgentHub) as unknown as { deadmen: { state(id: string): { items: unknown[]; lostAt: number | null } | null } };
    expect(hub.deadmen.state(agentId)).toMatchObject({ items: [expect.objectContaining({ kid: 'AbCdEfGhIjKlMnOp', graceMs: 600_000 })], lostAt: null });
    agent.relay.handOver();
    await until(() => hub.deadmen.state(agentId)?.lostAt !== null);
    agent.relay.onApplicationBootstrap();
    await until(() => agent.relay.status()?.connected === true);
    expect(hub.deadmen.state(agentId)?.lostAt).toBeNull();
  });
});
