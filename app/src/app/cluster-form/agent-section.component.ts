import { KNOWN_AGENT_VERSION } from '../core/version';
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { IonButton, ToastController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { fingerprint, parsePublicKey } from '@kubernanny/protocol';
import { AgentClient, describeError } from '../core/agent-client.service';
import { AgentInfo, ClusterConfig } from '../core/agent.model';
import { LanguageService } from '../i18n/language.service';

/** What the agent says about itself, the pinned key, and a test of its notification channels. */
@Component({
  selector: 'app-agent-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonButton],
  template: `
    <ng-container *transloco="let t">
      <section>
        <h2>{{ t('form.agent') }}</h2>
        <dl>
          <div><dt>{{ t('form.version') }}</dt><dd>{{ info().agentVersion }}</dd></div>
          @if (build(); as b) {
            <div><dt>{{ t('form.build') }}</dt><dd><code>{{ b }}</code></dd></div>
          }
          <div><dt>{{ t('form.appVersion') }}</dt><dd>{{ appVersion }}</dd></div>
          <div><dt>{{ t('form.interval') }}</dt><dd>{{ t('form.seconds', { count: info().intervalSeconds }) }}</dd></div>
          <div><dt>{{ t('form.prometheus') }}</dt><dd>{{ info().prometheus ? t('form.prometheusFound') : t('form.prometheusMissing') }}</dd></div>
          <div><dt>{{ t('form.components') }}</dt><dd>{{ info().components.length }}</dd></div>
          @if (pinnedFingerprint()) {
            <div><dt>{{ t('form.agentKey') }}</dt><dd><code>{{ pinnedFingerprint() }}</code></dd></div>
          }
          <div><dt>{{ t('form.notifications') }}</dt><dd>{{ channels() }}</dd></div>
        </dl>
        @if (info().channels.length > 0) {
          <ion-button fill="outline" (click)="testPush()">{{ t('form.testPush') }}</ion-button>
        } @else {
          <p class="hint" [innerHTML]="t('form.notifyHint', { minutes: info().notifyAfterSeconds / 60 })"></p>
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
export class AgentSectionComponent {
  /** The version this app (or web UI) was built as, to compare with the agent's. */
  readonly appVersion = KNOWN_AGENT_VERSION;
  /** "2026-11-25-16 (a1b2c3d)": the image tag and commit CI baked into the agent; empty for a local build. */
  readonly build = computed(() => {
    const i = this.info();
    return i.agentBuild ? `${i.agentBuild}${i.agentCommit ? ` (${i.agentCommit.slice(0, 7)})` : ''}` : '';
  });
  readonly cluster = input<ClusterConfig>();
  readonly info = input.required<AgentInfo>();

  private readonly client = inject(AgentClient);
  private readonly toasts = inject(ToastController);
  private readonly language = inject(LanguageService);

  readonly pinnedFingerprint = computed(() => {
    const key = this.cluster()?.agentKey;
    try {
      return key ? fingerprint(parsePublicKey(key)) : '';
    } catch {
      return '';
    }
  });
  readonly channels = computed(() => {
    const c = this.info().channels;
    return c.length ? c.join(', ') : this.language.translator().t('form.noChannels');
  });

  async testPush(): Promise<void> {
    const cluster = this.cluster();
    if (!cluster) {
      return;
    }
    let message: string;
    try {
      const { channels } = await this.client.testNotification(cluster);
      message = this.language.translator().t('form.testSent', { channels: channels.join(', ') });
    } catch (err) {
      message = describeError(err, this.language.translator());
    }
    const toast = await this.toasts.create({ message, duration: 3000, position: 'bottom' });
    await toast.present();
  }
}
