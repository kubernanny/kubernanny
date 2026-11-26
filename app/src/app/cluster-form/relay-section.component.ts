import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';

import { AgentInfo, ClusterConfig } from '../core/agent.model';
import { ClusterStore } from '../core/cluster-store.service';
import { LanguageService } from '../i18n/language.service';

/** The relay the agent reports, whether it is connected, and this device's switch to use it. */
@Component({
  selector: 'app-relay-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <section>
        <h2>{{ t('form.relay') }}</h2>
        @if (relay(); as r) {
          <dl>
            <div>
              <dt>{{ t('form.relayAddress') }}</dt>
              <dd>
                <code>{{ r.url }}</code>
              </dd>
            </div>
            <div>
              <dt>{{ t('form.relayConnected') }}</dt>
              <dd>{{ r.connected }}</dd>
            </div>
          </dl>
          <label class="toggle">
            <input type="checkbox" [checked]="r.on" (change)="toggleRelay()" />
            <span>{{ t('form.relayUse') }}</span>
          </label>
          <p class="hint">{{ t('form.relayHint') }}</p>
        } @else {
          <p class="hint" [innerHTML]="t('form.noRelay')"></p>
        }
      </section>
    </ng-container>
  `,
  styleUrl: './form-section.css',
  styles: `
    :host {
      display: block;
    }
  `,
})
export class RelaySectionComponent {
  readonly cluster = input<ClusterConfig>();
  readonly info = input<AgentInfo | null>(null);

  private readonly store = inject(ClusterStore);
  private readonly language = inject(LanguageService);

  readonly relay = computed(() => {
    const c = this.cluster();
    if (!c?.relayUrl) {
      return null;
    }
    const status = this.info()?.relay;
    const tr = this.language.translator();
    return {
      url: c.relayUrl,
      on: !c.relayOff,
      connected: tr.t(status ? (status.connected ? 'form.yes' : 'form.notNow') : 'form.unknown'),
    };
  });

  async toggleRelay(): Promise<void> {
    const cluster = this.cluster();
    if (cluster) {
      await this.store.save({ ...cluster, relayOff: !cluster.relayOff });
    }
  }
}
