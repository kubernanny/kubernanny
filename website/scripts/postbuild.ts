/**
 * After `vite build`: turns the prerendered `route/index.html` files into
 * `route.html` (Cloudflare Pages serves those at `/route` without a redirect),
 * moves the not-found page to `404.html`, writes `sitemap.xml`, and fails the
 * build if any route did not prerender.
 */
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
