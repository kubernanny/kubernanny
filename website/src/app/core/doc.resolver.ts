import { inject } from '@angular/core';
import { RedirectCommand, Router, type ResolveFn } from '@angular/router';
import { loadDoc } from 'virtual:kubernanny-docs';
import type { DocPage } from './docs.types';

/** `/docs/decisions/0001-x#y` -> `decisions/0001-x`. */
export function docSlugFromUrl(url: string): string {
  return url
    .split(/[?#]/)[0]
    .replace(/\/+$/, '')
    .replace(/^\/docs\/?/, '');
}

/**
 * Loads the page's pre-rendered chunk before the route activates, so the
 * server and the hydrating browser render the same HTML.
 */
export const docResolver: ResolveFn<DocPage> = async (_route, state) => {
  const router = inject(Router);
  const doc = await loadDoc(docSlugFromUrl(state.url));
  if (!doc) {
    return new RedirectCommand(router.parseUrl('/404'), { skipLocationChange: true });
  }
  return doc;
};
