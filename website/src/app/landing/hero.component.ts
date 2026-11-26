import { ChangeDetectionStrategy, Component } from '@angular/core';
import { componentGroups } from 'virtual:kubernanny-components';
import { SITE } from '../../site.config';
import { IconComponent } from '../components/icon.component';
import { NannyLogoComponent } from '../components/nanny-logo.component';
import { SCREENSHOTS } from './screenshots';

const COMPONENT_COUNT = componentGroups.reduce((sum, g) => sum + g.components.length, 0);

@Component({
  selector: 'kn-hero',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent, NannyLogoComponent],
  template: `
    <section class="hero" aria-labelledby="hero-title">
      <div class="backdrop" aria-hidden="true"></div>

      <div class="container grid">
        <div class="copy">
          <p class="eyebrow"><span class="live" aria-hidden="true"></span>Kubernetes health for self-hosters</p>
          <h1 id="hero-title">Your cluster's nanny.</h1>
          <p class="lead">
            A small agent in your cluster, an app on your phone. One light per cluster, and below it
            <strong>only what is broken</strong>: the cause, and the one action that usually fixes it.
          </p>
          <div class="ctas">
            <a class="btn btn-primary" [href]="vm.demoUrl">
              <kn-icon name="play" />
              Try the live demo
            </a>
            <a class="btn btn-ghost" href="#install">
              Install with Helm
              <kn-icon name="arrowRight" />
            </a>
          </div>
          <ul class="facts" aria-label="At a glance">
            <li><strong>{{ vm.count }}</strong> components recognised</li>
            <li>iPhone, Android and web</li>
            <li>End-to-end encrypted</li>
            <li>No account, no telemetry</li>
            <li>Open source, {{ vm.licence }}</li>
          </ul>
        </div>

        <div class="visual">
          <div class="halo" aria-hidden="true"></div>
          <figure class="phone">
            <picture>
              <source media="(prefers-color-scheme: light)" [attr.srcset]="vm.phone.light" />
              <img
                [src]="vm.phone.src"
                [alt]="vm.phone.alt"
                [width]="vm.phone.width"
                [height]="vm.phone.height"
                fetchpriority="high"
                decoding="async"
              />
            </picture>
          </figure>
          <kn-nanny-logo class="nanny" />
          <div class="chip chip-fix" aria-hidden="true">
            <span class="dot crit"></span>
            CrashLoopBackOff
            <span class="action">Restart</span>
          </div>
        </div>
      </div>
    </section>
  `,
  styleUrl: './hero.component.css',
})
export class HeroComponent {
  protected readonly vm = {
    demoUrl: SITE.demoUrl,
    licence: SITE.licence,
    count: COMPONENT_COUNT,
    phone: SCREENSHOTS.heroPhone,
  };
}
