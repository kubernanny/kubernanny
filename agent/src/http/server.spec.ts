import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ADMIN } from '../auth/devices.service';
import { INTERNAL } from '../auth/principal';
import { t } from '../i18n/text';
import { CONTENT_SECURITY_POLICY } from '../security/http-security';
import { BadRequestError, NotFoundError } from './errors';
import { createHttpHandler, intQuery, Reply, Route, uuidParam } from './server';

/**
 * The wire behaviour the agent had on NestJS + Express, pinned route by
 * route kind: what the app, browsers and proxies see must not change with
 * the framework gone.
 */
const web = mkdtempSync(join(tmpdir(), 'kn-web-'));
writeFileSync(join(web, 'index.html'), '<!doctype html><title>k</title>');
writeFileSync(join(web, 'main-ABC.js'), 'console.log(1)');
writeFileSync(join(web, '.env'), 'SECRET=1');
mkdirSync(join(web, 'media'));
writeFileSync(join(web, 'media', 'f.woff2'), 'font');

const routes: Route[] = [
  { method: 'GET', path: '/healthz', public: true, handle: () => ({ ok: true }) },
  {
    method: 'GET',
    path: '/api/open',
    public: true,
    handle: (c) => ({ n: intQuery(c, 'n', true) ?? null, q: c.query('q') ?? null }),
  },
  { method: 'GET', path: '/api/guarded', handle: (c) => ({ who: c.principal.name }) },
  { method: 'DELETE', path: '/api/things/:id', public: true, status: 204, handle: (c) => void uuidParam(c, 'id') },
  { method: 'POST', path: '/api/echo', public: true, handle: (c) => ({ body: c.body ?? null }) },
  { method: 'POST', path: '/api/text', public: true, textType: 'text/plain; charset=utf-8', handle: () => 'banner' },
  { method: 'POST', path: '/api/html', public: true, handle: () => 'plain' },
  {
    method: 'POST',
    path: '/api/e2e',
    public: true,
    raw: true,
    handle: (c) => new Reply(200, c.raw ?? Buffer.alloc(0), 'application/octet-stream'),
  },
  {
    method: 'GET',
    path: '/api/text-error',
    public: true,
    handle: () => Promise.reject(new NotFoundError({ code: 'X', message: t('error.issueGone') })),
  },
  { method: 'GET', path: '/api/plain-error', public: true, handle: () => Promise.reject(new BadRequestError('nope')) },
  { method: 'GET', path: '/api/bare-error', public: true, handle: () => Promise.reject(new NotFoundError()) },
  { method: 'GET', path: '/api/crash', public: true, handle: () => Promise.reject(new Error('boom')) },
  { method: 'GET', path: '/api/translated', public: true, handle: () => ({ title: t('error.issueGone') }) },
];

function handler(webRoot: string | null = web) {
  return createHttpHandler({
    routes,
    principal: (req) => (req[INTERNAL] ? ADMIN : null),
    language: 'en',
    corsOrigins: ['http://localhost:4200'],
    webRoot,
  });
}
const server = () => createServer(handler());

