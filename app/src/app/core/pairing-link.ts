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
    if (u.protocol !== 'kubernanny:' || u.hostname !== 'pair' || (u.pathname !== '' && u.pathname !== '/')) {
      return null;
    }
    const url = u.searchParams.get('url');
    const code = u.searchParams.get('code');
    const key = u.searchParams.get('key') ?? undefined;
    if (!url || !code || !/^https?:\/\//.test(url) || (key !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(key))) {
      return null;
    }
    // The relay only counts next to a key: without one the app fetches the key directly, never through a relay.
    const relay = u.searchParams.get('relay');
    const withRelay = key && relay && relayUrlAllowed(relay) ? { relay } : {};
    return { url, code, name: u.searchParams.get('name') ?? undefined, ...(key ? { key } : {}), ...withRelay };
  } catch {
    return null;
  }
}
