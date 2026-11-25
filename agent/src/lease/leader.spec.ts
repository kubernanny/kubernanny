import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer } from 'node:http';
import { Agent } from '../agent';
import { INTERNAL, PRINCIPAL_HEADER } from '../auth/principal.guard';
import { KubeError } from '../kube/kube-client';
import { Notifier } from '../notify/notifier';
import { Snapshot } from '../status/status.service';
import { DemoAgent, startDemoAgent } from '../testing/demo-agent';
import { LeaderElection, LeaseApi } from './leader';

/** One Lease object with the API server's optimistic concurrency: a write naming an old resourceVersion gets 409. */
class FakeLeases implements LeaseApi {
  lease: { metadata: { resourceVersion: string }; spec: Record<string, unknown> } | null = null;
  private version = 1;
  down = false;
  readonly writes: unknown[] = [];

  async get<T>(): Promise<T> {
    if (this.down) {
      throw new KubeError(503, 'unavailable');
    }
    if (!this.lease) {
      throw new KubeError(404, 'not found');
    }
    return structuredClone(this.lease) as T;
  }

  async create(_path: string, body: { spec: Record<string, unknown> }): Promise<void> {
    if (this.lease) {
      throw new KubeError(409, 'already exists');
    }
    this.writes.push(body);
    this.lease = { metadata: { resourceVersion: String(++this.version) }, spec: body.spec };
  }

  async mergePatch(_path: string, body: { metadata: { resourceVersion: string }; spec: Record<string, unknown> }): Promise<void> {
    if (this.down) {
      throw new KubeError(503, 'unavailable');
    }
    if (!this.lease || body.metadata.resourceVersion !== this.lease.metadata.resourceVersion) {
      throw new KubeError(409, 'the object has been modified');
    }
    this.writes.push(body);
    const spec = { ...this.lease.spec };
    for (const [k, v] of Object.entries(body.spec)) {
      if (v === null) {
        delete spec[k];
      } else {
        spec[k] = v;
      }
    }
    this.lease = { metadata: { resourceVersion: String(++this.version) }, spec };
  }
}

function pod(api: FakeLeases, identity: string, clock: { now: number }) {
  return new LeaderElection(api, { namespace: 'kubernanny', name: 'kubernanny', identity, durationSeconds: 15, now: () => clock.now });
}

