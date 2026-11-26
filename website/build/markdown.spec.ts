import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { brokenRedirects } from '../scripts/postbuild.ts';
import { editUrl, type RewriteContext, rewriteUrl, routeForFile, slugForFile } from './doc-paths.ts';
import { BRANCH, buildNav, listDocFiles, MEDIA_BASE, parseComponents, readDoc, REPO_URL } from './docs-source.ts';
import { githubSlug, renderMarkdown, rewriteHtml, truncate } from './markdown.ts';
import { allRoutes } from './routes.ts';

const known = new Set([
  'README.md',
  'PROTOCOL.md',
  'SECURITY.md',
  'decisions/README.md',
  'decisions/0001-noise-ik-per-request.md',
]);

function ctx(docFile: string): RewriteContext {
  return { docFile, knownDocs: known, repoUrl: REPO_URL, branch: BRANCH, mediaBase: MEDIA_BASE };
}

describe('slugs and routes', () => {
  it('maps files to routes, README to its folder', () => {
    expect(slugForFile('PROTOCOL.md')).toBe('protocol');
    expect(slugForFile('README.md')).toBe('');
    expect(slugForFile('decisions/README.md')).toBe('decisions');
    expect(routeForFile('decisions/0001-noise-ik-per-request.md')).toBe('/docs/decisions/0001-noise-ik-per-request');
    expect(routeForFile('README.md')).toBe('/docs');
  });

  it('builds the edit link', () => {
    expect(editUrl('decisions/README.md', REPO_URL, 'main')).toBe(`${REPO_URL}/edit/main/docs/decisions/README.md`);
  });
});

describe('rewriteUrl', () => {
  it('turns links between docs into routes and keeps the fragment', () => {
    expect(rewriteUrl('PROTOCOL.md', ctx('README.md')).url).toBe('/docs/protocol');
    expect(rewriteUrl('SECURITY.md#what-the-agent-can-do', ctx('PROTOCOL.md')).url).toBe(
      '/docs/security#what-the-agent-can-do',
    );
    expect(rewriteUrl('decisions/0001-noise-ik-per-request.md', ctx('PROTOCOL.md')).url).toBe(
      '/docs/decisions/0001-noise-ik-per-request',
    );
    expect(rewriteUrl('0001-noise-ik-per-request.md', ctx('decisions/README.md')).url).toBe(
      '/docs/decisions/0001-noise-ik-per-request',
    );
    expect(rewriteUrl('../PROTOCOL.md', ctx('decisions/README.md')).url).toBe('/docs/protocol');
    expect(rewriteUrl('decisions/README.md', ctx('README.md')).url).toBe('/docs/decisions');
  });

  it('makes a bare fragment absolute, since #x alone would leave the page', () => {
    expect(rewriteUrl('#test-vectors', ctx('PROTOCOL.md')).url).toBe('/docs/protocol#test-vectors');
    expect(rewriteUrl('#x', ctx('README.md')).url).toBe('/docs#x');
  });

  it('serves images of docs/ from the media path', () => {
    expect(rewriteUrl('screenshots/05-overview-red.png', ctx('README.md'))).toEqual({
      url: '/docs-media/screenshots/05-overview-red.png',
      media: 'screenshots/05-overview-red.png',
    });
    expect(rewriteUrl('../communication.png', ctx('decisions/README.md')).url).toBe('/docs-media/communication.png');
  });

  it('sends everything else in the repository to GitHub', () => {
    expect(rewriteUrl('../README.md', ctx('README.md')).url).toBe(`${REPO_URL}/blob/main/README.md`);
    expect(rewriteUrl('../protocol/test/vectors.json', ctx('PROTOCOL.md')).url).toBe(
      `${REPO_URL}/blob/main/protocol/test/vectors.json`,
    );
    expect(rewriteUrl('../agent/src', ctx('PROTOCOL.md')).url).toBe(`${REPO_URL}/tree/main/agent/src`);
    expect(rewriteUrl('../scripts/diagrams/render.mjs', ctx('README.md')).url).toBe(
      `${REPO_URL}/blob/main/scripts/diagrams/render.mjs`,
    );
    expect(rewriteUrl('UNKNOWN.md', ctx('README.md')).url).toBe(`${REPO_URL}/blob/main/docs/UNKNOWN.md`);
  });

  it('leaves absolute and site-absolute URLs alone', () => {
    for (const url of ['https://noiseprotocol.org/noise.html', 'mailto:a@b.c', '//cdn.example/x', '/docs/api']) {
      expect(rewriteUrl(url, ctx('PROTOCOL.md')).url).toBe(url);
    }
  });
});

