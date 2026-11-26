// The encoder alone: the package's entry point pulls in its PNG and file renderers, which need Node.
import { create } from 'qrcode/lib/core/qrcode';

/** What the /qr page shows for a fragment. */
export type QrPayload = { kind: 'none' } | { kind: 'invalid' } | { kind: 'pair'; link: string; name: string };

/**
 * The fragment of https://kubernanny.app/qr#<link> -> what to draw. Only a
 * pairing link as the agent prints it counts, checked like the app checks one
 * (app/src/app/core/pairing-link.ts): scheme and host exactly
 * `kubernanny://pair`, an http(s) `url`, a `code`, and if present a `key` of
 * 43 base64url characters. Anything else is refused, so the page cannot be
 * used to put an arbitrary code on kubernanny.app.
 */
export function parseQrFragment(hash: string): QrPayload {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw.trim()) {
    return { kind: 'none' };
  }
  let link: string;
  try {
    // The agent sends encodeURIComponent(link). Angular's router rewrites the
    // address to encodeURI(link) once the page starts, and decodeURI undoes
    // that; it never decodes reserved characters, so a link pasted by hand
    // keeps its own encoding too.
    link = (raw.startsWith('kubernanny:') ? decodeURI(raw) : decodeURIComponent(raw)).trim();
  } catch {
    return { kind: 'invalid' };
  }
  try {
    const u = new URL(link);
    if (u.protocol !== 'kubernanny:' || u.hostname !== 'pair' || (u.pathname !== '' && u.pathname !== '/') || u.hash) {
      return { kind: 'invalid' };
    }
    const url = u.searchParams.get('url');
    const code = u.searchParams.get('code');
    const key = u.searchParams.get('key');
    if (
      !url ||
      !/^https?:\/\//.test(url) ||
      !code?.trim() ||
      (key !== null && !/^[A-Za-z0-9_-]{43}$/.test(key)) ||
      link.length > 1000
    ) {
      return { kind: 'invalid' };
    }
    return { kind: 'pair', link, name: (u.searchParams.get('name') ?? '').slice(0, 64) };
  } catch {
    return { kind: 'invalid' };
  }
}

/** The QR code of `text` as one SVG path (dark modules), with the quiet zone inside the view box. */
export function qrSvgPath(text: string, quiet = 4): { size: number; path: string } {
  const { modules } = create(text, { errorCorrectionLevel: 'M' });
  const n = modules.size;
  let path = '';
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!modules.get(y, x)) {
        x++;
        continue;
      }
      const start = x;
      while (x < n && modules.get(y, x)) {
        x++;
      }
      // One rectangle per run of dark modules in a row.
      path += `M${start + quiet} ${y + quiet}h${x - start}v1h${start - x}z`;
    }
  }
  return { size: n + 2 * quiet, path };
}
