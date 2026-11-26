import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { MAX_SEALED_REQUEST } from '@kubernanny/protocol';
import type { Principal } from '../auth/devices.service';
import { INTERNAL, InternalRequest } from '../auth/principal';
import { requestLang } from '../i18n/localize';
import { Lang, localize, t } from '../i18n/text';
import { Logger } from '../logger';
import { MAX_JSON_BODY, securityHeaders } from '../security/http-security';
import { BadRequestError, HttpError, UnauthorizedError } from './errors';

/**
 * The agent's HTTP layer: a route table, the guard, the language at the
 * edge, CORS and the static web UI, on plain node:http. It replaced NestJS +
 * Express, which the agent used for about thirty routes; the behaviour on
 * the wire is the same (status codes, bodies, headers, ETags, 404 pages),
 * and `http/server.spec.ts` pins it.
 */

export type Method = 'GET' | 'POST' | 'DELETE';

export interface Call {
  req: IncomingMessage;
  /** The device (or admin CLI) behind a guarded route; undefined on public routes. */
  principal: Principal;
  /** Parsed JSON body (application/json only), else undefined. */
  body: unknown;
  /** The raw body of a route with `raw: true`. */
  raw: Buffer | undefined;
  params: Record<string, string>;
  /** A query parameter: a string, an array when repeated, undefined when absent. */
  query(name: string): string | string[] | undefined;
  lang: Lang;
}

export interface Route {
  method: Method;
  /** The full path, `/api/devices/:id`; matched case-insensitively, with or without a trailing slash. */
  path: string;
  /** Reachable without a device. A security decision: `auth/public-routes.spec.ts` lists them. */
  public?: boolean;
  /** Status of a successful answer (default 200). */
  status?: number;
  /** Content type of a string answer (default text/html, as Express had it). */
  textType?: string;
  /** Take the body as raw bytes up to MAX_SEALED_REQUEST, whatever its type (the e2e route). */
  raw?: boolean;
  /**
   * Changes something (cluster, stored state) or sends something: only the
   * pod holding the lease runs it; another answers 503 AGENT_HANDOVER, which
   * the app retries (a rolling update has two pods for a few seconds).
   */
  write?: boolean;
  handle(call: Call): unknown;
}

/** An answer written as it is: no JSON, no translation. */
export class Reply {
  constructor(
    readonly status: number,
    readonly body: Buffer | string,
    readonly contentType: string,
  ) {}
}

