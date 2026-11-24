import 'reflect-metadata';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { IdentityService } from '../auth/identity.service';
import { RelayClient } from '../relay/relay-client';
import { applyHttpSecurity } from '../security/http-security';

export interface DemoAgent {
  app: INestApplication;
  publicKey: string;
  relay: RelayClient;
  close(): Promise<void>;
}

/**
 * A real agent on the demo cluster, as in production but without a port:
 * for tests in this package and in relay/ (which starts one behind its relay).
 * `env` is applied before the module is built and removed again on close.
 */
export async function startDemoAgent(env: Record<string, string> = {}): Promise<DemoAgent> {
  const applied: Record<string, string> = {
    DEMO: 'healthy',
    // sun_path is short: keep the socket in a short /tmp path.
    INTERNAL_SOCKET: join(mkdtempSync(join(tmpdir(), 'kn-')), 'a.sock'),
    ...env,
  };
  Object.assign(process.env, applied);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ logger: false, bodyParser: false });
  applyHttpSecurity(app as NestExpressApplication);
  app.setGlobalPrefix('api', { exclude: ['healthz'] });
  await app.init();
  return {
    app,
    publicKey: app.get(IdentityService).publicKey,
    relay: app.get(RelayClient),
    async close() {
      await app.close();
      for (const key of Object.keys(applied)) {
        delete process.env[key];
      }
    },
  };
}
