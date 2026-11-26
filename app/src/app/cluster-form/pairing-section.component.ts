import { ChangeDetectionStrategy, Component, inject, input, signal } from '@angular/core';
import { IonButton, ToastController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';

import { ClusterConfig } from '../core/agent.model';
import { AgentClient, describeError } from '../core/agent-client.service';
import { externalUrl } from '../core/external-url';
import { pairingRoute } from '../core/pairing-link';
import { LanguageService } from '../i18n/language.service';

/** Asks the agent for a one-time pairing code, to add another device. */
@Component({
  selector: 'app-pairing-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonButton],
  template: `
    <ng-container *transloco="let t">
      <section>
        <h2>{{ t('form.pairAnother') }}</h2>
        @if (pairing(); as p) {
          <p class="hint">{{ t('form.codeHint') }}</p>
          <p class="code display">{{ p.display }}</p>
          @if (p.app) {
            <a class="link" [href]="p.app">{{ p.app }}</a>
          }
          @if (p.web) {
            <a class="link" [href]="p.web" target="_blank" rel="noopener noreferrer">{{ p.web }}</a>
          }
        } @else {
          <ion-button fill="outline" (click)="newCode()">{{ t('form.newCode') }}</ion-button>
        }
      </section>
    </ng-container>
  `,
  styleUrl: './form-section.css',
  styles: `
    :host {
      display: block;
    }
    .code {
      font-size: 2rem;
      font-weight: 700;
      letter-spacing: 0.08em;
      margin: 0.5rem 0;
    }
    .link {
      display: block;
      font-size: 0.8125rem;
      overflow-wrap: anywhere;
      margin-bottom: 0.4rem;
    }
  `,
})
export class PairingSectionComponent {
  readonly cluster = input<ClusterConfig>();

  private readonly client = inject(AgentClient);
  private readonly toasts = inject(ToastController);
  private readonly language = inject(LanguageService);

  readonly pairing = signal<{ display: string; app: string | null; web: string | null } | null>(
    null,
  );

  async newCode(): Promise<void> {
    const cluster = this.cluster();
    if (!cluster) {
      return;
    }
    try {
      const { code, app, web } = await this.client.newPairingCode(cluster);
      // Links from the agent: only a real pairing link and a web address are offered.
      this.pairing.set({
        display: `${code.slice(0, 5)}-${code.slice(5)}`,
        app: pairingRoute(app) ? app : null,
        web: externalUrl(web),
      });
    } catch (err) {
      const toast = await this.toasts.create({
        message: describeError(err, this.language.translator()),
        duration: 3000,
        position: 'bottom',
      });
      await toast.present();
    }
  }
}