describe('rewriteHtml', () => {
  const size = (file: string) => (file === 'screenshots/a.png' ? { width: 780, height: 1308 } : undefined);

  it('rewrites href and src in raw HTML too and sizes images', () => {
    const { html, media } = rewriteHtml(
      '<p><a href="PROTOCOL.md">p</a></p><img src="screenshots/a.png" alt="A">',
      ctx('README.md'),
      size,
    );
    expect(html).toContain('href="/docs/protocol"');
    expect(html).toContain('src="/docs-media/screenshots/a.png"');
    expect(html).toContain('width="780" height="1308"');
    expect(html).toContain('loading="lazy"');
    expect(media).toEqual(['screenshots/a.png']);
  });

  it('derives the height when only the width is given', () => {
    const { html } = rewriteHtml('<img src="screenshots/a.png" alt="A" width="390">', ctx('README.md'), size);
    expect(html).toContain('width="390"');
    expect(html).toContain('height="654"');
  });

  it('keeps escaped ampersands in query strings', () => {
    const { html } = rewriteHtml('<a href="https://x.test/?a=1&amp;b=2">x</a>', ctx('README.md'));
    expect(html).toContain('href="https://x.test/?a=1&amp;b=2"');
  });
});

describe('renderMarkdown', () => {
  const source = [
    '# The protocol',
    '',
    'How the app talks to an agent, end to end, on every path: VPN, LAN or ingress.',
    '',
    '## Keys, pairing and the end-to-end channel',
    '',
    'See [the vectors](#test-vectors) and [security](SECURITY.md).',
    '',
    '### Message 1 (device to agent)',
    '',
    '| Field | Meaning |',
    '|---|---|',
    '| `m` | method |',
    '',
    '```sh',
    'helm install kubernanny',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  a --> b',
    '```',
    '',
    '## Test vectors',
    '',
    '## Test vectors',
  ].join('\n');
  const doc = renderMarkdown(source, { ctx: ctx('PROTOCOL.md') });

  it('takes the title and description from the text', () => {
    expect(doc.title).toBe('The protocol');
    expect(doc.description).toMatch(/^How the app talks to an agent/);
  });

  it('gives headings GitHub ids and builds the table of contents', () => {
    expect(doc.toc).toEqual([
      { id: 'keys-pairing-and-the-end-to-end-channel', text: 'Keys, pairing and the end-to-end channel', level: 2 },
      { id: 'message-1-device-to-agent', text: 'Message 1 (device to agent)', level: 3 },
      { id: 'test-vectors', text: 'Test vectors', level: 2 },
      { id: 'test-vectors-1', text: 'Test vectors', level: 2 },
    ]);
    expect(doc.html).toContain('<h2 id="keys-pairing-and-the-end-to-end-channel">');
  });

  it('rewrites links, wraps tables and code, and marks mermaid', () => {
    expect(doc.html).toContain('href="/docs/protocol#test-vectors"');
    expect(doc.html).toContain('href="/docs/security"');
    expect(doc.html).toContain('<div class="table-wrap"><table>');
    expect(doc.html).toContain('data-copy');
    expect(doc.html).toContain('<pre class="mermaid">flowchart LR\n  a --&gt; b</pre>');
    expect(doc.hasMermaid).toBe(true);
  });

  it('cuts long descriptions at a word', () => {
    expect(truncate('word '.repeat(60), 30)).toMatch(/^(word ){4}word…$/);
  });

  it('matches GitHub slugs for punctuation and repeats', () => {
    const seen = new Map<string, number>();
    expect(githubSlug('From issues to a light and a score', seen)).toBe('from-issues-to-a-light-and-a-score');
    expect(githubSlug('Why IK, why `one` call?', seen)).toBe('why-ik-why-one-call');
    expect(githubSlug('Why IK, why `one` call?', seen)).toBe('why-ik-why-one-call-1');
  });
});

