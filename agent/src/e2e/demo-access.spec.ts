import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Agent } from '../agent';
import { IdentityService } from '../auth/identity.service';
import { E2eClient } from '../testing/e2e-client';

describe('DEMO mode', () => {
  let app: Agent;

  beforeAll(async () => {
    process.env.DEMO = 'healthy';
    process.env.INTERNAL_SOCKET = join(mkdtempSync(join(tmpdir(), 'kubernanny-')), 'agent.sock');
    const moduleRef = new Agent();
    app = moduleRef;
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DEMO;
    delete process.env.INTERNAL_SOCKET;
  });

  it('lets any device in, still end-to-end encrypted, and pairs with any code without storing it', async () => {
    const client = new E2eClient(app.getHttpServer(), app.get(IdentityService).publicKey);
    await client.get('/status', 200);
    expect((await client.post('/pair', { code: 'anything' }, 200)).body).toMatchObject({ deviceId: 'demo' });
    expect((await client.get('/devices', 200)).body).toEqual([]);
  });
});
