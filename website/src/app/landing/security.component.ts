import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IconComponent, type IconName } from '../components/icon.component';

interface Pillar {
  icon: IconName;
  title: string;
  text: string;
  link: { route: string; label: string };
}

const PILLARS: Pillar[] = [
  {
    icon: 'lock',
    title: 'A Noise handshake per call',
    text: 'Noise IK with X25519, ChaCha20-Poly1305 and BLAKE2b. Nothing in between can read, change or replay a request. Fresh keys for every answer, no session state, published test vectors.',
    link: { route: '/docs/protocol', label: 'The protocol' },
  },
  {
    icon: 'key',
    title: 'A key pair per device',
    text: 'Each device creates its own key; the private half never leaves it. A lost phone is revoked with one tap, and every other device keeps working. No bearer token to leak.',
    link: { route: '/docs/decisions/0002-device-keys-instead-of-tokens', label: 'Why device keys' },
  },
  {
    icon: 'shield',
    title: 'Least privilege, generated',
    text: 'The ClusterRole is generated from what each module reads and does. No Secrets outside its own two, no delete, no exec. rbac.allowActions=false makes it strictly read-only.',
    link: { route: '/docs/security', label: 'Security model' },
  },
  {
    icon: 'radar',
    title: 'Nothing leaves your network',
    text: 'No backend of ours, no account, no telemetry. Out of the cluster goes only what you switch on: notifications (reducible to counts), the relay (sealed messages only) and the vulnerability lookup (names and versions only).',
    link: { route: '/docs/communication', label: 'Every connection' },
  },
];

@Component({
  selector: 'kn-security',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, IconComponent],
  template: `
    <section id="security" class="security" aria-labelledby="security-title">
      <div class="container">
        <header class="head">
          <p class="eyebrow"><kn-icon name="shield" />Security</p>
          <h2 id="security-title">Built like it has write access to your cluster. Because it does.</h2>
          <p class="sub">
            Kubernanny reads most of your cluster and holds a few write verbs for its actions. Every one of them is
            written down, with what an attacker could do with each piece and the residual risks.
          </p>
        </header>
        <div class="pillars">
          @for (p of pillars; track p.title) {
            <article class="pillar">
              <span class="icon"><kn-icon [name]="p.icon" /></span>
              <h3>{{ p.title }}</h3>
              <p>{{ p.text }}</p>
              <a [routerLink]="p.link.route">{{ p.link.label }} <kn-icon name="arrowRight" /></a>
            </article>
          }
        </div>
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
      margin-top: 128px;
    }
    .security {
      position: relative;
      padding: 96px 0;
      background:
        radial-gradient(50rem 26rem at 85% 0%, var(--glow-1), transparent 70%),
        var(--ground-deep);
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
    }
    .head {
      max-width: 760px;
      margin-bottom: 48px;
    }
    .eyebrow {
      --icon-size: 16px;
    }
    h2 {
      margin: 14px 0 0;
      font-size: clamp(2rem, 1.5rem + 2.2vw, 3.125rem);
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    .sub {
      margin: 18px 0 0;
      color: var(--ink-2);
      font-size: 1.125rem;
    }
    .pillars {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 16px;
    }
    @media (min-width: 720px) {
      .pillars {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
    @media (min-width: 1100px) {
      .pillars {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }
    .pillar {
      display: flex;
      flex-direction: column;
      padding: 24px;
      border-radius: var(--radius-l);
      border: 1px solid var(--line);
      background: color-mix(in srgb, var(--surface) 80%, transparent);
    }
    .icon {
      display: grid;
      place-items: center;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      border: 1px solid color-mix(in srgb, var(--ok) 40%, transparent);
      background: var(--ok-soft);
      color: var(--ok);
      --icon-size: 22px;
    }
    h3 {
      margin: 18px 0 8px;
      font-size: 1.1875rem;
      font-weight: 700;
    }
    p {
      margin: 0 0 18px;
      color: var(--ink-2);
      font-size: 0.96875rem;
    }
    a {
      margin-top: auto;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-weight: 650;
      text-decoration: none;
    }
    a:hover {
      text-decoration: underline;
      text-underline-offset: 3px;
    }
  `,
})
export class SecurityComponent {
  protected readonly pillars = PILLARS;
}