describe('the real docs/ folder', () => {
  const files = listDocFiles();
  const knownDocs = new Set(files);
  const routes = new Set(allRoutes());

  it('renders every page with a title, and every internal link lands on a prerendered route and heading', () => {
    const rendered = files.map((file) => ({
      route: routeForFile(file),
      doc: renderMarkdown(readDoc(file), {
        ctx: { docFile: file, knownDocs, repoUrl: REPO_URL, branch: BRANCH, mediaBase: MEDIA_BASE },
      }),
    }));
    const ids = new Map(
      rendered.map((r) => [r.route, new Set([...r.doc.html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]))]),
    );
    for (const { route, doc } of rendered) {
      expect(doc.title, route).not.toBe('');
      // Every raw tag the docs use passes the allowlist (raw-html.ts) instead of showing as text.
      const outsideCode = doc.html.replace(/<pre[\s\S]*?<\/pre>/g, '').replace(/<code>[\s\S]*?<\/code>/g, '');
      expect(outsideCode, route).not.toMatch(/&lt;\/?(img|td|tr|table|br|sub|p|details|summary)\b/);
      for (const [, path, fragment] of doc.html.matchAll(/href="(\/[^"#]*)(?:#([^"]*))?"/g)) {
        if (path.startsWith('/docs-media/')) {
          continue;
        }
        expect(routes.has(path), `${route} links to ${path}`).toBe(true);
        if (fragment && ids.has(path)) {
          expect(ids.get(path)?.has(fragment), `${route} links to ${path}#${fragment}`).toBe(true);
        }
      }
    }
  });

  it('puts docs that are not configured into "More"', () => {
    const nav = buildNav([...files, 'NEW-THING.md'], (f) => f);
    expect(nav.at(-1)?.title).toBe('More');
    expect(nav.at(-1)?.items.map((i) => i.file)).toContain('NEW-THING.md');
  });

  it('reads the component catalog from COMPONENTS.md', () => {
    const groups = parseComponents(readDoc('COMPONENTS.md'));
    const all = groups.flatMap((g) => g.components);
    expect(all.length).toBeGreaterThan(50);
    expect(all.find((c) => c.name === 'Longhorn')?.deep).toBe(true);
  });
});

describe('raw HTML in the docs', () => {
  const render = (source: string) => renderMarkdown(source, { ctx: ctx('README.md') }).html;

  it('keeps the few tags the docs use, with their allowed attributes', () => {
    const html = render(
      '<table>\n<tr>\n<td valign="top" width="50%"><img src="https://example.com/a.png" alt="A “quoted” shot" width="300"><br><sub>Caption</sub></td>\n</tr>\n</table>\n',
    );
    expect(html).toContain('<td valign="top" width="50%">');
    expect(html).toContain('<img src="https://example.com/a.png" alt="A “quoted” shot" width="300"');
    expect(html).toContain('<br><sub>Caption</sub></td>');
  });

  it('escapes everything else, so no markup a doc carries can run', () => {
    const html = render(
      'Hi <script>alert(1)</script> and <img src="x" onerror="alert(1)"> and <a href="javascript:alert(1)">x</a>\n\n<iframe src="https://evil.example"></iframe>\n\n<img src="javascript:alert(1)">\n',
    );
    expect(html).not.toMatch(/<script|<iframe|<a href="javascript|onerror="|<img src="javascript/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;iframe');
  });

  it('drops comments and shows placeholders like <name> as text', () => {
    const html = render('<!-- generated:write -->\nUse kubectl get <name> here.\n');
    expect(html).not.toContain('generated:write');
    expect(html).toContain('&lt;name&gt;');
  });
});

describe('pages that left the site', () => {
  it('keeps maintainer pages off the site and sends their old URL to GitHub', () => {
    expect(listDocFiles()).not.toContain('RELEASING.md');
    expect(allRoutes()).not.toContain('/docs/releasing');
    const redirects = readFileSync(new URL('../public/_redirects', import.meta.url), 'utf8');
    expect(redirects).toContain(
      '/docs/releasing https://github.com/kubernanny/kubernanny/blob/main/docs/RELEASING.md 301',
    );
    expect(brokenRedirects(redirects, allRoutes())).toEqual([]);
  });

  it('refuses a redirect from a live page or to a missing one', () => {
    expect(brokenRedirects('/docs /docs/x 301\n/old /docs 301\n/gone https://example.com 301', ['/docs'])).toEqual([
      '/docs /docs/x 301',
    ]);
    expect(brokenRedirects('/old /docs/missing 301', ['/docs'])).toEqual(['/old /docs/missing 301']);
  });
});
