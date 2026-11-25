/**
 * A link that came from an agent (component links, ingress hosts, the web
 * pairing address), made safe to put into an `href`: only http and https
 * pass. Angular's sanitizer already stops `javascript:`, but lets through
 * schemes that open other apps (`intent:`, `file:`, or the app's own
 * `kubernanny://pair`), and an agent is no authority over what this device opens.
 * Every such link is shown with rel="noopener noreferrer".
 */
export function externalUrl(raw: string | null | undefined): string | null {
  if (!raw) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}
