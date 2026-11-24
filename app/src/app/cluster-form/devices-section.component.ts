import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, output, signal } from '@angular/core';
import { AlertController, IonButton, ToastController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { AgentClient, DeviceView, describeError } from '../core/agent-client.service';
import { ClusterConfig } from '../core/agent.model';
import { LanguageService } from '../i18n/language.service';
import { deviceRows } from './devices-view';

/** The devices paired with the agent; any of them can be revoked, this one included. */
@Component({
  selector: 'app-devices-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonButton],
  template: `
    <ng-container *transloco="let t">
      @if (devices().length > 0) {
        <section>
          <h2>{{ t('form.devices') }}</h2>
          <p class="hint">{{ t('form.devicesHint') }}</p>
          <ul class="devices">
            @for (d of devices(); track d.id) {
              <li>
                <div>
                  <strong>{{ d.name }}</strong>
                  @if (d.current) {
                    <span class="pill tone-ok">{{ t('common.thisDevice') }}</span>
                  }
                  <span class="hint">{{ d.meta }}</span>
                </div>
                <ion-button fill="clear" color="danger" size="small" (click)="revoke(d.id, d.name, d.current)">{{ t('common.remove') }}</ion-button>
              </li>
            }
          </ul>
        </section>
      }
    </ng-container>
  `,
  styleUrl: './form-section.css',
  styles: `
    :host {
      display: block;
    }
    .devices {
      list-style: none;
      margin: 0;
      padding: 0;
      background: var(--surface);
      border-radius: var(--radius-m);
    }
    .devices li {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      padding: 0.6rem 0.4rem 0.6rem 1rem;
    }
    .devices li + li {
      border-top: 1px solid var(--line);
    }
    .devices div {
      display: flex;
      flex-wrap: wrap;
      gap: 0.25rem 0.5rem;
      align-items: center;
    }
    .devices .hint {
      flex-basis: 100%;
    }
  `,
})
export class DevicesSectionComponent implements OnInit {
  readonly cluster = input<ClusterConfig>();
  /** This device was revoked: the agent no longer answers it, so the page forgets the cluster. */
  readonly revokedSelf = output<string>();

  private readonly client = inject(AgentClient);
  private readonly alerts = inject(AlertController);
  private readonly toasts = inject(ToastController);
  private readonly language = inject(LanguageService);

  private readonly list = signal<DeviceView[]>([]);
  readonly devices = computed(() => deviceRows(this.list(), new Date(), this.language.translator()));

  ngOnInit(): void {
    void this.load();
  }

  private async load(): Promise<void> {
    const cluster = this.cluster();
    if (!cluster) {
      return;
    }
    try {
      this.list.set(await this.client.devices(cluster));
    } catch {
      this.list.set([]);
    }
  }

  async revoke(id: string, name: string, current: boolean): Promise<void> {
    const cluster = this.cluster();
    if (!cluster) {
      return;
    }
    const tr = this.language.translator();
    const alert = await this.alerts.create({
      header: tr.t('form.revokeTitle', { name }),
      message: tr.t(current ? 'form.revokeCurrent' : 'form.revokeOther'),
      buttons: [
        { text: tr.t('common.cancel'), role: 'cancel' },
        { text: tr.t('common.remove'), role: 'destructive' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'destructive') {
      return;
    }
    try {
      await this.client.revokeDevice(cluster, id);
    } catch (err) {
      const toast = await this.toasts.create({ message: describeError(err, this.language.translator()), duration: 3000, position: 'bottom' });
      await toast.present();
      return;
    }
    if (current) {
      this.revokedSelf.emit(cluster.id);
      return;
    }
    await this.load();
  }
}
