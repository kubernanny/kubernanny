import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SITE } from '../../site.config';
import { GALLERY, SCREENSHOTS } from './screenshots';

@Component({
  selector: 'kn-showcase',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <section class="showcase" aria-labelledby="showcase-title">
      <div class="container">
        <header class="head">
          <p class="eyebrow">See it</p>
          <h2 id="showcase-title">One answer first. Everything else below the fold.</h2>
          <p class="sub">
            Phone, tablet or a browser tab: the agent serves the web app itself, and the same app runs on iOS and
            Android.
          </p>
        </header>

        <figure class="browser">
          <div class="chrome" aria-hidden="true">
            <span class="dots"><i></i><i></i><i></i></span>
            <span class="url">kubernanny.homelab.lan</span>
          </div>
          <picture>
            <source media="(prefers-color-scheme: light)" [attr.srcset]="vm.desktop.light" />
            <img
              [src]="vm.desktop.src"
              [alt]="vm.desktop.alt"
              [width]="vm.desktop.width"
              [height]="vm.desktop.height"
              loading="lazy"
              decoding="async"
            />
          </picture>
        </figure>
      </div>

      <ul class="strip container" aria-label="More screens">
        @for (item of vm.gallery; track item.shot.src) {
          <li>
            <figure>
              <img
                [src]="item.shot.src"
                [alt]="item.shot.alt"
                [width]="item.shot.width"
                [height]="item.shot.height"
                loading="lazy"
                decoding="async"
              />
              <figcaption>{{ item.caption }}</figcaption>
            </figure>
          </li>
        }
      </ul>
      <p class="container note">
        In English and German, following your device. <a [href]="vm.demoUrl">Try the demo</a> ·
        <a routerLink="/docs/screenshots">All screenshots</a>
      </p>
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    .showcase {
      padding-top: 112px;
    }
    .head {
      max-width: 720px;
      margin-bottom: 40px;
    }
    h2 {
      margin: 14px 0 0;
      font-size: clamp(2.125rem, 1.6rem + 2.2vw, 3.25rem);
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    .sub {
      margin: 18px 0 0;
      color: var(--ink-2);
      font-size: 1.125rem;
    }
    .browser {
      margin: 0;
      border-radius: 18px;
      border: 1px solid var(--line-strong);
      background: #0b111e;
      box-shadow: 0 50px 100px -40px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.03) inset;
      overflow: hidden;
    }
    .chrome {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 12px 16px;
      background: #141c30;
      border-bottom: 1px solid rgba(141, 151, 181, 0.16);
    }
    .dots {
      display: inline-flex;
      gap: 7px;
    }
    .dots i {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: #2a3555;
    }
    .url {
      flex: 0 1 340px;
      margin: 0 auto;
      padding: 5px 12px;
      border-radius: 8px;
      background: #0b111e;
      color: #8d97b5;
      font: 500 0.8125rem/1.3 var(--font-mono);
      text-align: center;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .browser picture {
      display: block;
    }
    .browser img {
      display: block;
      width: 100%;
      height: auto;
    }
    .strip {
      display: grid;
      grid-auto-flow: column;
      grid-auto-columns: minmax(168px, 1fr);
      gap: 18px;
      list-style: none;
      margin: 40px auto 0;
      padding-bottom: 12px;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      scroll-padding-inline: var(--gutter);
      scrollbar-width: thin;
    }
    .strip li {
      scroll-snap-align: start;
    }
    figure {
      margin: 0;
    }
    .strip img {
      display: block;
      width: 100%;
      height: auto;
      border-radius: 20px;
      border: 1px solid var(--line-strong);
      box-shadow: var(--shadow);
    }
    figcaption {
      margin-top: 12px;
      font-size: 0.9375rem;
      color: var(--ink-2);
      line-height: 1.4;
    }
    .note {
      margin-top: 20px;
      color: var(--mute);
      font-size: 0.9375rem;
    }
    .note a + a {
      margin-left: 12px;
    }
  `,
})
export class ShowcaseComponent {
  protected readonly vm = { desktop: SCREENSHOTS.desktop, gallery: GALLERY, demoUrl: SITE.demoUrl };
}
