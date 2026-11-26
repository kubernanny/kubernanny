import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { ActionSheetController, IonButton, ToastController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';

import { maintenanceChoices, maintenanceView } from '../cluster/maintenance-view';
import { ClusterConfig } from '../core/agent.model';
import { AgentClient, describeError } from '../core/agent-client.service';
import { StatusStore } from '../core/status-store.service';
import { LanguageService } from '../i18n/language.service';

/** Starts and ends a maintenance window, during which the agent sends no notifications. */
@Component({
  selector: 'app-maintenance-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonButton],
  template: `
    <ng-container *transloco="let t">
      <section class="maintenance">
        <h2>{{ t('maintenance.title') }}</h2>
        <p class="hint">{{ t('maintenance.hint') }}</p>
        @if (maintenance().active) {
          <div class="maintenance-active">
            <span class="pill tone-warning">{{ maintenance().status }}</span>
            <ion-button fill="outline" [disabled]="busy()" (click)="end()">{{
              t('maintenance.end')
            }}</ion-button>
          </div>
        } @else {
          <ion-button fill="outline" [disabled]="busy()" (click)="start()">{{
            t('maintenance.start')
          }}</ion-button>
        }
      </section>
    </ng-container>
  `,
  styleUrl: './form-section.css',
  styles: `
    :host {
      display: block;
    }
    .maintenance-active {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.5rem 0.75rem;
    }
  `,
})
export class MaintenanceSectionComponent {
  readonly cluster = input<ClusterConfig>();

  private readonly status = inject(StatusStore);
  private readonly client = inject(AgentClient);
  private readonly sheets = inject(ActionSheetController);
  private readonly toasts = inject(ToastController);
  private readonly language = inject(LanguageService);

  private readonly now = signal(new Date());
  /** The answer of our own start or end, until the status catches up; null: none of ours yet. */
  private readonly override = signal<{ until: string | null } | null>(null);
  readonly busy = signal(false);

  readonly maintenance = computed(() => {
    const id = this.cluster()?.id;
    const override = this.override();
    const until = override
      ? override.until
      : id
        ? this.status.states()[id]?.snapshot?.maintenanceUntil
        : null;
    return maintenanceView(until, this.now(), this.language.translator());
  });

  constructor() {
    // An ended window disappears without a reload.
    const timer = setInterval(() => this.now.set(new Date()), 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  /** Asks for how long, like silencing an issue, then starts the window. */
  async start(): Promise<void> {
    const cluster = this.cluster();
    if (!cluster) {
      return;
    }
    const tr = this.language.translator();
    const sheet = await this.sheets.create({
      header: tr.t('maintenance.title'),
      subHeader: tr.t('maintenance.sheetText'),
      buttons: [
        ...maintenanceChoices(tr).map((c) => ({ text: c.label, data: c.hours })),
        { text: tr.t('common.cancel'), role: 'cancel' },
      ],
    });
    await sheet.present();
    const { data } = await sheet.onDidDismiss<number>();
    if (typeof data !== 'number') {
      return;
    }
    await this.change(async () => {
      const { maintenanceUntil } = await this.client.startMaintenance(cluster, data);
      this.override.set({ until: maintenanceUntil });
      return tr.t('maintenance.started', {
        time: maintenanceView(maintenanceUntil, new Date(), tr).time,
      });
    }, cluster);
  }

  async end(): Promise<void> {
    const cluster = this.cluster();
    if (!cluster) {
      return;
    }
    await this.change(async () => {
      await this.client.endMaintenance(cluster);
      this.override.set({ until: null });
      return this.language.translator().t('maintenance.ended');
    }, cluster);
  }

  private async change(work: () => Promise<string>, cluster: ClusterConfig): Promise<void> {
    this.busy.set(true);
    let message: string;
    try {
      message = await work();
      this.now.set(new Date());
      void this.status.refresh(cluster);
    } catch (err) {
      message = describeError(err, this.language.translator());
    } finally {
      this.busy.set(false);
    }
    const toast = await this.toasts.create({ message, duration: 3000, position: 'bottom' });
    await toast.present();
  }
}
