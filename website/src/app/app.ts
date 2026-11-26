import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { SiteFooterComponent } from './components/site-footer.component';
import { SiteHeaderComponent } from './components/site-header.component';

@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, SiteHeaderComponent, SiteFooterComponent],
  template: `
    <a class="skip-link" href="#main">Skip to content</a>
    <kn-site-header />
    <main id="main" tabindex="-1">
      <router-outlet />
    </main>
    <kn-site-footer />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100vh;
    }
    main {
      flex: 1;
      outline: none;
    }
  `,
})
export class App {}
