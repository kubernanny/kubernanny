import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { IonButton, ToastController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { AgentClient, describeError } from '../core/agent-client.service';
import { AgentPushView, ClusterConfig } from '../core/agent.model';
import { NativePushStatus, PushNative } from '../core/push/push-native';
import { PushRegistration } from '../core/push/push-registration.service';
import { pushView } from '../core/push/push-view';
import { LanguageService } from '../i18n/language.service';

/**
 * "Push to this device": native push straight from the agent, sealed for
 * this device (docs/NOTIFICATIONS.md). Hidden unless this build can push
 * (the iOS or Android app with Firebase configured) and the agent answered;
 * locked when the deployment switched it off. The notification permission
 * is asked for only on the tap, never at start.
 */
@Component({
  selector: 'app-push-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonButton],
  template: `
    <ng-container *transloco="let t">
      @if (view().visible) {
        <section>
          <h2>{{ t('push.title') }}</h2>
          <p class="hint" [class.locked]="view().locked">{{ view().note }}</p>
          <div class="actions">
            @if (view().action) {
              <ion-button fill="outline" [disabled]="busy()" (click)="toggle()">{{ view().actionLabel }}</ion-button>
            }
            @if (view().canTest) {
              <ion-button fill="clear" [disabled]="busy()" (click)="test()">{{ t('push.test') }}</ion-button>
            }
          </div>
        </section>
      }
    </ng-container>
  `,
  styleUrl: './form-section.css',
  styles: `
    :host {
      display: block;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .locked::before {
      content: '🔒 ';
    }
  `,
})
export class PushSectionComponent {
  readonly cluster = input<ClusterConfig>();

  private readonly native = inject(PushNative);
  private readonly registration = inject(PushRegistration);
  private readonly client = inject(AgentClient);
  private readonly toasts = inject(ToastController);
  private readonly language = inject(LanguageService);

  private readonly nativeStatus = signal<NativePushStatus | null>(null);
  private readonly agent = signal<AgentPushView | null>(null);
  readonly busy = signal(false);

  readonly view = computed(() => pushView({ demo: !!this.cluster()?.demo, native: this.nativeStatus(), agent: this.agent() }, this.language.translator()));

  constructor() {
    void this.native.status().then((s) => this.nativeStatus.set(s));
    effect(() => {
      const cluster = this.cluster();
      if (cluster && !cluster.demo) {
        void this.load(cluster);
      }
    });
  }

  private async load(cluster: ClusterConfig): Promise<void> {
    try {
      this.agent.set(await this.client.pushState(cluster));
    } catch {
      // An agent before native push (no /push) or out of reach: the section stays hidden.
      this.agent.set(null);
    }
  }

  async toggle(): Promise<void> {
    const cluster = this.cluster();
    const action = this.view().action;
    if (!cluster || !action) {
      return;
    }
    const tr = this.language.translator();
    this.busy.set(true);
    try {
      if (action === 'enable') {
        const outcome = await this.registration.enable(cluster);
        await this.toast(tr.t(outcome === 'enabled' ? 'push.enabled' : outcome === 'denied' ? 'push.denied' : 'push.noRelay'));
      } else {
        await this.registration.disable(cluster);
        await this.toast(tr.t('push.disabled'));
      }
      await this.load(cluster);
    } catch (err) {
      await this.toast(describeError(err, tr));
    } finally {
      this.busy.set(false);
    }
  }

  async test(): Promise<void> {
    const cluster = this.cluster();
    if (!cluster) {
      return;
    }
    const tr = this.language.translator();
    this.busy.set(true);
    try {
      const { outcome } = await this.client.testPush(cluster);
      await this.toast(outcome === 'sent' ? tr.t('push.testSent') : tr.t('push.testFailed', { outcome }));
    } catch (err) {
      await this.toast(describeError(err, tr));
    } finally {
      this.busy.set(false);
    }
  }

  private async toast(message: string): Promise<void> {
    const toast = await this.toasts.create({ message, duration: 3000, position: 'bottom' });
    await toast.present();
  }
}
