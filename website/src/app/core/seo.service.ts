import { DOCUMENT, Injectable, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { SITE } from '../../site.config';

export interface PageMeta {
  /** Page title without the site name; omit for the home page. */
  title?: string;
  description: string;
  /** Route of the page, e.g. `/docs/protocol`. */
  path: string;
  noindex?: boolean;
  type?: 'website' | 'article';
}

/** Title, description, canonical URL and Open Graph / Twitter tags per page. */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);

  set(page: PageMeta): void {
    const fullTitle = page.title ? `${page.title} · ${SITE.name}` : SITE.title;
    const url = SITE.url + (page.path === '/' ? '/' : page.path);
    const image = SITE.url + SITE.ogImage;

    this.title.setTitle(fullTitle);
    const tags: [string, string, 'name' | 'property'][] = [
      ['description', page.description, 'name'],
      ['robots', page.noindex ? 'noindex' : 'index, follow', 'name'],
      ['og:type', page.type ?? 'website', 'property'],
      ['og:site_name', SITE.name, 'property'],
      ['og:title', fullTitle, 'property'],
      ['og:description', page.description, 'property'],
      ['og:url', url, 'property'],
      ['og:image', image, 'property'],
      ['og:image:width', '1200', 'property'],
      ['og:image:height', '630', 'property'],
      ['og:image:alt', SITE.pitch, 'property'],
      ['twitter:card', 'summary_large_image', 'name'],
      ['twitter:title', fullTitle, 'name'],
      ['twitter:description', page.description, 'name'],
      ['twitter:image', image, 'name'],
    ];
    for (const [key, content, attr] of tags) {
      this.meta.updateTag({ [attr]: key, content }, `${attr}="${key}"`);
    }
    this.canonical(url);
  }

  private canonical(url: string): void {
    const head = this.document.head;
    let link = head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.document.createElement('link');
      link.setAttribute('rel', 'canonical');
      head.appendChild(link);
    }
    link.setAttribute('href', url);
  }
}
