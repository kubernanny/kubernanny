import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { SITE } from '../../site.config';
import { IconComponent } from './icon.component';

@Component({
  selector: 'kn-site-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive, IconComponent],
  template: `
    <header class="bar">
      <div class="inner">
        <a routerLink="/" class="brand" aria-label="Kubernanny, home">
          <img src="/favicon.svg" alt="" width="32" height="32" />
          <span>Kubernanny</span>
        </a>
        <nav aria-label="Main">
          <a routerLink="/docs" routerLinkActive="active" ariaCurrentWhenActive="page">Docs</a>
          <a routerLink="/docs/security" class="wide-only" routerLinkActive="active" ariaCurrentWhenActive="page">Security</a>
          <a [href]="site.demoUrl" class="wide-only">Demo</a>
          <a [href]="site.repoUrl" class="icon-link" aria-label="Kubernanny on GitHub">
            <kn-icon name="github" />
            <span class="wide-only">GitHub</span>
          </a>
          <a routerLink="/" fragment="install" class="btn btn-small btn-primary">Install</a>
        </nav>
      </div>
    </header>
  `,
  styles: `
    :host {
      position: sticky;
      top: 0;
      z-index: 20;
      display: block;
    }
    .bar {
      background: color-mix(in srgb, var(--ground) 78%, transparent);
      backdrop-filter: saturate(1.4) blur(14px);
      -webkit-backdrop-filter: saturate(1.4) blur(14px);
      border-bottom: 1px solid var(--line);
    }
    .inner {
      max-width: var(--page-max);
      margin: 0 auto;
      padding: 0 var(--gutter);
      height: var(--header-h);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font: 700 1.1875rem/1 var(--font-display);
      letter-spacing: -0.01em;
      color: var(--ink);
      text-decoration: none;
    }
    .brand img {
      border-radius: 8px;
    }
    nav {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    nav a:not(.btn) {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      border-radius: var(--radius-s);
      color: var(--ink-2);
      text-decoration: none;
      font-weight: 600;
      font-size: 0.9375rem;
    }
    nav a:not(.btn):hover,
    nav a.active {
      color: var(--ink);
      background: var(--raise);
    }
    .btn-small {
      margin-left: 6px;
    }
    @media (max-width: 719px) {
      .wide-only {
        display: none !important;
      }
    }
  `,
})
export class SiteHeaderComponent {
  protected readonly site = SITE;
}
