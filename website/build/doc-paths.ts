/**
 * Where a markdown file of `docs/` ends up on the site. Pure, shared by the
 * markdown renderer, the Vite plugin, the prerender route list and the tests.
 */
import { posix } from 'node:path';

/** `PROTOCOL.md` -> `protocol`, `decisions/README.md` -> `decisions`, `README.md` -> `` */
export function slugForFile(file: string): string {
  const withoutExt = file.replace(/\.md$/i, '');
  const parts = withoutExt.split('/');
  if (parts.at(-1)?.toLowerCase() === 'readme') {
    parts.pop();
  }
  return parts.map((p) => p.toLowerCase()).join('/');
}

export function routeForSlug(slug: string): string {
  return slug ? `/docs/${slug}` : '/docs';
}

export function routeForFile(file: string): string {
  return routeForSlug(slugForFile(file));
}

/** The slug of a docs URL path, e.g. `/docs/decisions/0001-x#y` -> `decisions/0001-x`. */
export function slugFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, '');
  return path.replace(/^\/docs\/?/, '');
}

const MEDIA = /\.(png|jpe?g|gif|svg|webp|avif)$/i;

export interface RewriteContext {
  /** The markdown file being rendered, relative to `docs/` (posix). */
  docFile: string;
  /** Every markdown file relative to `docs/`, to tell a doc from another file. */
  knownDocs: ReadonlySet<string>;
  /** `https://github.com/<owner>/<repo>`; files outside `docs/` link there. */
  repoUrl: string;
  /** Git branch for GitHub links. */
  branch: string;
  /** Public URL prefix that serves files of `docs/` such as screenshots. */
  mediaBase: string;
}

export interface RewrittenUrl {
  url: string;
  /** Set when the URL points at an image inside `docs/` (relative to `docs/`). */
  media?: string;
}

/**
 * Turns a link written for GitHub's view of `docs/` into one that works on
 * the site: other docs become routes, images inside `docs/` are served from
 * `mediaBase`, anything else in the repository opens on GitHub.
 *
 * A bare `#fragment` becomes the doc's own route plus the fragment, because
 * the site uses `<base href="/">`, under which `#x` would resolve to `/#x`.
 */
export function rewriteUrl(raw: string, ctx: RewriteContext): RewrittenUrl {
  const url = raw.trim();
  if (url === '' || /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//')) {
    return { url };
  }
  const ownRoute = routeForFile(ctx.docFile);
  if (url.startsWith('#')) {
    return { url: ownRoute + url };
  }
  if (url.startsWith('/')) {
    // Already site-absolute (written for the site, not for GitHub).
    return { url };
  }

  const match = /^([^?#]*)(\?[^#]*)?(#.*)?$/.exec(url);
  const pathPart = decodeURI(match?.[1] ?? url);
  const query = match?.[2] ?? '';
  const hash = match?.[3] ?? '';

  const resolved = posix.normalize(posix.join(posix.dirname(ctx.docFile), pathPart));
  const insideDocs = !resolved.startsWith('../') && resolved !== '..';

  if (insideDocs && ctx.knownDocs.has(resolved)) {
    return { url: routeForFile(resolved) + hash };
  }
  if (insideDocs && MEDIA.test(resolved)) {
    return { url: ctx.mediaBase + encodeURI(resolved), media: resolved };
  }

  const repoPath = insideDocs ? `docs/${resolved}` : resolved.replace(/^(\.\.\/)+/, '');
  const isDirectory = repoPath === '' || repoPath.endsWith('/') || !/\.[a-z0-9]+$/i.test(repoPath);
  const kind = isDirectory ? 'tree' : 'blob';
  const cleanPath = repoPath.replace(/\/$/, '');
  return { url: `${ctx.repoUrl}/${kind}/${ctx.branch}/${encodeURI(cleanPath)}${query}${hash}` };
}

/** The GitHub URL that edits a doc. */
export function editUrl(file: string, repoUrl: string, branch: string): string {
  return `${repoUrl}/edit/${branch}/docs/${file}`;
}
