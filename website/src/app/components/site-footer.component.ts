import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { SITE } from '../../site.config';

@Component({
  selector: 'kn-site-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <footer>
      <div class="inner">
        <div class="about">
          <a routerLink="/" class="brand">
            <img src="/favicon.svg" alt="" width="28" height="28" loading="lazy" />
            <span>Kubernanny</span>
          </a>
          <p>{{ site.pitch }}</p>
          <p class="fine">Open source under {{ site.licence }}. No account, no telemetry, no backend of ours.</p>
          <p class="fine">
            A project by <a [href]="site.author.url">{{ site.author.name }}</a> (<a [href]="site.author.github"
              >GitHub</a
            >).
          </p>
        </div>
        <nav aria-label="Footer">
          <div>
            <h2>Product</h2>
            <ul>
              <li><a routerLink="/" fragment="install">Install</a></li>
              <li><a [href]="site.demoUrl">Live demo</a></li>
              <li><a routerLink="/docs/components">Components</a></li>
              <li><a routerLink="/docs/roadmap">Roadmap</a></li>
            </ul>
          </div>
          <div>
            <h2>Docs</h2>
            <ul>
              <li><a routerLink="/docs/configuration">Configuration</a></li>
              <li><a routerLink="/docs/checks">Checks</a></li>
              <li><a routerLink="/docs/protocol">Protocol</a></li>
              <li><a routerLink="/docs/security">Security model</a></li>
            </ul>
          </div>
          <div>
            <h2>Project</h2>
            <ul>
              <li><a [href]="site.repoUrl">GitHub</a></li>
              <li><a [href]="site.sponsorsUrl">Sponsor</a></li>
              <li><a [href]="site.kofiUrl">Ko-fi</a></li>
              <li><a [href]="site.repoUrl + '/blob/main/CONTRIBUTING.md'">Contributing</a></li>
              <li><a [href]="site.repoUrl + '/blob/main/SECURITY.md'">Report a vulnerability</a></li>
            </ul>
          </div>
          <div>
            <h2>Legal</h2>
            <ul>
              <li><a routerLink="/imprint">Imprint</a></li>
              <li><a routerLink="/privacy">Privacy</a></li>
              <li><a [href]="site.repoUrl + '/blob/main/LICENSE'">Licence</a></li>
            </ul>
          </div>
        </nav>
      </div>
    </footer>
  `,
  styles: `
    footer {
      border-top: 1px solid var(--line);
      background: var(--ground-deep);
      margin-top: 96px;
    }
    .inner {
      max-width: var(--page-max);
      margin: 0 auto;
      padding: 56px var(--gutter) 48px;
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 40px;
    }
    @media (min-width: 900px) {
      .inner {
        grid-template-columns: minmax(0, 1.1fr) minmax(0, 2fr);
      }
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font: 700 1.125rem/1 var(--font-display);
      color: var(--ink);
      text-decoration: none;
    }
    .brand img {
      border-radius: 7px;
    }
    .about p {
      color: var(--ink-2);
      max-width: 36ch;
      margin: 14px 0 0;
    }
    .about .fine {
      color: var(--mute);
      font-size: 0.875rem;
    }
    .about .fine a {
      color: inherit;
      text-underline-offset: 3px;
    }
    .about .fine a:hover {
      color: var(--ink);
    }
    nav {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 32px 24px;
    }
    @media (min-width: 640px) {
      nav {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }
    h2 {
      font: 600 0.8125rem/1 var(--font-body);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--mute);
      margin: 0 0 14px;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 10px;
    }
    li a {
      color: var(--ink-2);
      text-decoration: none;
    }
    li a:hover {
      color: var(--ink);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
  `,
})
export class SiteFooterComponent {
  protected readonly site = SITE;
}
