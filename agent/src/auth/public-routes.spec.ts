import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module';
import { DemoAgent, startDemoAgent } from '../testing/demo-agent';
import { IS_PUBLIC, PrincipalGuard } from './principal.guard';

/** The only routes anyone on the network may call. Adding one here is a security decision. */
const PUBLIC = ['GET /healthz', 'GET /identity', 'POST /e2e'];

interface Route {
  method: string;
  path: string;
  isPublic: boolean;
}

/** Every route of every controller the agent registers, read from the decorators. */
function routes(): Route[] {
  const controllers = (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule) ?? []) as (new (...args: never[]) => unknown)[];
  return controllers.flatMap((controller) => {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    const classPublic = Reflect.getMetadata(IS_PUBLIC, controller) === true;
    const proto = controller.prototype as Record<string, unknown>;
    return Object.getOwnPropertyNames(proto)
      .filter((name) => name !== 'constructor' && Reflect.hasMetadata(METHOD_METADATA, proto[name] as object))
      .map((name) => {
        const handler = proto[name] as object;
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number];
        const path = `/${[base, String(Reflect.getMetadata(PATH_METADATA, handler))].filter((p) => p && p !== '/').join('/')}`.replace(/\/+/g, '/');
        return { method, path, isPublic: classPublic || Reflect.getMetadata(IS_PUBLIC, handler) === true };
      });
  });
}

describe('every route is guarded unless marked @Public (fail closed)', () => {
  it('registers PrincipalGuard as the global guard', () => {
    const providers = (Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) ?? []) as { provide?: unknown; useClass?: unknown }[];
    expect(providers.some((p) => p.provide === APP_GUARD && p.useClass === PrincipalGuard)).toBe(true);
  });

  it('marks exactly the known public routes as public', () => {
    const all = routes();
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter((r) => r.isPublic).map((r) => `${r.method} ${r.path}`).sort()).toEqual([...PUBLIC].sort());
  });

  describe('on the public port', () => {
    let agent: DemoAgent;
    beforeAll(async () => {
      agent = await startDemoAgent();
    });
    afterAll(async () => {
      await agent.close();
    });

    it('answers 401 E2E_REQUIRED on every other route, even with the principal header', async () => {
      const guarded = routes().filter((r) => !r.isPublic);
      for (const route of guarded) {
        // Parameters get a well-formed value, so a pipe cannot answer before the guard would.
        const path = `/api${route.path.replace(':id', '00000000-0000-4000-8000-000000000000').replace(/:[a-z]+/g, 'x')}?issue=x&hours=1`;
        const res = await request(agent.app.getHttpServer())
          [route.method.toLowerCase() as 'get' | 'post' | 'delete'](path)
          .set('x-kubernanny-principal', 'demo');
        expect(res.status, `${route.method} ${route.path}`).toBe(401);
        expect(res.body.code, `${route.method} ${route.path}`).toBe('E2E_REQUIRED');
      }
    });
  });
});
