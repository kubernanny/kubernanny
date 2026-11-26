import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DemoAgent, startDemoAgent } from '../testing/demo-agent';

/** The only routes anyone on the network may call. Adding one here is a security decision. */
const PUBLIC = ['GET /healthz', 'GET /readyz', 'GET /api/identity', 'POST /api/e2e'];

describe('every route is guarded unless marked public (fail closed)', () => {
  let agent: DemoAgent;
  beforeAll(async () => {
    agent = await startDemoAgent();
  });
  afterAll(async () => {
    await agent.close();
  });

  it('marks exactly the known public routes as public', () => {
    const all = agent.app.routes;
    expect(all.length).toBeGreaterThan(20);
    expect(
      all
        .filter((r) => r.public)
        .map((r) => `${r.method} ${r.path}`)
        .sort(),
    ).toEqual([...PUBLIC].sort());
  });

  it('answers 401 E2E_REQUIRED on the public port on every other route, even with the principal header', async () => {
    const guarded = agent.app.routes.filter((r) => !r.public);
    for (const route of guarded) {
      // Parameters get a well-formed value, so a parameter check cannot answer before the principal check would.
      const path = `${route.path.replace(':id', '00000000-0000-4000-8000-000000000000').replace(/:[a-z]+/g, 'x')}?issue=x&hours=1`;
      const res = await request(agent.app.getHttpServer())
        [route.method.toLowerCase() as 'get' | 'post' | 'delete'](path)
        .set('x-kubernanny-principal', 'demo');
      expect(res.status, `${route.method} ${route.path}`).toBe(401);
      expect(res.body.code, `${route.method} ${route.path}`).toBe('E2E_REQUIRED');
    }
  });
});
