import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LEGAL, SITE, isPlaceholder } from '../../site.config';
import { SeoService } from '../core/seo.service';

const VM = {
  name: { value: LEGAL.name, todo: isPlaceholder(LEGAL.name) },
  email: { value: LEGAL.email, todo: isPlaceholder(LEGAL.email) },
  draft: Object.values(LEGAL).some(isPlaceholder),
  demoUrl: SITE.demoUrl,
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="container legal prose">
      <h1>Privacy</h1>
      @if (vm.draft) {
        <p class="draft" role="note">Draft: the controller's details are placeholders, and this notice should be reviewed before launch.</p>
      }

      <p>
        <strong>In short:</strong> this site sets no cookies, runs no analytics or tracking, embeds nothing from third
        parties and loads its fonts from its own server. Kubernanny itself, the software, sends nothing to us either:
        it has no account and no telemetry.
      </p>

      <h2>Controller</h2>
      <p>
        <span [class.todo]="vm.name.todo">{{ vm.name.value }}</span>, see the <a routerLink="/imprint">imprint</a>.
        E-mail: <span [class.todo]="vm.email.todo">{{ vm.email.value }}</span>
      </p>

      <h2>Hosting</h2>
      <p>
        The site is a set of static files served by Cloudflare Pages (Cloudflare, Inc.). To deliver a page, the host
        necessarily processes technical data of the request, such as the IP address, the time, the page requested and
        the browser's user agent, and may keep it in logs for operation and security. The legal basis is our
        legitimate interest in delivering the site securely (Art. 6(1)(f) GDPR). Details on what Cloudflare processes
        and for how long are in
        <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare's privacy policy</a>.
      </p>

      <h2>Links to other sites</h2>
      <p>
        Links to GitHub, GitHub Sponsors, Ko-fi or the <a [href]="vm.demoUrl">live demo</a> take you to other services,
        whose own privacy notices apply once you follow them. Nothing is loaded from them before you click.
      </p>

      <h2>E-mail</h2>
      <p>
        If you write to us, your message and address are used only to answer it and are deleted when they are no
        longer needed for that (Art. 6(1)(b) and (f) GDPR).
      </p>

      <h2>Your rights</h2>
      <p>
        You have the right to access, rectification, erasure, restriction of processing, data portability and to
        object (Art. 15 to 21 GDPR), and to lodge a complaint with a data protection supervisory authority.
      </p>
    </div>
  `,
  styleUrl: '../components/legal-shell.css',
})
export default class PrivacyPage {
  protected readonly vm = VM;

  constructor() {
    inject(SeoService).set({
      title: 'Privacy',
      description: 'Privacy notice of kubernanny.app: no cookies, no tracking, fonts served locally.',
      path: '/privacy',
    });
  }
}
