import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { NetworkView, Tone } from '../../core/agent.model';
import { Loadable } from '../../core/cluster-data.store';
import { externalUrl } from '../../core/external-url';
import { LanguageService } from '../../i18n/language.service';
import { Translator } from '../../i18n/translator';

export interface HostRow {
  key: string;
  host: string;
  /** Null for a host that is no address to open (a wildcard, a bare name). */
  url: string | null;
  tone: Tone;
  cert: string;
  detail: string;
}

const RANK: Record<Tone, number> = { critical: 0, warning: 1, ok: 2, muted: 3 };

/** Every host with its certificate; the ones that need attention first. */
export function hostRows(view: NetworkView | null, tr: Translator): HostRow[] {
  const rows = (view?.ingresses ?? []).flatMap((ing) =>
    (ing.hosts.length ? ing.hosts : [ing.name]).map((host) => {
      const days = ing.certificate?.daysLeft ?? null;
      const tone: Tone = !ing.tls ? 'muted' : ing.certificate && !ing.certificate.ready ? 'critical' : days === null ? 'ok' : days < 3 ? 'critical' : days < 14 ? 'warning' : 'ok';
      const cert = !ing.tls ? tr.t('network.noTls') : days === null ? tr.t('network.tls') : days < 0 ? tr.t('network.expired') : tr.n('network.certDays', days);
      return {
        key: `${ing.namespace}/${ing.name}/${host}`,
        host,
        url: externalUrl(`${ing.tls ? 'https' : 'http'}://${host}`),
        tone,
        cert,
        detail: [ing.component, `${ing.namespace}/${ing.backends.join(', ')}`, ing.workloads.length ? tr.t('network.workloads', { workloads: ing.workloads.join(', ') }) : null, ing.className].filter(Boolean).join(', '),
      };
    }),
  );
  return rows.sort((a, b) => RANK[a.tone] - RANK[b.tone] || a.host.localeCompare(b.host));
}

/** "10.0.0.5, Ports 80, 443" / "10.0.0.5, ports 80, 443" for each LoadBalancer service. */
export function loadBalancerRows(view: NetworkView | null, tr: Translator): { key: string; name: string; text: string }[] {
  return (view?.loadBalancers ?? []).map((lb) => ({
    key: `${lb.namespace}/${lb.name}`,
    name: `${lb.namespace}/${lb.name}`,
    text: tr.t('network.ports', { addresses: lb.addresses.join(', ') || tr.t('network.noIp'), ports: lb.ports.join(', ') }),
  }));
}

@Component({
  selector: 'app-network-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonIcon, IonSpinner],
  template: `
    <ng-container *transloco="let t">
      @if (network().loading && !network().value) {
        <div class="page-spinner"><ion-spinner /></div>
      }
      <h2>{{ t('network.addresses') }}</h2>
      <ul class="hosts">
        @for (h of hosts(); track h.key) {
          <li [class]="'tone-' + h.tone">
            @if (h.url) {
              <a [href]="h.url" target="_blank" rel="noopener noreferrer">
                <span class="host display">{{ h.host }}</span>
                <ion-icon name="open-outline" aria-hidden="true" />
              </a>
            } @else {
              <span class="host display">{{ h.host }}</span>
            }
            <span class="pill">{{ h.cert }}</span>
            <span class="muted detail">{{ h.detail }}</span>
          </li>
        }
      </ul>
      @if (loadBalancers().length > 0) {
        <h2>{{ t('network.loadBalancers') }}</h2>
        <ul class="lbs">
          @for (lb of loadBalancers(); track lb.key) {
            <li>
              <strong>{{ lb.name }}</strong>
              <span class="muted">{{ lb.text }}</span>
            </li>
          }
        </ul>
      }
    </ng-container>
  `,
  styles: `
    h2 {
      font-size: 1.1rem;
      font-weight: 650;
      margin: 0 0 0.6rem;
    }
    ul {
      list-style: none;
      margin: 0 0 1.75rem;
      padding: 0;
    }
    .hosts {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
      gap: 0.75rem;
    }
    .hosts li {
      background: var(--surface);
      border-radius: var(--radius-m);
      padding: 0.9rem 1rem;
      display: grid;
      gap: 0.45rem;
      justify-items: start;
      box-shadow: inset 3px 0 0 var(--tone);
    }
    a {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: var(--ink);
      text-decoration: none;
      max-width: 100%;
    }
    a ion-icon {
      color: var(--accent);
      flex: none;
    }
    .host {
      font-size: 1.1rem;
      font-weight: 650;
      overflow-wrap: anywhere;
    }
    .detail {
      font-size: 0.8125rem;
      overflow-wrap: anywhere;
    }
    .lbs li {
      background: var(--surface);
      border-radius: var(--radius-m);
      padding: 0.75rem 1rem;
      display: grid;
      gap: 0.2rem;
      margin-bottom: 0.5rem;
    }
    .lbs .muted {
      font-size: 0.8125rem;
    }
  `,
})
export class NetworkTab {
  readonly network = input.required<Loadable<NetworkView>>();
  private readonly language = inject(LanguageService);
  readonly hosts = computed(() => hostRows(this.network().value, this.language.translator()));
  readonly loadBalancers = computed(() => loadBalancerRows(this.network().value, this.language.translator()));
}
