import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AlertController, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonTitle, IonToolbar } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { AgentClient, describeError, deviceName } from '../core/agent-client.service';
import { AgentInfo } from '../core/agent.model';
import { ClusterStore } from '../core/cluster-store.service';
import { adoptedRelay } from '../core/relay-route';
import { ScanPairing } from '../core/scan/scan-pairing.service';
import { StatusStore } from '../core/status-store.service';
import { LanguageService } from '../i18n/language.service';
import { AgentSectionComponent } from './agent-section.component';
import { DevicesSectionComponent } from './devices-section.component';
import { MaintenanceSectionComponent } from './maintenance-section.component';
import { PairingSectionComponent } from './pairing-section.component';
import { PushSectionComponent } from './push-section.component';
import { PushRegistration } from '../core/push/push-registration.service';
import { RelaySectionComponent } from './relay-section.component';
import { WidgetSectionComponent } from './widget-section.component';

@Component({
  selector: 'app-cluster-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TranslocoDirective,
    FormsModule,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonButton,
    IonContent,
    IonIcon,
    AgentSectionComponent,
    RelaySectionComponent,
    MaintenanceSectionComponent,
    DevicesSectionComponent,
    PairingSectionComponent,
    WidgetSectionComponent,
    PushSectionComponent,
  ],
  template: `
    <ng-container *transloco="let t">
      <ion-header class="ion-no-border">
        <ion-toolbar>
          <ion-buttons slot="start">
            <ion-back-button defaultHref="/" text="" />
          </ion-buttons>
          <ion-title>{{ isNew() ? t('form.titleNew') : t('form.titleEdit') }}</ion-title>
        </ion-toolbar>
      </ion-header>

      <ion-content class="ion-padding">
        <div class="wrap">
          @if (scanFirst()) {
            <ion-button class="scan" expand="block" (click)="scan()"><ion-icon slot="start" name="qr-code-outline" />{{ t('pair.scan.button') }}</ion-button>
            <p class="or"><span>{{ t('pair.scan.or') }}</span></p>
          }
          <form (ngSubmit)="save()">
            <label>
              <span>{{ t('form.name') }}</span>
              <input name="name" [placeholder]="t('form.namePlaceholder')" [ngModel]="name()" (ngModelChange)="name.set($event)" />
            </label>
            <label>
              <span>{{ t('form.url') }}</span>
              <input name="url" type="url" inputmode="url" autocapitalize="off" required placeholder="https://kubernanny.example.com" [ngModel]="url()" (ngModelChange)="url.set($event)" />
            </label>
            @if (isNew()) {
              <label>
                <span>{{ t('form.code') }}</span>
                <input name="code" autocapitalize="characters" autocomplete="off" required placeholder="ABCDE-23456" [ngModel]="code()" (ngModelChange)="code.set($event)" />
              </label>
              <p class="hint" [innerHTML]="t('form.hintNew')"></p>
            } @else {
              <p class="hint">{{ t('form.hintEdit') }}</p>
            }

            @if (result(); as r) {
              <p [class]="r.ok ? 'ok' : 'error'">{{ r.text }}</p>
            }
            <ion-button expand="block" type="submit" [fill]="unchanged() || scanFirst() ? 'outline' : 'solid'" [disabled]="testing()">{{ testing() ? t('form.connecting') : t('form.save') }}</ion-button>
          </form>

          @if (info(); as i) {
            <app-agent-section [cluster]="saved()" [info]="i" />
          }

          @if (!isNew()) {
            <app-relay-section [cluster]="saved()" [info]="info()" />

            <section>
              <h2>{{ t('form.checks') }}</h2>
              <p class="hint">{{ t('form.checksHint') }}</p>
              <ion-button fill="outline" [routerLink]="modulesLink()">{{ t('form.modules') }}</ion-button>
            </section>

            <app-push-section #pushSection [cluster]="saved()" />
            <app-maintenance-section [cluster]="saved()" />
            <app-widget-section [cluster]="saved()" [push]="pushSection" />
            <app-devices-section [cluster]="saved()" (revokedSelf)="forget($event)" />
            <app-pairing-section [cluster]="saved()" />
            <ion-button expand="block" fill="clear" color="danger" (click)="remove()">{{ t('form.removeCluster') }}</ion-button>
          }
        </div>
      </ion-content>
    </ng-container>
  `,
  styleUrl: './form-section.css',
  styles: `
    ion-toolbar {
      --background: var(--ground);
    }
    .wrap {
      max-width: 34rem;
      margin: 0 auto;
    }
    form {
      display: grid;
      gap: 1rem;
    }
    .scan {
      --border-radius: var(--radius-m);
      min-height: 3rem;
      font-weight: 650;
      margin: 0.25rem 0 0;
    }
    .or {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin: 1.25rem 0;
      color: var(--mute);
      font-size: 0.875rem;
    }
    .or::before,
    .or::after {
      content: '';
      flex: 1;
      border-top: 1px solid var(--line);
    }
    .ok {
      color: var(--ok);
      margin: 0;
    }
    .error {
      color: var(--crit);
      margin: 0;
    }
  `,
})
export class ClusterFormPage implements OnInit {
  /** Route parameter; absent on /cluster/new. */
  readonly id = input<string>();

