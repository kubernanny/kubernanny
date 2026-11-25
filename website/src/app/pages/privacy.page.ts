import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LEGAL, SITE } from '../../site.config';
import { SeoService } from '../core/seo.service';

const VM = {
  name: LEGAL.name,
  email: LEGAL.email,
  demoUrl: SITE.demoUrl,
  relayDoc: '/docs/relay',
};

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <div class="container legal prose">
      <h1>Privacy</h1>

      <p>
        <strong>In short:</strong> this site and the demo set no cookies, run no analytics or tracking and load
        nothing from third parties. The Kubernanny app has no account, no analytics, no crash reporting and no
        tracking. It talks to the agent you install in your own cluster, end-to-end encrypted, and your cluster data
        stays with that agent. We only see something if you use the optional public relay or native push, and even
        then never the content.
      </p>

      <h2>Controller</h2>
      <p>
        {{ vm.name }}, address in the <a routerLink="/imprint">imprint</a>. E-mail:
        <a [href]="'mailto:' + vm.email">{{ vm.email }}</a>
      </p>

      <h2>This website and the demo</h2>
      <p>
        kubernanny.app and the demo at <a [href]="vm.demoUrl">demo.kubernanny.app</a> are static files served by
        Cloudflare Pages (Cloudflare, Inc.). To deliver a page, Cloudflare necessarily processes technical data of the
        request, such as the IP address, the time, the page requested and the browser's user agent, and may keep it
        in logs for operation and security. The demo runs entirely in your browser with built-in sample data and
        connects to no cluster. The legal basis is our legitimate interest in delivering the site securely (Art.
        6(1)(f) GDPR). Details are in <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare's privacy
        policy</a>.
      </p>

      <h2>The app</h2>
      <p>
        The app (iPhone, Android and the web page your agent serves) has no account and sends nothing to us: no
        analytics, no tracking, no crash reports. It talks directly to the Kubernanny agent you run in your own
        cluster, end-to-end encrypted. The addresses of your clusters and the device's keys are kept on the device.
        What the agent reads from your cluster, and which devices it knows, stays in your cluster: you are in charge
        of that data, not us. Checks of the agent that ask an outside service, such as known vulnerabilities at
        api.osv.dev, are off until you switch them on, say so in the app, and go out from your cluster, not through
        us.
      </p>

      <h2>The public relay (optional)</h2>
      <p>
        If your agent uses the public relay (relay.kubernanny.app, run by us on Cloudflare Workers) and your phone
        cannot reach the agent directly, the app's encrypted calls pass through it. The relay cannot read them. It
        processes the agent id (a hash of your agent's public key) and whether the agent is online, the IP addresses
        of the agent and of the calling device, and the size and time of each call. The calling device's address is
        used only to share out the rate limits and is held in memory for as long as the connection lasts; the relay
        keeps no log of calls and no content. Cloudflare, which runs the relay for us, may log requests as for the
        website. The legal basis is providing the connection you asked for (Art. 6(1)(b) GDPR) and our legitimate
        interest in protecting the relay from abuse (Art. 6(1)(f) GDPR). More in the
        <a [routerLink]="vm.relayDoc">relay documentation</a>.
      </p>

      <h2>Push notifications (optional)</h2>
      <p>
        Only if you switch on "Push to this device" for a cluster. The app then gets a push token for this device
        from Google Firebase Cloud Messaging (on iPhones through Apple's Push Notification service) and sends it,
        with the platform and the id of a push key, end-to-end encrypted to your agent, which stores it in your
        cluster. When there is something to report, the agent seals the message for your device and hands it to the
        relay with the token, the platform and the key id. The relay passes it to Firebase Cloud Messaging, which
        delivers it, to iPhones through Apple. Neither the relay nor Google nor Apple can read the message.
      </p>
      <p>
        The relay processes the token, the platform, the key id, the agent id and the size and time of each push. It
        does not store the token. To limit how many pushes go out, it keeps per agent a counter and one-way hashes
        of the tokens it pushed to in the last 24 hours (older entries are dropped at the next push), and per token a
        counter under a one-way hash of the token. Google and Apple process the token, the app, and the size and
        time of each message, under their own privacy policies:
        <a href="https://firebase.google.com/support/privacy">Firebase</a> and
        <a href="https://www.apple.com/legal/privacy/">Apple</a>. The legal basis is delivering the notifications you
        asked for (Art. 6(1)(b) GDPR).
      </p>
      <p>
        Switching push off, or removing the device in the app, deletes the token from your agent; after that nothing
        is sent to the device. Uninstalling the app makes the token invalid. The agent and everything it stores stay
        in your cluster until you uninstall it.
      </p>

      <h2>Transfers outside the EU</h2>
      <p>
        Cloudflare, Google and Apple may process data in the USA. They are certified under the EU-US Data Privacy
        Framework (Art. 45 GDPR).
      </p>

      <h2>Links to other sites</h2>
      <p>
        Links to GitHub, GitHub Sponsors, Ko-fi or nicolueg.com take you to other services, whose own privacy notices apply
        once you follow them. Nothing is loaded from them before you click.
      </p>

      <h2>E-mail</h2>
      <p>
        If you write to us, your message and address are used only to answer it and are deleted when they are no
        longer needed for that (Art. 6(1)(b) and (f) GDPR).
      </p>

      <h2>Your rights</h2>
      <p>
        You have the right to access, rectification, erasure, restriction of processing, data portability and to
        object (Art. 15 to 21 GDPR), and to lodge a complaint with a data protection supervisory authority, for
        example the one for North Rhine-Westphalia (LDI NRW).
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
      description: 'Privacy notice for kubernanny.app, the demo, the Kubernanny app, the public relay and native push.',
      path: '/privacy',
    });
  }
}
