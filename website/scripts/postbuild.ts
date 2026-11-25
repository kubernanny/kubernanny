/**
 * After `vite build`: turns the prerendered `route/index.html` files into
 * `route.html` (Cloudflare Pages serves those at `/route` without a redirect),
 * moves the not-found page to `404.html`, writes `sitemap.xml`, puts the hashes
 * of the prerendered inline scripts into `_headers` (script-src without
 * 'unsafe-inline'), and fails the build if any route did not prerender.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync, readdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { NOT_FOUND_ROUTE, allRoutes, sitemapRoutes } from '../build/routes.ts';
import { WEBSITE_ROOT } from '../build/docs-source.ts';

export const OUT_DIR = join(WEBSITE_ROOT, 'dist', 'analog', 'public');
const SITE_URL = 'https://kubernanny.app';

export function htmlFileFor(route: string): string {
  return route === '/' ? 'index.html' : `${route.slice(1)}.html`;
}

function flatten(route: string): void {
  if (route === '/') {
    return;
  }
  const nested = join(OUT_DIR, route.slice(1), 'index.html');
  const flat = join(OUT_DIR, htmlFileFor(route));
  if (!existsSync(nested)) {
    if (existsSync(flat)) {
      return;
    }
    throw new Error(`Route ${route} was not prerendered (missing ${nested})`);
  }
  renameSync(nested, flat);
  const dir = dirname(nested);
  if (readdirSync(dir).length === 0) {
    rmdirSync(dir);
  }
}

/** The CSP source for every executable inline script (JSON data blocks are not run, so not listed). */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const [, attrs, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (/\bsrc=/.test(attrs) || /type="application\/(ld\+)?json"/.test(attrs) || body === '') {
      continue;
    }
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

function pinInlineScripts(files: string[]): void {
  const hashes = new Set(files.flatMap((f) => inlineScriptHashes(readFileSync(f, 'utf8'))));
  const headersFile = join(OUT_DIR, '_headers');
  const headers = readFileSync(headersFile, 'utf8');
  const placeholder = "script-src 'self' INLINE_SCRIPT_HASHES";
  if (!headers.includes(placeholder)) {
    throw new Error(`_headers has no "${placeholder}"`);
  }
  writeFileSync(headersFile, headers.replace(placeholder, `script-src 'self' ${[...hashes].sort().join(' ')}`));
}

function main(): void {
  if (!existsSync(join(OUT_DIR, 'index.html'))) {
    throw new Error(`No build output in ${OUT_DIR}; run vite build first.`);
  }
  // Deepest first, so `/docs/decisions/x` moves out before `/docs/decisions` is looked at.
  const routes = [...allRoutes()].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const route of routes) {
    flatten(route);
  }
  const notFound = join(OUT_DIR, htmlFileFor(NOT_FOUND_ROUTE));
  renameSync(notFound, join(OUT_DIR, '404.html'));

  for (const route of allRoutes().filter((r) => r !== NOT_FOUND_ROUTE)) {
    const file = join(OUT_DIR, htmlFileFor(route));
    const html = readFileSync(file, 'utf8');
    if (!html.includes('<h1')) {
      throw new Error(`${route} has no <h1>: prerender probably failed`);
    }
  }

  pinInlineScripts(allRoutes().filter((r) => r !== NOT_FOUND_ROUTE).map((r) => join(OUT_DIR, htmlFileFor(r))).concat(join(OUT_DIR, '404.html')));

  const today = new Date().toISOString().slice(0, 10);
  const urls = sitemapRoutes()
    .map((r) => `  <url><loc>${SITE_URL}${r === '/' ? '/' : r}</loc><lastmod>${today}</lastmod></url>`)
    .join('\n');
  writeFileSync(
    join(OUT_DIR, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
  );
  rmSync(join(WEBSITE_ROOT, 'dist', 'client'), { recursive: true, force: true });
  console.log(`postbuild: ${allRoutes().length} routes prerendered, sitemap with ${sitemapRoutes().length} URLs`);
}

if (import.meta.main) {
  main();
}