describe('the lease (which pod is in charge)', () => {
  it('is created by the first pod; a second pod waits while the first renews', async () => {
    const api = new FakeLeases();
    const clock = { now: 1_000_000 };
    const a = pod(api, 'pod-a', clock);
    const b = pod(api, 'pod-b', clock);
    expect(await a.tryNow()).toBe(true);
    expect(api.lease!.spec.holderIdentity).toBe('pod-a');
    for (let i = 0; i < 20; i++) {
      clock.now += 2000;
      expect(await a.tryNow()).toBe(true);
      expect(await b.tryNow()).toBe(false);
    }
    expect(api.lease!.spec.leaseTransitions).toBe(0);
  });

  it('hands over on release (SIGTERM) without waiting for the expiry', async () => {
    const api = new FakeLeases();
    const clock = { now: 1_000_000 };
    const a = pod(api, 'pod-a', clock);
    const b = pod(api, 'pod-b', clock);
    const seen: boolean[] = [];
    a.onChange((l) => seen.push(l));
    await a.tryNow();
    expect(await b.tryNow()).toBe(false);
    await a.release();
    expect(a.isLeader()).toBe(false);
    expect(seen).toEqual([true, false]);
    expect(api.lease!.spec.holderIdentity).toBeUndefined();
    expect(await b.tryNow()).toBe(true);
    expect(api.lease!.spec).toMatchObject({ holderIdentity: 'pod-b', leaseTransitions: 1 });
    // A released pod never takes it back.
    expect(await a.tryNow()).toBe(false);
  });

  it('takes over from a pod that died without releasing, once the lease expired by its own clock', async () => {
    const api = new FakeLeases();
    const clock = { now: 1_000_000 };
    const a = pod(api, 'pod-a', clock);
    const b = pod(api, 'pod-b', clock);
    await a.tryNow();
    expect(await b.tryNow()).toBe(false);
    clock.now += 14_000;
    expect(await b.tryNow()).toBe(false);
    clock.now += 2_000;
    expect(await b.tryNow()).toBe(true);
  });

  it('lets only one of two racing pods win a free lease', async () => {
    const api = new FakeLeases();
    const clock = { now: 1_000_000 };
    await pod(api, 'old', clock).tryNow();
    await pod(api, 'old', clock).release().catch(() => undefined);
    api.lease!.spec.holderIdentity = '';
    const results = await Promise.all([pod(api, 'pod-a', clock).tryNow(), pod(api, 'pod-b', clock).tryNow()]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('stops acting when it cannot renew, before anyone else may take over', async () => {
    const api = new FakeLeases();
    const clock = { now: 1_000_000 };
    const a = pod(api, 'pod-a', clock);
    await a.tryNow();
    api.down = true;
    clock.now += 11_000;
    await a.tryNow();
    expect(a.isLeader()).toBe(true);
    clock.now += 2_000;
    expect(a.isLeader()).toBe(false);
  });
});

describe('two pods during a rolling update', () => {
  const agents: DemoAgent[] = [];
  afterEach(async () => {
    for (const a of agents.splice(0)) {
      await a.close();
    }
  });

  /** A request as the end-to-end channel hands it in over the internal socket. */
  function internal(agent: Agent) {
    return createServer((req, res) => {
      (req as typeof req & { [INTERNAL]?: true })[INTERNAL] = true;
      agent.handler(req, res);
    });
  }

  async function start(name: string, api: FakeLeases, clock: { now: number }) {
    const pushed: Snapshot[] = [];
    const notifier = { channels: ['ntfy'], update: async (s: Snapshot) => void pushed.push(s), securityAlert: async () => undefined, test: async () => ['ntfy'], locked: false };
    const leader = pod(api, name, clock);
    const agent = await startDemoAgent({ DEMO: 'broken', CHECK_INTERVAL_SECONDS: '3600' }, { notifier: notifier as unknown as Notifier, leader });
    agents.push(agent);
    return { agent: agent.app, leader, pushed };
  }

  it('lets only the pod holding the lease notify and write; the other answers reads and refuses writes with 503 AGENT_HANDOVER until it takes over', async () => {
    const api = new FakeLeases();
    const clock = { now: Date.now() };
    const old = await start('pod-old', api, clock);
    const neu = await start('pod-new', api, clock);
    await old.agent.status.refresh();
    await neu.agent.status.refresh();
    expect(old.pushed.length).toBeGreaterThan(0);
    expect(neu.pushed).toEqual([]);

    await request(internal(neu.agent)).get('/api/status').set(PRINCIPAL_HEADER, 'demo').expect(200);
    const refused = await request(internal(neu.agent)).post('/api/notify/test').set(PRINCIPAL_HEADER, 'demo').expect(503);
    expect(refused.body.code).toBe('AGENT_HANDOVER');
    await request(internal(old.agent)).post('/api/notify/test').set(PRINCIPAL_HEADER, 'demo').expect(200);

    // SIGTERM on the old pod: it releases; the new pod takes over on its next try.
    await old.leader.release();
    expect(await neu.leader.tryNow()).toBe(true);
    await request(internal(neu.agent)).post('/api/notify/test').set(PRINCIPAL_HEADER, 'demo').expect(200);
    await request(internal(old.agent)).post('/api/notify/test').set(PRINCIPAL_HEADER, 'demo').expect(503);
    const before = old.pushed.length;
    await old.agent.status.refresh();
    await neu.agent.status.refresh();
    expect(old.pushed.length).toBe(before);
    expect(neu.pushed.length).toBe(1);
  });
});

describe('readiness and shutdown', () => {
  it('is unready until the first run is in memory, and from SIGTERM on, while it keeps answering until the delay passed', async () => {
    process.env.DEMO = 'healthy';
    process.env.CHECK_INTERVAL_SECONDS = '3600';
    process.env.SHUTDOWN_DELAY_SECONDS = '1';
    const agent = new Agent();
    try {
      const server = agent.getHttpServer();
      await request(server).get('/readyz').expect(503, { ok: false });
      await request(server).get('/healthz').expect(200);
      await agent.init();
      await agent.status.refresh();
      await request(server).get('/readyz').expect(200, { ok: true });

      await agent.listen(0, '127.0.0.1');
      const port = (server.address() as { port: number }).port;
      const done = agent.shutdown(2000);
      const started = Date.now();
      // Unready at once, still answering during the delay.
      const res = await fetch(`http://127.0.0.1:${port}/readyz`);
      expect(res.status).toBe(503);
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      await done;
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      expect(server.listening).toBe(false);
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    } finally {
      await agent.close();
      delete process.env.DEMO;
      delete process.env.SHUTDOWN_DELAY_SECONDS;
    }
  });

  it('turns ready after READY_TIMEOUT_SECONDS even if the first run never finishes', async () => {
    process.env.DEMO = 'healthy';
    process.env.READY_TIMEOUT_SECONDS = '1';
    const agent = new Agent();
    try {
      // Never run: the interval is an hour and no refresh is started.
      (agent.status as unknown as { onApplicationBootstrap(): void }).onApplicationBootstrap = () => undefined;
      await agent.init();
      expect(agent.ready()).toBe(false);
      await new Promise((r) => setTimeout(r, 1100));
      expect(agent.ready()).toBe(true);
    } finally {
      await agent.close();
      delete process.env.DEMO;
      delete process.env.READY_TIMEOUT_SECONDS;
    }
  });
});
