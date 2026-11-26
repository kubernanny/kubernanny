import { relayUrlAllowed } from './relay-route';

/** What a pairing link carries, as the /pair page's query parameters. */
export interface PairingLinkParams {
  url: string;
  code: string;
  name?: string;
  key?: string;
  relay?: string;
}

/**
 * "kubernanny://pair?url=…&code=…&key=…[&relay=…]" -> the /pair page's params,
 * or null for anything else. Only the exact host `pair` counts. The link
 * comes from outside the app (any website, QR code or app can open it), so
 * the page it leads to never connects before the person confirmed what it shows.
 */
export function pairingRoute(link: string): PairingLinkParams | null {
  try {
    const u = new URL(link);
    if (
      u.protocol !== 'kubernanny:' ||
      u.hostname !== 'pair' ||
      (u.pathname !== '' && u.pathname !== '/')
    ) {
      return null;
    }
    const url = u.searchParams.get('url');
    const code = u.searchParams.get('code');
    const key = u.searchParams.get('key') ?? undefined;
    if (
      !url ||
      !code ||
      !/^https?:\/\//.test(url) ||
      (key !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(key))
    ) {
      return null;
    }
    // The relay only counts next to a key: without one the app fetches the key directly, never through a relay.
    const relay = u.searchParams.get('relay');
    const withRelay = key && relay && relayUrlAllowed(relay) ? { relay } : {};
    return {
      url,
      code,
      name: u.searchParams.get('name') ?? undefined,
      ...(key ? { key } : {}),
      ...withRelay,
    };
  } catch {
    return null;
  }
}

/**
 * A scanned QR code -> the /pair page's params, or null for anything else.
 * Takes the two links the agent prints: the app link (the QR code in its log)
 * and the web UI's `<agent>/#/pair?code&name&key[&relay]`, whose address is
 * everything before the `#`. Both go through pairingRoute(), so a scanned
 * code is held to exactly the rules of a link the system opens.
 */
export function scannedPairingRoute(text: string): PairingLinkParams | null {
  const value = text.trim();
  if (value.startsWith('kubernanny:')) {
    return pairingRoute(value);
  }
  const web = /^(https?:\/\/[^#]+)#\/pair\?(.*)$/i.exec(value);
  if (!web) {
    return null;
  }
  try {
    const base = new URL(web[1]);
    if (base.search || base.username || base.password) {
      return null;
    }
    const query = new URLSearchParams(web[2]);
    // The agent's address is where the web UI lives, never a `url` the fragment names.
    query.set('url', `${base.origin}${base.pathname}`.replace(/\/+$/, ''));
    return pairingRoute(`kubernanny://pair?${query}`);
  } catch {
    return null;
  }
}