export interface HttpOptions {
  routes: readonly Route[];
  /** Resolves the device behind a request (the guard); null answers 401 E2E_REQUIRED. */
  principal(req: InternalRequest): Principal | null;
  language: Lang;
  corsOrigins: readonly string[];
  /** The web UI, served at / when set. */
  webRoot?: string | null;
  /** Whether this pod may run `write` routes now (it holds the lease). Default: always. */
  isLeader?(): boolean;
  /** Runs before the guard of every non-public route; a thrown HttpError is the answer. */
  beforeGuard?(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

interface Compiled {
  route: Route;
  re: RegExp;
  names: string[];
}

function compile(route: Route): Compiled {
  const names: string[] = [];
  const pattern = route.path
    .split('/')
    .map((part) => {
      if (part.startsWith(':')) {
        names.push(part.slice(1));
        return '([^/]+?)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { route, re: new RegExp(`^${pattern}/?$`, 'i'), names };
}

// ---- pipes, as the routes had them ----

const NUMERIC = /^-?\d+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An integer query parameter; `optional`: absent is undefined, else 400. */
export function intQuery(call: Call, name: string, optional: true): number | undefined;
export function intQuery(call: Call, name: string, optional?: false): number;
export function intQuery(call: Call, name: string, optional = false): number | undefined {
  const value = call.query(name);
  if (optional && value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !NUMERIC.test(value) || !Number.isFinite(Number(value))) {
    throw new BadRequestError('Validation failed (numeric string is expected)');
  }
  return parseInt(value, 10);
}

export function uuidParam(call: Call, name: string): string {
  const value = call.params[name];
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BadRequestError('Validation failed (uuid is expected)');
  }
  return value;
}

/** A query parameter as the routes typed it (a repeated one stays an array, as Express parsed it). */
export function strQuery(call: Call, name: string): string {
  return call.query(name) as string;
}

// ---- bodies ----

class BodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function hasBody(req: IncomingMessage): boolean {
  return req.headers['transfer-encoding'] !== undefined || (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    req.resume();
    return Promise.reject(new BodyError(413, 'request entity too large'));
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      if (failed) {
        return;
      }
      size += chunk.length;
      if (size > limit) {
        failed = true;
        reject(new BodyError(413, 'request entity too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => !failed && resolve(Buffer.concat(chunks)));
    req.on('error', (err) => !failed && reject(new BodyError(400, err.message)));
  });
}

function isJson(req: IncomingMessage): boolean {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

// ---- answers ----

/** The weak ETag Express put on every body it sent. */
function etagOf(body: Buffer): string {
  const hash = createHash('sha1').update(body).digest('base64').substring(0, 27);
  return `W/"${body.length.toString(16)}-${hash}"`;
}

function fresh(req: IncomingMessage, etag: string | undefined, lastModified?: string): boolean {
  const noneMatch = req.headers['if-none-match'];
  if (noneMatch) {
    if (!etag) {
      return false;
    }
    const strip = (s: string) => s.trim().replace(/^W\//, '');
    return noneMatch.trim() === '*' || noneMatch.split(',').some((tag) => strip(tag) === strip(etag));
  }
  const since = req.headers['if-modified-since'];
  if (since && lastModified) {
    const sinceMs = Date.parse(since);
    return !Number.isNaN(sinceMs) && Date.parse(lastModified) <= sinceMs;
  }
  return false;
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: Buffer | undefined, contentType?: string): void {
  if (status === 204 || status === 304) {
    res.statusCode = status;
    res.end();
    return;
  }
  res.statusCode = status;
  if (body === undefined) {
    res.setHeader('Content-Length', '0');
    res.end();
    return;
  }
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }
  res.setHeader('Content-Length', String(body.length));
  const etag = etagOf(body);
  res.setHeader('ETag', etag);
  if ((req.method === 'GET' || req.method === 'HEAD') && ((status >= 200 && status < 300) || status === 304) && fresh(req, etag)) {
    res.removeHeader('Content-Type');
    res.removeHeader('Content-Length');
    res.statusCode = 304;
    res.end();
    return;
  }
  res.end(req.method === 'HEAD' ? undefined : body);
}

const sendJson = (req: IncomingMessage, res: ServerResponse, status: number, value: unknown) =>
  send(req, res, status, Buffer.from(JSON.stringify(value) ?? ''), 'application/json; charset=utf-8');

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The plain error page outside /api (what Express' final handler sent). */
function htmlPage(req: IncomingMessage, res: ServerResponse, status: number, title: string, text: string, extra: Record<string, string> = {}): void {
  const body = Buffer.from(`<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n</head>\n<body>\n<pre>${escapeHtml(text)}</pre>\n</body>\n</html>\n`);
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(extra)) {
    res.setHeader(k, v);
  }
  res.statusCode = status;
  res.setHeader('Content-Type', title === 'Redirecting' ? 'text/html; charset=UTF-8' : 'text/html; charset=utf-8');
  res.setHeader('Content-Length', String(body.length));
  res.end(req.method === 'HEAD' ? undefined : body);
}

// ---- static files ----

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/vnd.microsoft.icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
};

/**
 * Serves a file of the web UI; false when there is none, so the request goes
 * on to the routes (as serve-static with `fallthrough` did): a path outside
 * the root, a dotfile or a missing file all end up as an ordinary 404.
 */
function serveStatic(root: string, req: IncomingMessage, res: ServerResponse, pathname: string, search: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes('\0')) {
    return false;
  }
  const parts = decoded.split('/');
  if (parts.some((p) => p === '..' || p.startsWith('.'))) {
    return false;
  }
  let file = normalize(join(root, decoded));
  if (file !== root && !file.startsWith(root.endsWith(sep) ? root : root + sep)) {
    return false;
  }
  if (decoded.endsWith('/')) {
    file = join(file, 'index.html');
  }
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return false;
  }
  if (stat.isDirectory()) {
    if (decoded.endsWith('/')) {
      return false;
    }
    const location = `${pathname.replace(/^\/+/, '/')}/${search}`;
    htmlPage(req, res, 301, 'Redirecting', `Redirecting to ${location}`, { Location: location });
    return true;
  }
  if (!stat.isFile()) {
    return false;
  }
  const lastModified = stat.mtime.toUTCString();
  const etag = `W/"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('Last-Modified', lastModified);
  res.setHeader('ETag', etag);
  if (fresh(req, etag, lastModified)) {
    res.statusCode = 304;
    res.end();
    return true;
  }
  res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(stat.size));
  res.statusCode = 200;
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
  return true;
}

// ---- the handler ----

const logger = new Logger('http');

export function createHttpHandler(options: HttpOptions): Handler {
  const compiled = options.routes.map(compile);
  const root = options.webRoot ? normalize(options.webRoot) : null;
  const origins = new Set(options.corsOrigins);

  return (req, res) => {
    void handle(req, res).catch((err: unknown) => {
      logger.error(`request failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (!res.headersSent) {
        sendJson(req, res, 500, { statusCode: 500, message: 'Internal server error' });
      } else {
        res.destroy();
      }
    });
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://agent');
    const pathname = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();
    const lang = requestLang(req, options.language);
    securityHeaders(pathname, res);

    // CORS, as the cors middleware did it: the listed origins only, every OPTIONS answered here.
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Vary', 'Origin');
    if (method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Max-Age', '3600');
      res.setHeader('Content-Length', '0');
      res.statusCode = 204;
      res.end();
      return;
    }

    const match = findRoute(method, pathname);
    let raw: Buffer | undefined;
    let body: unknown;
    try {
      if (hasBody(req)) {
        if (/^\/api\/e2e(\/|$)/i.test(pathname)) {
          raw = await readBody(req, MAX_SEALED_REQUEST);
        } else if (isJson(req)) {
          const text = (await readBody(req, MAX_JSON_BODY)).toString('utf8');
          body = parseJson(text);
        } else {
          req.resume();
        }
      }
    } catch (err) {
      if (err instanceof BodyError) {
        sendJson(req, res, err.status, { statusCode: err.status, message: err.message });
        return;
      }
      throw err;
    }

    if (root && (method === 'GET' || method === 'HEAD') && serveStatic(root, req, res, pathname, url.search)) {
      return;
    }

    if (!match) {
      if (/^\/api(\/|$)/i.test(pathname)) {
        sendJson(req, res, 404, { message: `Cannot ${method} ${pathname}`, error: 'Not Found', statusCode: 404 });
      } else {
        htmlPage(req, res, 404, 'Error', `Cannot ${method} ${pathname}`);
      }
      return;
    }

    const { route, params } = match;
    try {
      let principal: Principal | null = null;
      if (!route.public) {
        // Only for calls that can pass the guard (the internal socket): a stranger on the network must not cause reads.
        if ((req as InternalRequest)[INTERNAL] === true) {
          await options.beforeGuard?.();
        }
        principal = options.principal(req as InternalRequest);
        if (!principal) {
          throw new UnauthorizedError({ code: 'E2E_REQUIRED', message: t('error.e2eRequired') });
        }
      }
      if (route.write && options.isLeader && !options.isLeader()) {
        throw new HttpError({ code: 'AGENT_HANDOVER', message: t('error.agentHandover') }, 503);
      }
      const call: Call = {
        req,
        principal: principal as Principal,
        body,
        raw: route.raw ? raw : undefined,
        params,
        query: (name) => {
          const all = url.searchParams.getAll(name);
          return all.length === 0 ? undefined : all.length === 1 ? all[0] : all;
        },
        lang,
      };
      const result = await route.handle(call);
      if (result instanceof Reply) {
        send(req, res, result.status, Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body), result.contentType);
        return;
      }
      const status = route.status ?? 200;
      if (result === undefined || result === null) {
        send(req, res, status, undefined);
      } else if (typeof result === 'string') {
        send(req, res, status, Buffer.from(result), route.textType ?? 'text/html; charset=utf-8');
      } else {
        sendJson(req, res, status, localize(result, lang));
      }
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(req, res, err.getStatus(), localize(err.getResponse(), lang));
        return;
      }
      logger.error(`${method} ${pathname} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      sendJson(req, res, 500, { statusCode: 500, message: 'Internal server error' });
    }
  }

  function findRoute(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const c of compiled) {
      if (c.route.method !== method && !(method === 'HEAD' && c.route.method === 'GET')) {
        continue;
      }
      const m = c.re.exec(pathname);
      if (m) {
        const params: Record<string, string> = {};
        c.names.forEach((name, i) => {
          try {
            params[name] = decodeURIComponent(m[i + 1]);
          } catch {
            params[name] = m[i + 1];
          }
        });
        return { route: c.route, params };
      }
    }
    return null;
  }
}

/** body-parser's strict JSON: an object or an array, else 400. */
function parseJson(text: string): unknown {
  if (text.length === 0) {
    return {};
  }
  const first = /^[\x20\x09\x0a\x0d]*(.)/.exec(text)?.[1];
  if (first !== '{' && first !== '[') {
    throw new BodyError(400, `Unexpected token ${first ?? ''} in JSON at position 0`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new BodyError(400, err instanceof Error ? err.message : 'invalid JSON');
  }
}
