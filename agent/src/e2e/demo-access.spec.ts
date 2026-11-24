import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { IdentityService } from '../auth/identity.service';
import { applyHttpSecurity } from '../security/http-security';
import { E2eClient } from '../testing/e2e-client';

describe('DEMO mode', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DEMO = 'healthy';
    process.env.INTERNAL_SOCKET = join(mkdtempSync(join(tmpdir(), 'kubernanny-')), 'agent.sock');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
    applyHttpSecurity(app as NestExpressApplication);
    app.setGlobalPrefix('api', { exclude: ['healthz'] });
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
