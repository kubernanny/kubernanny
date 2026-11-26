/**
 * Serves `docs/` to the Angular app as virtual modules:
 *
 * - `virtual:kubernanny-docs`: the sidebar and a lazy loader per page
 * - `virtual:kubernanny-doc/<slug>`: one rendered page (its own chunk)
 * - `virtual:kubernanny-components`: the component catalog from COMPONENTS.md
 *
 * and emits the images of `docs/` under `/docs-media/`.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

import { createHighlighter, type Highlighter } from 'shiki';
import type { Plugin, ViteDevServer } from 'vite';

import { editUrl, type RewriteContext, routeForFile, slugForFile } from './doc-paths.ts';
import {
  BRANCH,
  buildNav,
  DOCS_DIR,
  listDocFiles,
  MEDIA_BASE,
  type NavEntry,
  parseComponents,
  readDoc,
  REPO_URL,
} from './docs-source.ts';
import { type RenderedDoc, renderMarkdown } from './markdown.ts';

const INDEX_ID = 'virtual:kubernanny-docs';
const DOC_PREFIX = 'virtual:kubernanny-doc/';
const COMPONENTS_ID = 'virtual:kubernanny-components';
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif)$/i;
const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

/** Width and height from a PNG header; other formats get no size. */
export function pngSize(buffer: Buffer): { width: number; height: number } | undefined {
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) {
    return undefined;
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function listImages(dir = DOCS_DIR): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (IMAGE.test(entry.name)) {
        out.push(relative(dir, full).split(sep).join('/'));
      }
    }
  };
  walk(dir);
  return out.sort();
}

let highlighterPromise: Promise<Highlighter> | undefined;
function highlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: ['sh', 'json', 'jsonc', 'yaml', 'ts', 'js', 'html', 'css', 'dockerfile', 'diff'],
  });
  return highlighterPromise;
}

interface Rendered {
  file: string;
  doc: RenderedDoc;
}

async function renderAll(): Promise<Rendered[]> {
  const hl = await highlighter();
  const files = listDocFiles();
  const known = new Set(files);
  const highlight = (code: string, lang: string) => {
    const loaded = hl.getLoadedLanguages().includes(lang) ? lang : 'text';
    return hl.codeToHtml(code, {
      lang: loaded,
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    });
  };
  const mediaSize = (file: string) => {
    const full = join(DOCS_DIR, file);
    return existsSync(full) ? pngSize(readFileSync(full)) : undefined;
  };
  return files.map((file) => {
    const ctx: RewriteContext = {
      docFile: file,
      knownDocs: known,
      repoUrl: REPO_URL,
      branch: BRANCH,
      mediaBase: MEDIA_BASE,
    };
    return { file, doc: renderMarkdown(readDoc(file), { ctx, highlight, mediaSize }) };
  });
}

function navOf(rendered: Rendered[]) {
  const titles = new Map(rendered.map((r) => [r.file, r.doc.title]));
  return buildNav(
    rendered.map((r) => r.file),
    (file) => titles.get(file) ?? file,
  );
}

function link(entry: NavEntry | undefined) {
  return entry ? { route: entry.route, label: entry.label } : null;
}

export function docsPlugin(): Plugin {
  let server: ViteDevServer | undefined;
  let cache: Promise<Rendered[]> | undefined;
  const rendered = () => (cache ??= renderAll());

  return {
    name: 'kubernanny-docs',
    enforce: 'pre',

    resolveId(id) {
      if (id === INDEX_ID || id === COMPONENTS_ID || id.startsWith(DOC_PREFIX)) {
        return '\0' + id;
      }
      return null;
    },

    async load(id) {
      if (!id.startsWith('\0virtual:kubernanny-')) {
        return null;
      }
      const vid = id.slice(1);
      this.addWatchFile(DOCS_DIR);
      for (const file of listDocFiles()) {
        this.addWatchFile(join(DOCS_DIR, file));
      }

      if (vid === COMPONENTS_ID) {
        const groups = parseComponents(readDoc('COMPONENTS.md'));
        return `export const componentGroups = ${JSON.stringify(groups)};`;
      }

      const all = await rendered();
      const nav = navOf(all);

      if (vid === INDEX_ID) {
        const loaders = all
          .map(
            (r) =>
              `  ${JSON.stringify(slugForFile(r.file))}: () => import(${JSON.stringify(DOC_PREFIX + slugForFile(r.file))}),`,
          )
          .join('\n');
        return [
          `export const docNav = ${JSON.stringify(nav)};`,
          `export const docRoutes = ${JSON.stringify(all.map((r) => routeForFile(r.file)))};`,
          `const loaders = {\n${loaders}\n};`,
          `export async function loadDoc(slug) {`,
          `  const load = Object.prototype.hasOwnProperty.call(loaders, slug) ? loaders[slug] : undefined;`,
          `  return load ? (await load()).default : undefined;`,
          `}`,
        ].join('\n');
      }

      const slug = vid.slice(DOC_PREFIX.length);
      const entry = all.find((r) => slugForFile(r.file) === slug);
      if (!entry) {
        return 'export default undefined;';
      }
      const order = nav.flatMap((g) => g.items);
      const index = order.findIndex((e) => e.file === entry.file);
      const page = {
        slug,
        route: routeForFile(entry.file),
        file: entry.file,
        title: entry.doc.title,
        description: entry.doc.description,
        html: entry.doc.html,
        toc: entry.doc.toc,
        hasMermaid: entry.doc.hasMermaid,
        editUrl: editUrl(entry.file, REPO_URL, BRANCH),
        sourceUrl: `${REPO_URL}/blob/${BRANCH}/docs/${entry.file}`,
        inNav: index >= 0,
        section: nav.find((g) => g.items.some((i) => i.file === entry.file))?.title ?? null,
        prev: index > 0 ? link(order[index - 1]) : null,
        next: index >= 0 ? link(order[index + 1]) : null,
      };
      return `export default ${JSON.stringify(page)};`;
    },

    configureServer(devServer) {
      server = devServer;
      devServer.watcher.add(DOCS_DIR);
      devServer.watcher.on('change', (file) => {
        if (file.startsWith(DOCS_DIR) && file.endsWith('.md')) {
          cache = undefined;
          for (const mod of [...devServer.moduleGraph.idToModuleMap.values()]) {
            if (mod.id?.startsWith('\0virtual:kubernanny-')) {
              devServer.moduleGraph.invalidateModule(mod);
            }
          }
          devServer.ws.send({ type: 'full-reload' });
        }
      });
      devServer.middlewares.use(MEDIA_BASE, (req, res, next) => {
        const file = decodeURI((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
        const full = join(DOCS_DIR, file);
        if (!IMAGE.test(file) || file.includes('..') || !existsSync(full) || !statSync(full).isFile()) {
          next();
          return;
        }
        res.setHeader('Content-Type', MIME[extname(file).toLowerCase()] ?? 'application/octet-stream');
        res.end(readFileSync(full));
      });
    },

    generateBundle() {
      // Only the browser build ships files; the server build just renders.
      const env = (this as unknown as { environment?: { config: { consumer?: string } } }).environment;
      if (server || env?.config.consumer === 'server') {
        return;
      }
      for (const image of listImages()) {
        this.emitFile({
          type: 'asset',
          fileName: MEDIA_BASE.slice(1) + image,
          source: readFileSync(join(DOCS_DIR, image)),
        });
      }
    },
  };
}