describe('the HTTP layer (as on NestJS + Express)', () => {
  it('sets the security headers on every answer, no-store under /api, no X-Powered-By', async () => {
    for (const path of ['/healthz', '/api/open', '/', '/nope']) {
      const res = await request(server()).get(path);
      expect(res.headers['content-security-policy'], path).toBeDefined();
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(res.headers['x-powered-by']).toBeUndefined();
      expect(res.headers['strict-transport-security']).toBeUndefined();
      expect(res.headers['cache-control'], path).toBe(
        path.startsWith('/api/') ? 'no-store' : path === '/' ? 'public, max-age=3600' : undefined,
      );
    }
    expect((await request(server()).get('/healthz')).headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
  });

  it('answers JSON with Express ETags, and 304 to a matching If-None-Match', async () => {
    const res = await request(server()).get('/healthz').expect(200, { ok: true });
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(res.headers['etag']).toBe('W/"b-Ai2R8hgEarLmHKwesT1qcY913ys"');
    expect(res.headers['content-length']).toBe('11');
    await request(server()).get('/healthz').set('if-none-match', res.headers['etag']).expect(304);
    const head = await request(server()).head('/healthz').expect(200);
    expect(head.headers['content-length']).toBe('11');
  });

  it('matches paths case-insensitively and with a trailing slash; /healthz stays outside /api', async () => {
    await request(server()).get('/HEALTHZ').expect(200);
    await request(server()).get('/healthz/').expect(200);
    await request(server())
      .get('/api/healthz')
      .expect(404, { message: 'Cannot GET /api/healthz', error: 'Not Found', statusCode: 404 });
  });

  it('answers unknown paths with the JSON 404 under /api and the plain page elsewhere', async () => {
    const api = await request(server()).post('/api/nope').expect(404);
    expect(api.body).toEqual({ message: 'Cannot POST /api/nope', error: 'Not Found', statusCode: 404 });
    const page = await request(server()).get('/nope.js').expect(404);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(page.headers['content-security-policy']).toBe("default-src 'none'");
    expect(page.text).toBe(
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>Error</title>\n</head>\n<body>\n<pre>Cannot GET /nope.js</pre>\n</body>\n</html>\n',
    );
    expect(page.text.length).toBe(146);
    // A route exists but not for this method: the same 404.
    await request(server()).post('/healthz').expect(404);
  });

  it('guards every route that is not public: 401 E2E_REQUIRED on the network, the principal only on the internal socket', async () => {
    const res = await request(server()).get('/api/guarded').set('x-kubernanny-principal', 'admin').expect(401);
    expect(res.body).toEqual({ code: 'E2E_REQUIRED', message: 'Only through the encrypted channel (POST /api/e2e).' });
    const internal = handler();
    const viaSocket = createServer((req, r) => {
      (req as typeof req & { [INTERNAL]?: true })[INTERNAL] = true;
      internal(req, r);
    });
    await request(viaSocket).get('/api/guarded').expect(200, { who: ADMIN.name });
  });

  it('validates parameters like the pipes did', async () => {
    await request(server()).get('/api/open?n=12').expect(200, { n: 12, q: null });
    await request(server())
      .get('/api/open?q=a&q=b')
      .expect(200, { n: null, q: ['a', 'b'] });
    expect((await request(server()).get('/api/open?n=1.5').expect(400)).body).toEqual({
      message: 'Validation failed (numeric string is expected)',
      error: 'Bad Request',
      statusCode: 400,
    });
    expect((await request(server()).delete('/api/things/nope').expect(400)).body).toEqual({
      message: 'Validation failed (uuid is expected)',
      error: 'Bad Request',
      statusCode: 400,
    });
    const ok = await request(server()).delete('/api/things/00000000-0000-4000-8000-000000000000').expect(204);
    expect(ok.text).toBe('');
  });

  it('takes JSON bodies up to 4 KiB, only as application/json, and the e2e body raw', async () => {
    await request(server())
      .post('/api/echo')
      .send({ a: 1 })
      .expect(200, { body: { a: 1 } });
    await request(server())
      .post('/api/echo')
      .set('content-type', 'text/plain')
      .send('{"a":1}')
      .expect(200, { body: null });
    const big = await request(server())
      .post('/api/echo')
      .send({ pad: 'y'.repeat(5000) })
      .expect(413);
    expect(big.body).toEqual({ statusCode: 413, message: 'request entity too large' });
    expect(
      (await request(server()).post('/api/echo').set('content-type', 'application/json').send('{oops').expect(400)).body
        .statusCode,
    ).toBe(400);
    expect(
      (await request(server()).post('/api/echo').set('content-type', 'application/json').send('"str"').expect(400)).body
        .statusCode,
    ).toBe(400);
    const raw = await request(server())
      .post('/api/e2e')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.from([1, 2, 3]))
      .buffer(true)
      .parse((r, done) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect([...(raw.body as Buffer)]).toEqual([1, 2, 3]);
    await request(server())
      .post('/api/e2e')
      .set('content-type', 'application/octet-stream')
      .send(Buffer.alloc(70_000, 1))
      .expect(413);
  });

  it('sends strings as text/html unless the route says otherwise', async () => {
    expect((await request(server()).post('/api/html').expect(200)).headers['content-type']).toBe(
      'text/html; charset=utf-8',
    );
    const text = await request(server()).post('/api/text').expect(200);
    expect(text.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(text.text).toBe('banner');
  });

  it("renders errors: the thrown body in the request language, plain strings and bare errors in Nest's shape, anything else 500 without details", async () => {
    expect((await request(server()).get('/api/text-error').expect(404)).body).toEqual({
      code: 'X',
      message: expect.any(String),
    });
    expect((await request(server()).get('/api/plain-error').expect(400)).body).toEqual({
      message: 'nope',
      error: 'Bad Request',
      statusCode: 400,
    });
    expect((await request(server()).get('/api/bare-error').expect(404)).body).toEqual({
      statusCode: 404,
      message: 'Not Found',
    });
    expect((await request(server()).get('/api/crash').expect(500)).body).toEqual({
      statusCode: 500,
      message: 'Internal server error',
    });
    expect(typeof (await request(server()).get('/api/translated').expect(200)).body.title).toBe('string');
  });

  it('answers CORS for the listed origins only, every OPTIONS with 204', async () => {
    const pre = await request(server())
      .options('/api/e2e')
      .set('origin', 'http://localhost:4200')
      .set('access-control-request-method', 'POST')
      .expect(204);
    expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    expect(pre.headers['access-control-allow-methods']).toBe('GET,HEAD,PUT,PATCH,POST,DELETE');
    expect(pre.headers['access-control-allow-headers']).toBe('content-type');
    expect(pre.headers['access-control-max-age']).toBe('3600');
    expect(pre.headers['vary']).toBe('Origin');
    const evil = await request(server()).options('/api/e2e').set('origin', 'https://evil.example').expect(204);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    expect(
      (await request(server()).get('/healthz').set('origin', 'https://evil.example')).headers[
        'access-control-allow-origin'
      ],
    ).toBeUndefined();
    expect(
      (await request(server()).get('/healthz').set('origin', 'http://localhost:4200')).headers[
        'access-control-allow-origin'
      ],
    ).toBe('http://localhost:4200');
  });

  it('serves the web UI like serve-static: index, types, caching, 304, directory redirect, no dotfiles or traversal', async () => {
    const index = await request(server()).get('/').expect(200);
    expect(index.text).toBe('<!doctype html><title>k</title>');
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.headers['accept-ranges']).toBe('bytes');
    expect(index.headers['etag']).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(index.headers['last-modified']).toBeDefined();
    await request(server()).get('/').set('if-none-match', index.headers['etag']).expect(304);
    await request(server()).get('/index.html').set('if-modified-since', index.headers['last-modified']).expect(304);
    expect((await request(server()).get('/main-ABC.js').expect(200)).headers['content-type']).toBe(
      'text/javascript; charset=utf-8',
    );
    expect((await request(server()).get('/media/f.woff2').expect(200)).headers['content-type']).toBe('font/woff2');
    const redirect = await request(server()).get('/media?x=1').expect(301);
    expect(redirect.headers['location']).toBe('/media/?x=1');
    expect(redirect.headers['content-security-policy']).toBe("default-src 'none'");
    await request(server()).get('/media/').expect(404);
    await request(server()).get('/.env').expect(404);
    await request(server()).get('/media/%2e%2e/.env').expect(404);
    await request(server()).get('/../etc/passwd').expect(404);
    // Without WEB_ROOT nothing is served.
    await request(createServer(handler(null)))
      .get('/')
      .expect(404);
  });
});
