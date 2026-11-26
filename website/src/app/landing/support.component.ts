import { ChangeDetectionStrategy, Component } from '@angular/core';

import { SITE } from '../../site.config';
import { IconComponent } from '../components/icon.component';

@Component({
  selector: 'kn-support',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <section class="container demo" aria-labelledby="demo-title">
      <div class="demo-card">
        <div>
          <h2 id="demo-title">See it on a cluster that is on fire.</h2>
          <p>
            The live demo runs Kubernanny against its built-in demo clusters: outages, warnings, the lot. Nothing to
            install, nothing to break.
          </p>
        </div>
        <a class="btn btn-primary" [href]="vm.demoUrl">
          <kn-icon name="play" />
          Try the demo
        </a>
      </div>
    </section>

    <section id="support" class="container support" aria-labelledby="support-title">
      <div class="support-card">
        <div class="text">
          <p class="eyebrow"><kn-icon name="heart" />Support</p>
          <h2 id="support-title">Free. Kept going by the people who use it.</h2>
          <p>
            No pro tier, no paywalled checks, no ads. If Kubernanny saved you a night, chip in for the developer
            accounts, the domain and the time it takes to add the next integration.
          </p>
        </div>
        <div class="buttons">
          <a class="btn btn-primary" [href]="vm.sponsorsUrl">
            <kn-icon name="heart" />
            Sponsor on GitHub
          </a>
          <a class="btn btn-ghost" [href]="vm.kofiUrl">
            <kn-icon name="coffee" />
            Buy me a coffee
          </a>
          <a class="btn btn-ghost" [href]="vm.repoUrl">
            <kn-icon name="star" />
            Star on GitHub
          </a>
        </div>
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    .demo {
      padding-top: 72px;
    }
    .demo-card {
      position: relative;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 24px 40px;
      padding: 40px;
      border-radius: 28px;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, var(--crit) 35%, var(--line));
      background:
        radial-gradient(36rem 20rem at 0% 0%, var(--crit-soft), transparent 70%),
        radial-gradient(30rem 20rem at 100% 100%, var(--warn-soft), transparent 70%), var(--surface);
      box-shadow: var(--shadow);
    }
    @media (max-width: 600px) {
      .demo-card {
        padding: 28px 22px;
      }
    }
    .demo-card > div {
      flex: 1 1 420px;
      min-width: 0;
    }
    h2 {
      margin: 0;
      font-size: clamp(1.75rem, 1.35rem + 1.6vw, 2.5rem);
      font-weight: 800;
      letter-spacing: -0.025em;
    }
    .demo-card p,
    .text p:not(.eyebrow) {
      margin: 12px 0 0;
      color: var(--ink-2);
      font-size: 1.0625rem;
      max-width: 52ch;
    }
    .support {
      padding-top: 24px;
    }
    .support-card {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 28px;
      align-items: center;
      padding: 40px;
      border-radius: 28px;
      border: 1px solid var(--line);
      background: radial-gradient(30rem 18rem at 100% 0%, var(--ok-soft), transparent 70%), var(--surface);
    }
    @media (max-width: 600px) {
      .support-card {
        padding: 28px 22px;
      }
    }
    @media (min-width: 960px) {
      .support-card {
        grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
      }
    }
    .eyebrow {
      margin: 0 0 12px;
      color: var(--ok);
      --icon-size: 16px;
    }
    .buttons {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    @media (min-width: 600px) and (max-width: 959px) {
      .buttons {
        flex-direction: row;
        flex-wrap: wrap;
      }
    }
  `,
})
export class SupportComponent {
  protected readonly vm = {
    demoUrl: SITE.demoUrl,
    sponsorsUrl: SITE.sponsorsUrl,
    kofiUrl: SITE.kofiUrl,
    repoUrl: SITE.repoUrl,
  };
}