  private readonly store = inject(ClusterStore);
  private readonly status = inject(StatusStore);
  private readonly client = inject(AgentClient);
  private readonly router = inject(Router);
  private readonly alerts = inject(AlertController);
  private readonly language = inject(LanguageService);
  private readonly push = inject(PushRegistration);
  /** "QR-Code scannen" above the form for a new cluster, where this device can scan. */
  private readonly scanner = inject(ScanPairing);
  /** The scan button leads; the form's own button steps back to outline. */
  readonly scanFirst = computed(() => !this.id() && this.scanner.available());

  readonly isNew = signal(true);
  readonly modulesLink = computed(() => `/cluster/${this.id()}/modules`);
  readonly name = signal('');
  readonly url = signal('https://');
  readonly code = signal('');
  readonly testing = signal(false);
  readonly result = signal<{ ok: boolean; text: string } | null>(null);
  readonly info = signal<AgentInfo | null>(null);
  readonly saved = computed(() => {
    const id = this.id();
    return id ? this.store.clusters().find((c) => c.id === id) : undefined;
  });
  /** An existing cluster with name and address as saved: saving is offered, not pressed on (outline, not filled). */
  readonly unchanged = computed(() => {
    const s = this.saved();
    return !this.isNew() && s !== undefined && s.name === this.name().trim() && s.url === this.url().trim();
  });

  async ngOnInit(): Promise<void> {
    await this.store.loaded;
    const existing = this.id() ? this.store.find(this.id()!) : undefined;
    if (existing) {
      this.isNew.set(false);
      this.name.set(existing.name);
      this.url.set(existing.url);
      // The maintenance window comes with the status; opened straight from a link, there may be none yet.
      if (!this.status.states()[existing.id]?.snapshot) {
        void this.status.refresh(existing);
      }
      this.client.info(existing).then(
        (i) => {
          this.info.set(i);
          void this.adoptRelay(i);
        },
        () => undefined,
      );
    }
  }

  scan(): void {
    void this.scanner.start();
  }

  /**
   * New: fetches the agent key (https, localhost or this origin only), pairs
   * with the code and saves. Existing: saves only after the agent answered at
   * the new address with the pinned key, so no broken cluster lands in the list.
   */
  async save(): Promise<void> {
    this.testing.set(true);
    this.result.set(null);
    const url = this.url().trim().replace(/\/+$/, '');
    try {
      let saved;
      if (this.isNew()) {
        const { publicKey } = await this.client.identity(url);
        const { cluster, ...connection } = await this.client.pair(url, publicKey, this.code(), deviceName(navigator.userAgent, this.language.translator().t('common.device')));
        saved = await this.store.save({ ...connection, name: this.name().trim() || cluster });
      } else {
        const existing = this.store.find(this.id()!)!;
        const snapshot = await this.client.status({ ...existing, url });
        saved = await this.store.save({ ...existing, url, name: this.name().trim() || snapshot.cluster });
      }
      void this.status.refresh(saved);
      await this.router.navigate(['/c', saved.id], { replaceUrl: true });
    } catch (err) {
      this.result.set({ ok: false, text: describeError(err, this.language.translator()) });
    } finally {
      this.testing.set(false);
    }
  }

  /**
   * The agent says which relay it uses, in an authenticated answer: a relay
   * switched on after pairing reaches the app this way. Agents before the
   * relay send no `relay` field and change nothing.
   */
  private async adoptRelay(info: AgentInfo): Promise<void> {
    const cluster = this.saved();
    const change = cluster ? adoptedRelay(cluster, info) : null;
    if (cluster && change) {
      await this.store.save({ ...cluster, ...change });
    }
  }

  async remove(): Promise<void> {
    const id = this.id();
    if (!id) {
      return;
    }
    const tr = this.language.translator();
    const alert = await this.alerts.create({
      header: tr.t('form.removeTitle'),
      message: tr.t('form.removeText'),
      buttons: [
        { text: tr.t('common.cancel'), role: 'cancel' },
        { text: tr.t('common.remove'), role: 'destructive' },
      ],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    if (role !== 'destructive') {
      return;
    }
    await this.forget(id);
  }

  /** Drops the cluster from this device and goes back to the list. */
  async forget(id: string): Promise<void> {
    // Off at the agent if it still answers, and the push key leaves the device in any case.
    const cluster = this.store.find(id);
    if (cluster) {
      await this.push.forget(cluster);
    }
    await this.store.remove(id);
    this.status.forget(id);
    await this.router.navigateByUrl('/', { replaceUrl: true });
  }
}
