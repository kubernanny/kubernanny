/**
 * Serves the built site the way Cloudflare Pages does: `/route` -> `route.html`,
 * `/dir/` -> `dir/index.html`, anything else -> `404.html` with status 404.
 * `npm run preview`; also used by the screenshot script.
 */
import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { OUT_DIR } from './postbuild.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function resolveFile(urlPath: string): string | undefined {
  const path = normalize(decodeURIComponent(urlPath)).replace(/^(\.\.[/\\])+/, '');
  const candidates = [path, `${path.replace(/\/$/, '')}.html`, join(path, 'index.html')];
  for (const c of candidates) {
    const full = join(OUT_DIR, c);
    if (full.startsWith(OUT_DIR) && existsSync(full) && statSync(full).isFile()) {
      return full;
    }
  }
  return undefined;
}

export function serve(port = 4321): Promise<Server> {
  const server = createServer((req, res) => {
    const urlPath = (req.url ?? '/').split(/[?#]/)[0];
    const file = resolveFile(urlPath === '/' ? '/index.html' : urlPath);
    const target = file ?? join(OUT_DIR, '404.html');
    res.writeHead(file ? 200 : 404, { 'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream' });
    res.end(readFileSync(target));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (import.meta.main) {
  const port = Number(process.env['PORT'] ?? 4321);
  await serve(port);
  console.log(`Serving ${OUT_DIR} on http://127.0.0.1:${port}`);
}
