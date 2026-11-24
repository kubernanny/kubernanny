import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SeoService } from '../core/seo.service';
import { NannyLogoComponent } from '../components/nanny-logo.component';

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, NannyLogoComponent],
  template: `
    <section class="container nf">
      <kn-nanny-logo class="logo" [animated]="false" />
      <p class="code">404</p>
      <h1>Nothing to see here.</h1>
      <p class="lead">This page does not exist, or it moved. The nanny checked twice.</p>
      <div class="actions">
        <a routerLink="/" class="btn btn-primary">Back to the start</a>
        <a routerLink="/docs" class="btn btn-ghost">Browse the docs</a>
      </div>
    </section>
  `,
  styles: `
    .nf {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      padding-top: 80px;
      padding-bottom: 40px;
    }
    .logo {
      width: 112px;
      filter: grayscale(0.2);
    }
    .code {
      margin: 24px 0 0;
      font: 700 0.875rem/1 var(--font-body);
      letter-spacing: 0.2em;
      color: var(--warn);
    }
    h1 {
      margin: 12px 0 8px;
      font-size: clamp(2rem, 1.5rem + 2vw, 3rem);
    }
    .lead {
      color: var(--ink-2);
      margin: 0 0 28px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: center;
      gap: 12px;
    }
  `,
})
export default class NotFoundPage {
  constructor() {
    inject(SeoService).set({
      title: 'Page not found',
      description: 'This page does not exist.',
      path: '/404',
      noindex: true,
    });
  }
}
