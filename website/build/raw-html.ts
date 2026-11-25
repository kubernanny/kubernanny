/**
 * Raw HTML inside the docs, passed through an allowlist at build time. The
 * site renders the docs with [innerHTML] (bypassing Angular's sanitizer,
 * which would strip the ids and data attributes the renderer adds), so
 * nothing in a markdown file may reach the page as markup unless it is one
 * of the few tags the docs actually use (screenshot tables, line breaks,
 * captions). Everything else is escaped and shows as text; comments go.
 */
import { escapeHtml } from './markdown.ts';

/** Tag -> the attributes it may carry. */
const ALLOWED: Record<string, readonly string[]> = {
  img: ['src', 'alt', 'width', 'height'],
  p: [],
  br: [],
  sub: [],
  sup: [],
  code: [],
  details: [],
  summary: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ['valign', 'width', 'align', 'colspan', 'rowspan'],
  td: ['valign', 'width', 'align', 'colspan', 'rowspan'],
};

const TAG = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z-]+(?:="[^"<>]*")?)*)\s*(\/?)>/g;
const ATTR = /([a-zA-Z-]+)(?:="([^"<>]*)")?/g;

/** Only relative paths and http(s): the rewrite step turns doc paths into site URLs afterwards. */
function safeSrc(value: string): boolean {
  return !/^\s*[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || /^\s*https?:/i.test(value);
}

function allowedTag(close: string, name: string, attrs: string, selfClose: string): string | null {
  const tag = name.toLowerCase();
  const allowed = ALLOWED[tag];
  if (!allowed) {
    return null;
  }
  if (close) {
    return attrs.trim() || selfClose ? null : `</${tag}>`;
  }
  const out: string[] = [];
  for (const [, rawName, value] of attrs.matchAll(ATTR)) {
    const attr = rawName.toLowerCase();
    if (!allowed.includes(attr) || value === undefined || (attr === 'src' && !safeSrc(value))) {
      return null;
    }
    out.push(` ${attr}="${escapeHtml(value.replace(/&quot;/g, '"').replace(/&amp;/g, '&'))}"`);
  }
  return `<${tag}${out.join('')}>`;
}

export function sanitizeRawHtml(raw: string): string {
  let out = '';
  let last = 0;
  for (const m of raw.matchAll(TAG)) {
    out += escapeText(raw.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[0].startsWith('<!--')) {
      continue;
    }
    out += allowedTag(m[1], m[2], m[3], m[4]) ?? escapeHtml(m[0]);
  }
  return out + escapeText(raw.slice(last));
}

/** Text between tags: a stray `<` or `>` must not start markup; entities stay as written. */
function escapeText(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
