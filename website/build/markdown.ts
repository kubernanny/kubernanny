/**
 * Markdown to HTML at build time. The site ships the result as plain HTML;
 * the browser never parses markdown.
 */
import { Marked, Renderer, type Tokens } from 'marked';

import { type RewriteContext, rewriteUrl } from './doc-paths.ts';
import { sanitizeRawHtml } from './raw-html.ts';

export interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface RenderedDoc {
  title: string;
  description: string;
  html: string;
  toc: TocEntry[];
  hasMermaid: boolean;
  /** Images inside `docs/` the page references (relative to `docs/`). */
  media: string[];
}

export type Highlight = (code: string, lang: string) => string;
export type MediaSize = (file: string) => { width: number; height: number } | undefined;

export interface RenderOptions {
  ctx: RewriteContext;
  highlight?: Highlight;
  mediaSize?: MediaSize;
}

/** GitHub's heading ids, so links written for GitHub keep working. */
export function githubSlug(text: string, seen: Map<string, number>): string {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, '')
    .replace(/ /g, '-');
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: ' ' };

export function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (m, name: string) => ENTITIES[name] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Cuts at a word boundary so meta descriptions stay under ~160 characters. */
export function truncate(text: string, max = 160): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.slice(0, max - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max / 2)).replace(/[,:;.\s]+$/, '') + '…';
}

/**
 * Rewrites every `href` and `src` in rendered HTML, markdown links and raw
 * HTML alike, and gives images inside `docs/` their intrinsic size (no layout
 * shift) and lazy loading.
 */
export function rewriteHtml(
  html: string,
  ctx: RewriteContext,
  mediaSize?: MediaSize,
): { html: string; media: string[] } {
  const media = new Set<string>();
  let out = html.replace(/\b(href|src)="([^"]*)"/g, (_m, attr: string, value: string) => {
    const decoded = value.replace(/&amp;/g, '&');
    const rewritten = rewriteUrl(decoded, ctx);
    if (rewritten.media) {
      media.add(rewritten.media);
    }
    return `${attr}="${rewritten.url.replace(/&/g, '&amp;')}"`;
  });

  out = out.replace(/<img\b([^>]*?)\s*\/?>/g, (_m, attrs: string) => {
    let a = attrs;
    const src = /\bsrc="([^"]*)"/.exec(a)?.[1] ?? '';
    const file = src.startsWith(ctx.mediaBase) ? decodeURI(src.slice(ctx.mediaBase.length)) : undefined;
    const size = file ? mediaSize?.(file) : undefined;
    if (size) {
      const width = /\bwidth="(\d+)"/.exec(a)?.[1];
      const height = /\bheight="(\d+)"/.exec(a)?.[1];
      if (!width && !height) {
        a += ` width="${size.width}" height="${size.height}"`;
      } else if (width && !height) {
        a += ` height="${Math.round((Number(width) * size.height) / size.width)}"`;
      }
    }
    if (!/\bloading=/.test(a)) {
      a += ' loading="lazy"';
    }
    if (!/\bdecoding=/.test(a)) {
      a += ' decoding="async"';
    }
    if (!/\balt=/.test(a)) {
      a += ' alt=""';
    }
    return `<img${a}>`;
  });

  return { html: out, media: [...media] };
}

export function renderMarkdown(source: string, options: RenderOptions): RenderedDoc {
  const seen = new Map<string, number>();
  const toc: TocEntry[] = [];
  let title = '';
  let description = '';
  let hasMermaid = false;
  const highlight = options.highlight ?? ((code: string) => `<pre><code>${escapeHtml(code)}</code></pre>`);

  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading(this: Renderer, token: Tokens.Heading) {
        const inner = this.parser.parseInline(token.tokens);
        const text = htmlToText(inner);
        const id = githubSlug(text, seen);
        if (token.depth === 1 && !title) {
          title = text;
          return `<h1 id="${id}">${inner}</h1>\n`;
        }
        if (token.depth === 2 || token.depth === 3) {
          toc.push({ id, text, level: token.depth });
        }
        const anchor = `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>`;
        return `<h${token.depth} id="${id}">${inner}${anchor}</h${token.depth}>\n`;
      },
      code(token: Tokens.Code) {
        const lang = (token.lang ?? '').trim().split(/\s+/)[0].toLowerCase();
        if (lang === 'mermaid') {
          hasMermaid = true;
          return `<div class="mermaid-block"><pre class="mermaid">${escapeHtml(token.text)}</pre></div>\n`;
        }
        const label = lang || 'text';
        return (
          `<div class="code-block" data-lang="${escapeHtml(label)}">` +
          `<div class="code-head"><span class="code-lang">${escapeHtml(label)}</span>` +
          `<button type="button" class="copy-btn" data-copy>Copy</button></div>` +
          `${highlight(token.text, label)}</div>\n`
        );
      },
      // Raw HTML in a doc, block or inline: only the allowlisted tags survive (raw-html.ts).
      html(token: Tokens.HTML | Tokens.Tag) {
        return sanitizeRawHtml(token.text);
      },
      table(this: Renderer, token: Tokens.Table) {
        return `<div class="table-wrap">${Renderer.prototype.table.call(this, token)}</div>\n`;
      },
      paragraph(this: Renderer, token: Tokens.Paragraph) {
        const inner = this.parser.parseInline(token.tokens);
        if (!description) {
          const text = htmlToText(inner);
          // Skip status lines and image-only paragraphs.
          if (text.length > 40) {
            description = truncate(text);
          }
        }
        return `<p>${inner}</p>\n`;
      },
    },
  });

  const raw = marked.parse(source, { async: false });
  const { html, media } = rewriteHtml(raw, options.ctx, options.mediaSize);
  return { title, description, html, toc, hasMermaid, media };
}
