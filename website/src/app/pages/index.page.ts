import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { componentGroups } from 'virtual:kubernanny-components';

import { SITE } from '../../site.config';
import { SeoService } from '../core/seo.service';
import { FaqComponent } from '../landing/faq.component';
import { FeaturesComponent } from '../landing/features.component';
import { HeroComponent } from '../landing/hero.component';
import { InstallComponent } from '../landing/install.component';
import { SecurityComponent } from '../landing/security.component';
import { ShowcaseComponent } from '../landing/showcase.component';
import { SupportComponent } from '../landing/support.component';

const COMPONENT_COUNT = componentGroups.reduce((sum, g) => sum + g.components.length, 0);

/** The description with the component count the page shows, not a rounded one. */
const DESCRIPTION = `Open-source Kubernetes health for self-hosters. Recognises ${COMPONENT_COUNT} components, checks them deeply, and shows only what is broken, with the cause and the fix. End-to-end encrypted.`;

/** schema.org data for search engines: what Kubernanny is, that it is free, who makes it. */
const SOFTWARE_APPLICATION = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: SITE.name,
  description: DESCRIPTION,
  url: `${SITE.url}/`,
  image: SITE.url + SITE.ogImage,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Kubernetes, iOS, Android, Web',
  license: `https://spdx.org/licenses/${SITE.licence}.html`,
  isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR' },
  author: { '@type': 'Person', name: SITE.author.name, url: SITE.author.url },
  sameAs: [SITE.repoUrl],
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    HeroComponent,
    InstallComponent,
    FeaturesComponent,
    ShowcaseComponent,
    SecurityComponent,
    FaqComponent,
    SupportComponent,
  ],
  template: `
    <kn-hero />
    <kn-install />
    <kn-features />
    <kn-showcase />
    <kn-security />
    <kn-faq />
    <kn-support />
  `,
})
export default class HomePage {
  constructor() {
    inject(SeoService).set({ description: DESCRIPTION, path: '/', jsonLd: SOFTWARE_APPLICATION });
  }
}
