import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { AlertController, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonSpinner, IonToolbar, ModalController, ToastController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { AgentClient, describeError } from '../core/agent-client.service';
import { ClusterConfig, PendingSync } from '../core/agent.model';
import { LanguageService } from '../i18n/language.service';
import { PendingSyncRow, pendingSyncRows } from './pending-syncs';

/** "Bereit zum Sync": manual Argo CD apps with a change waiting, what the change is, and the sync where the agent offers it. */
@Component({
  selector: 'app-pending-sync-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonHeader, IonToolbar, IonButtons, IonButton, IonContent, IonIcon, IonSpinner],
  template: `
    <ng-container *transloco="let t">
      <ion-header>
        <ion-toolbar>
          <ion-buttons slot="end">
            <ion-button (click)="close()">{{ t('common.close') }}</ion-button>
          </ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <header>
          <span class="icon"><ion-icon name="sync-outline" aria-hidden="true" /></span>
          <div>
            <h1 class="display">{{ t('pendingSync.title') }}</h1>
            <p class="muted">{{ t('pendingSync.intro') }}</p>
          </div>
        </header>
        <ul class="apps">
          @for (r of rows(); track r.key) {
            <li>
              <div class="top">
                <div class="names">
                  <strong>{{ r.app }}</strong>
                  @if (r.where) {
                    <span class="muted">{{ r.where }}</span>
                  }
                  <span class="muted">{{ r.since }}</span>
                </div>
                @if (r.canSync && !synced().has(r.id)) {
                  <button type="button" class="sync" [disabled]="busy() !== null" (click)="sync(r)">
                    @if (busy() === r.id) {
                      <ion-spinner name="crescent" />
                    } @else {
                      <ion-icon name="sync-outline" aria-hidden="true" />
                    }
                    {{ t('pendingSync.sync') }}
                  </button>
                }
              </div>
              <dl>
                @if (r.revisions) {
                  <div>
                    <dt>{{ t('pendingSync.revisions') }}</dt>
                    <dd><code>{{ r.revisions }}</code></dd>
                  </div>
                }
                @if (r.images.length > 0) {
                  <div>
                    <dt>{{ t('pendingSync.images') }}</dt>
                    @for (i of r.images; track i) {
                      <dd><code>{{ i }}</code></dd>
                    }
                  </div>
                }
                @if (r.resources.length > 0) {
                  <div>
                    <dt>{{ t('pendingSync.resources') }}</dt>
                    @for (x of r.resources; track x.key) {
                      <dd class="res">
                        <span>{{ x.text }}</span>
                        <span [class]="'change ' + x.change">{{ x.label }}</span>
                      </dd>
                    }
                  </div>
                }
              </dl>
            </li>
          }
        </ul>
        @if (anyWithoutSync()) {
          <p class="muted note">{{ t('pendingSync.noSync') }}</p>
        }
      </ion-content>
    </ng-container>
  `,
  styles: `
    header {
      display: flex;
      gap: 1rem;
      align-items: center;
      margin-bottom: 1.25rem;
    }
    .icon {
      flex: none;
      width: 3.25rem;
      height: 3.25rem;
      border-radius: 16px;
      display: grid;
      place-items: center;
      background: var(--raise);
      color: var(--accent);
      font-size: 1.6rem;
    }
    h1 {
      font-size: 1.6rem;
      font-weight: 700;
    }
    header p {
      margin: 0.25rem 0 0;
      font-size: 0.9375rem;
    }
    .apps {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 0.75rem;
    }
    .apps > li {
      background: var(--surface);
      border-radius: var(--radius-l);
      padding: 0.9rem 1rem;
    }
    .top {
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
      align-items: flex-start;
    }
    .names {
      display: grid;
      gap: 0.1rem;
      min-width: 0;
    }
    .names strong {
      font-size: 1.05rem;
      overflow-wrap: break-word;
    }
    .names .muted {
      font-size: 0.8125rem;
    }
    .sync {
      flex: none;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.5rem 0.85rem;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: var(--raise);
      color: var(--ink);
      font: inherit;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
    }
    .sync ion-spinner {
      width: 1rem;
      height: 1rem;
    }
    dl {
      margin: 0.75rem 0 0;
      display: grid;
      gap: 0.6rem;
    }
    dt {
      color: var(--mute);
      font-size: 0.75rem;
      font-weight: 600;
    }
    dd {
      margin: 0.15rem 0 0;
      font-size: 0.875rem;
      overflow-wrap: break-word;
    }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8125rem;
      color: var(--ink-2);
    }
    .res {
      display: flex;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .res span:first-child {
      min-width: 0;
      overflow-wrap: break-word;
    }
    .change {
      flex: none;
      color: var(--mute);
    }
    .change.new {
      color: var(--ok);
    }
    .change.prune {
      color: var(--warn);
    }
    .note {
      font-size: 0.875rem;
      margin-top: 1rem;
    }
  `,
})
export class PendingSyncSheet implements OnInit {
  // Plain fields: set through ModalController's componentProps.
  pending: PendingSync[] = [];
  cluster!: ClusterConfig;
  now = new Date();

  private readonly modals = inject(ModalController);
  private readonly alerts = inject(AlertController);
  private readonly toasts = inject(ToastController);
  private readonly client = inject(AgentClient);
  private readonly language = inject(LanguageService);
  readonly rows = signal<PendingSyncRow[]>([]);
  readonly anyWithoutSync = signal(false);
  readonly busy = signal<string | null>(null);
  /** Apps synced from here: their button goes; the next status no longer lists them once Argo CD is done. */
  readonly synced = signal<ReadonlySet<string>>(new Set());
  private changed = false;

  ngOnInit(): void {
    this.rows.set(pendingSyncRows(this.pending, this.now, this.language.translator()));
    this.anyWithoutSync.set(this.pending.some((p) => !p.canSync));
  }

  async sync(row: PendingSyncRow): Promise<void> {
    const tr = this.language.translator();
    const alert = await this.alerts.create({
      message: row.syncConfirm,
      buttons: [
        { text: tr.t('common.cancel'), role: 'cancel' },
        { text: tr.t('pendingSync.sync'), role: 'confirm' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm') {
      return;
    }
    this.busy.set(row.id);
    try {
      const { done } = await this.client.runAction(this.cluster, row.id, 'argocd-sync', 0);
      this.synced.update((s) => new Set([...s, row.id]));
      this.changed = true;
      await this.toast(done, 'success');
    } catch (err) {
      await this.toast(describeError(err, tr), 'danger');
    } finally {
      this.busy.set(null);
    }
  }

  private async toast(message: string, color: 'success' | 'danger'): Promise<void> {
    const toast = await this.toasts.create({ message, color, duration: 3500, position: 'bottom' });
    await toast.present();
  }

  close(): Promise<boolean> {
    return this.modals.dismiss({ changed: this.changed });
  }
}
