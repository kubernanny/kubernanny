import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SITE } from '../../site.config';
import { SeoService } from '../core/seo.service';
import { FeaturesComponent } from '../landing/features.component';
import { HeroComponent } from '../landing/hero.component';
import { InstallComponent } from '../landing/install.component';
import { SecurityComponent } from '../landing/security.component';
import { ShowcaseComponent } from '../landing/showcase.component';
import { SupportComponent } from '../landing/support.component';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HeroComponent, InstallComponent, FeaturesComponent, ShowcaseComponent, SecurityComponent, SupportComponent],
  template: `
    <kn-hero />
    <kn-install />
    <kn-features />
    <kn-showcase />
    <kn-security />
    <kn-support />
  `,
})
export default class HomePage {
  constructor() {
    inject(SeoService).set({ description: SITE.description, path: '/' });
  }
}
