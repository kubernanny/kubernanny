import { docRoutes } from './docs-source.ts';

/** Pages that are not docs. `/404` is rendered once and served by the host for unknown paths. */
export const STATIC_ROUTES = ['/', '/imprint', '/privacy'];
export const NOT_FOUND_ROUTE = '/404';
/** Prerendered, but noindex and not in the sitemap: it shows a pairing link from the fragment, nothing to find. */
export const QR_ROUTE = '/qr';

/** Every route the build prerenders. */
export function allRoutes(): string[] {
  return [...STATIC_ROUTES, QR_ROUTE, ...docRoutes(), NOT_FOUND_ROUTE];
}

/** Every route that belongs in the sitemap. */
export function sitemapRoutes(): string[] {
  return [...STATIC_ROUTES, ...docRoutes()];
}
