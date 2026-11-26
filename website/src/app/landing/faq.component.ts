import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

interface Question {
  q: string;
  a: string;
  link?: { route: string; label: string };
}

/**
 * What a first-time visitor asks before installing. Every answer is backed by
 * the docs it links to; keep them in step when the agent changes.
 */
export const QUESTIONS: Question[] = [
  {
    q: 'Do I need the phone app?',
    a: 'No. The agent serves the same app as a web page, so a browser on your LAN, over your VPN or behind your ingress shows everything; only native push and the home-screen widgets need the phone app. The iPhone and Android apps are on their way to the App Store and Google Play.',
  },
  {
    q: 'Do I need Prometheus?',
    a: 'No. Without it Kubernanny reads the Kubernetes API and metrics-server: every component check, nodes, workloads, volumes, and six hours of CPU and RAM. When it finds a Prometheus in the cluster it adds the standard alerts, error rates of the ingress controller and up to seven days of history.',
    link: { route: '/docs/checks', label: 'Every check and what it needs' },
  },
  {
    q: 'Which clusters does it run on?',
    a: 'It is built for self-hosted clusters and reads the plain Kubernetes API. On top it knows RKE2, k3s and kubeadm: their etcd, the etcd snapshots of RKE2 and k3s, and the upgrade guide to follow when your Kubernetes minor runs out of support.',
  },
  {
    q: 'What does it cost my cluster?',
    a: 'One pod: 128 Mi of memory requested, a 256 Mi limit, about 100 MB in use on a three-node homelab. It writes nothing to disk.',
    link: { route: '/docs/in-cluster', label: 'What runs in your cluster' },
  },
  {
    q: 'Can it change anything in my cluster?',
    a: 'Only on an open problem, and only what that problem needs. On by default: sync and hard refresh an Argo CD app, restart a workload, back up now (CloudNativePG, Longhorn, Velero), reconcile Flux, External Secrets or Infisical, renew a certificate, uncordon a forgotten node, clean up evicted pods. Off until you name them in actions.enabled: run a failed job again, force-delete a pod stuck on a dead node, stop a hanging Argo CD sync, grow a full volume, roll an Argo CD app back. Each one is confirmed in the app, the agent takes the target from its own check, never from the request, and admission policies hold every permission to its action. rbac.allowActions: false makes it strictly read-only.',
    link: { route: '/docs/permissions', label: 'Every permission' },
  },
  {
    q: 'Does anything leave my network?',
    a: 'Only what you switch on: notifications to the channels you configure, the sealed messages through the relay, and component names and versions for the vulnerability and image update lookups. No account, no telemetry.',
    link: { route: '/docs/communication', label: 'Every connection' },
  },
  {
    q: 'I already run Grafana, Alertmanager or Uptime Kuma. Why this?',
    a: 'Keep them: Kubernanny reads them. Firing Alertmanager alerts and the monitors of Uptime Kuma and Gatus show up next to its own checks. What it adds is knowing your components without a dashboard or a rule written by you, and one answer on your phone. k9s and Lens stay the tools for exploring.',
  },
];

@Component({
  selector: 'kn-faq',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink],
  template: `
    <section id="faq" class="container faq" aria-labelledby="faq-title">
      <header class="head">
        <p class="eyebrow">Questions</p>
        <h2 id="faq-title">Before you install.</h2>
      </header>
      <div class="list">
        @for (item of questions; track item.q) {
          <details [open]="$first">
            <summary>{{ item.q }}</summary>
            <p>{{ item.a }}</p>
            @if (item.link) {
              <a [routerLink]="item.link.route">{{ item.link.label }}</a>
            }
          </details>
        }
      </div>
    </section>
  `,
  styles: `
    :host {
      display: block;
    }
    .faq {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 28px;
      padding-top: 96px;
    }
    @media (min-width: 960px) {
      .faq {
        grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.6fr);
        gap: 56px;
      }
    }
    h2 {
      margin: 14px 0 0;
      font-size: clamp(2.125rem, 1.6rem + 2.2vw, 3.25rem);
      font-weight: 800;
      letter-spacing: -0.03em;
    }
    .list {
      border-top: 1px solid var(--line);
    }
    details {
      border-bottom: 1px solid var(--line);
    }
    summary {
      position: relative;
      padding: 20px 40px 20px 0;
      font-size: 1.125rem;
      font-weight: 650;
      cursor: pointer;
      list-style: none;
    }
    summary::-webkit-details-marker {
      display: none;
    }
    summary::after {
      content: '';
      position: absolute;
      right: 8px;
      top: 50%;
      width: 9px;
      height: 9px;
      border-right: 2px solid var(--mute);
      border-bottom: 2px solid var(--mute);
      transform: translateY(-70%) rotate(45deg);
      transition: transform 0.15s ease;
    }
    details[open] summary::after {
      transform: translateY(-30%) rotate(-135deg);
    }
    summary:hover {
      color: var(--accent);
    }
    summary:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 4px;
      border-radius: 4px;
    }
    details p {
      margin: 0 0 16px;
      max-width: 68ch;
      color: var(--ink-2);
    }
    details a {
      display: inline-block;
      margin-bottom: 20px;
      font-weight: 650;
    }
  `,
})
export class FaqComponent {
  protected readonly questions = QUESTIONS;
}
