import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';

import { SeoService } from '../core/seo.service';
import { parseQrFragment, QrPayload, qrSvgPath } from '../qr/pair-qr';

/** The page speaks the browser's language: German for de-*, English otherwise. The rest of the site is English. */
const TEXT = {
  en: {
    noneTitle: 'Pairing QR code',
    noneText: "Open the link from your Kubernanny agent's log. The pairing link comes after the #.",
    pairTitle: (name: string) => (name ? `Pair ${name}` : 'Pair your cluster'),
    scan: 'Scan this code with the Kubernanny app ("Scan QR code") or with your phone\'s camera.',
    once: 'The code in it works once, for 60 minutes after the agent printed it.',
    invalidTitle: 'Not a pairing link.',
    invalidText:
      'This page only shows kubernanny://pair links from the log of a Kubernanny agent. Copy the whole line from the log, it starts with https://kubernanny.app/qr#.',
    privacy:
      'The code is drawn in your browser. Everything after the # in the address stays there: browsers never send it to a server, so kubernanny.app only learns that this page was opened. No cookies, no analytics.',
    qrLabel: 'QR code with the pairing link',
  },
  de: {
    noneTitle: 'Pairing-QR-Code',
    noneText: 'Öffne den Link aus dem Log deines Kubernanny-Agents. Der Pairing-Link steht hinter dem #.',
    pairTitle: (name: string) => (name ? `${name} koppeln` : 'Cluster koppeln'),
    scan: 'Scanne diesen Code mit der Kubernanny-App („QR-Code scannen“) oder mit der Handykamera.',
    once: 'Der Code darin gilt einmal, 60 Minuten lang ab der Ausgabe im Log.',
    invalidTitle: 'Das ist kein Pairing-Link.',
    invalidText:
      'Diese Seite zeigt nur kubernanny://pair-Links aus dem Log eines Kubernanny-Agents. Kopiere die ganze Zeile aus dem Log, sie beginnt mit https://kubernanny.app/qr#.',
    privacy:
      'Der Code wird in deinem Browser gezeichnet. Alles hinter dem # in der Adresse bleibt dort: Browser schicken es nie an einen Server, kubernanny.app erfährt nur, dass diese Seite geöffnet wurde. Keine Cookies, keine Analyse.',
    qrLabel: 'QR-Code mit dem Pairing-Link',
  },
};

/**
 * /qr#<pairing link>: the agent's log QR code as a large image, for log
 * viewers whose line spacing breaks the text one (Argo CD, Lens, Loki). The
 * link travels in the fragment, which the browser keeps to itself; the page
 * draws it locally and shows nothing but the cluster name from the link.
 */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="container qr" [attr.lang]="lang()">
      @switch (payload().kind) {
        @case ('pair') {
          <h1>{{ vm().title }}</h1>
          <p class="lead">{{ t().scan }}</p>
          <figure class="tile">
            <svg [attr.viewBox]="vm().viewBox" role="img" [attr.aria-label]="t().qrLabel" shape-rendering="crispEdges">
              <path [attr.d]="vm().path" />
            </svg>
          </figure>
          <p class="note">{{ t().once }}</p>
        }
        @case ('invalid') {
          <h1>{{ t().invalidTitle }}</h1>
          <p class="lead">{{ t().invalidText }}</p>
        }
        @default {
          <h1>{{ t().noneTitle }}</h1>
          <p class="lead">{{ t().noneText }}</p>
        }
      }
      <p class="privacy">{{ t().privacy }}</p>
    </section>
  `,
  styles: `
    .qr {
      max-width: 560px;
      padding-top: 40px;
      padding-bottom: 32px;
      text-align: center;
    }
    h1 {
      margin: 0 0 12px;
      font-size: clamp(1.75rem, 1.4rem + 1.6vw, 2.5rem);
      overflow-wrap: anywhere;
    }
    .lead {
      margin: 0 auto 24px;
      color: var(--ink-2);
      line-height: 1.5;
    }
    .tile {
      /* Dark on white in both themes: what every scanner expects. */
      margin: 0 auto 20px;
      width: min(100%, 440px);
      padding: 0;
      background: #fff;
      border-radius: var(--radius-m);
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    svg {
      display: block;
      width: 100%;
      height: auto;
    }
    path {
      fill: #000;
    }
    .note {
      margin: 0 0 28px;
      color: var(--ink-2);
      font-size: 0.9375rem;
    }
    .privacy {
      margin: 0 auto;
      max-width: 34rem;
      color: var(--mute);
      font-size: 0.875rem;
      line-height: 1.55;
    }
  `,
})
export default class QrPage {
  protected readonly payload = signal<QrPayload>({ kind: 'none' });
  protected readonly lang = signal<'en' | 'de'>('en');
  protected readonly t = computed(() => TEXT[this.lang()]);
  protected readonly vm = computed(() => {
    const p = this.payload();
    if (p.kind !== 'pair') {
      return { title: '', viewBox: '0 0 1 1', path: '' };
    }
    const { size, path } = qrSvgPath(p.link);
    return { title: this.t().pairTitle(p.name), viewBox: `0 0 ${size} ${size}`, path };
  });

  constructor() {
    inject(SeoService).set({
      title: 'Pairing QR code',
      description:
        "Shows the pairing QR code from a Kubernanny agent's log as a large image. The link stays in your browser.",
      path: '/qr',
      noindex: true,
    });
    const destroyRef = inject(DestroyRef);
    // Only in the browser: the prerendered page knows no fragment, and the server never sees one.
    afterNextRender(() => {
      this.lang.set(/^de\b/i.test(navigator.language) ? 'de' : 'en');
      const read = () => this.payload.set(parseQrFragment(location.hash));
      read();
      window.addEventListener('hashchange', read);
      destroyRef.onDestroy(() => window.removeEventListener('hashchange', read));
    });
  }
}
