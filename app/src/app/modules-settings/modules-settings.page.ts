import { ChangeDetectionStrategy, Component, OnInit, computed, inject, input, signal } from '@angular/core';
import { IonBackButton, IonButtons, IonContent, IonHeader, IonIcon, IonSpinner, IonTitle, IonToggle, IonToolbar, ToastController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { AgentClient, describeError } from '../core/agent-client.service';
import { ClusterConfig, ModuleSetting, SettingsPatch, SettingsView, ToggleState } from '../core/agent.model';
import { ClusterStore } from '../core/cluster-store.service';
import { StatusStore } from '../core/status-store.service';
import { LanguageService } from '../i18n/language.service';
import { Translator } from '../i18n/translator';

interface Row {
  key: string;
  icon: string;
  title: string;
  note: string;
  /** What the module sends out of the cluster, when it does. */
  privacy?: string;
  on: boolean;
  locked: boolean;
  patch: (on: boolean) => SettingsPatch;
}

function moduleRow(m: ModuleSetting, tr: Translator): Row {
  const note =
    m.state === 'locked'
      ? tr.t('modules.locked')
      : !m.detected
        ? tr.t('modules.notDetected')
        : m.deep
          ? m.description
          : tr.t('modules.podsOnly', { description: m.description });
  return { key: `m:${m.id}`, icon: m.icon, title: m.name, note, privacy: m.privacy, on: m.state === 'on', locked: m.state === 'locked', patch: (on) => ({ modules: { [m.id]: on } }) };
}

/** Builds the sections once per answer; the template only reads plain properties. */
export function settingsSections(view: SettingsView, tr: Translator): { title: string; hint: string; rows: Row[] }[] {
  const core = view.modules.filter((m) => m.category === 'core');
  const found = view.modules.filter((m) => m.category !== 'core' && m.detected);
  const missing = view.modules.filter((m) => m.category !== 'core' && !m.detected);
  const state = (s: ToggleState) => ({ on: s === 'on', locked: s === 'locked' });
  const row = (m: ModuleSetting) => moduleRow(m, tr);
  return [
    { title: tr.t('modules.coreTitle'), hint: tr.t('modules.coreHint'), rows: core.map(row) },
    { title: tr.t('modules.foundTitle'), hint: tr.t('modules.foundHint'), rows: found.map(row) },
    {
      title: tr.t('modules.actionsTitle'),
      hint: tr.t('modules.actionsHint'),
      rows: view.actions.map((a) => ({
        key: `a:${a.type}`,
        icon: a.type === 'logs' ? 'document-text-outline' : 'flash-outline',
        title: a.label,
        note: a.state === 'locked' ? tr.t('modules.locked') : a.description,
        ...state(a.state),
        patch: (on: boolean) => ({ actions: { [a.type]: on } }),
      })),
    },
    {
      title: tr.t('modules.notificationsTitle'),
      hint: tr.t('modules.notificationsHint'),
      rows: [
        {
          key: 'n',
          icon: 'notifications-outline',
          title: tr.t('modules.sendNotifications'),
          note: view.notifications === 'locked' ? tr.t('modules.locked') : tr.t('modules.sendNotificationsNote'),
          ...state(view.notifications),
          patch: (on: boolean) => ({ notifications: on }),
        },
      ],
    },
    ...(missing.length ? [{ title: tr.t('modules.missingTitle'), hint: tr.t('modules.missingHint'), rows: missing.map(row) }] : []),
  ];
}

@Component({
  selector: 'app-modules-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonHeader, IonToolbar, IonTitle, IonButtons, IonBackButton, IonContent, IonToggle, IonIcon, IonSpinner],
  template: `
    <ng-container *transloco="let t">
      <ion-header class="ion-no-border">
        <ion-toolbar>
          <ion-buttons slot="start">
            <ion-back-button [defaultHref]="backHref()" text="" />
          </ion-buttons>
          <ion-title>{{ t('modules.title') }}</ion-title>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <div class="wrap">
          @if (error()) {
            <p class="error">{{ error() }}</p>
          }
          @if (sections(); as list) {
            @for (s of list; track s.title) {
              <section>
                <h2>{{ s.title }}</h2>
                <p class="hint">{{ s.hint }}</p>
                <ul>
                  @for (r of s.rows; track r.key) {
                    <li [class.locked]="r.locked">
                      <ion-icon [name]="r.icon" aria-hidden="true" />
                      <div>
                        <strong>{{ r.title }}</strong>
                        <span class="hint">{{ r.note }}</span>
                        @if (r.privacy) {
                          <span class="privacy"><ion-icon name="cloud-upload-outline" aria-hidden="true" />{{ r.privacy }}</span>
                        }
                      </div>
                      <ion-toggle [checked]="r.on" [disabled]="r.locked || saving()" (ionChange)="toggle(r, $event.detail.checked)" [attr.aria-label]="r.title" />
                    </li>
                  }
                </ul>
              </section>
            }
          } @else if (!error()) {
            <div class="page-spinner"><ion-spinner /></div>
          }
        </div>
      </ion-content>
    </ng-container>
  `,
  styles: `
    ion-toolbar {
      --background: var(--ground);
    }
    .wrap {
      max-width: 34rem;
      margin: 0 auto;
    }
    section {
      margin: 1.25rem 0 2rem;
    }
    h2 {
      font-size: 1.2rem;
      font-weight: 650;
      margin: 0 0 0.25rem;
    }
    .hint {
      color: var(--mute);
      font-size: 0.875rem;
      line-height: 1.45;
      margin: 0 0 0.75rem;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      background: var(--surface);
      border-radius: var(--radius-m);
    }
    li {
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 0.85rem;
      align-items: center;
      padding: 0.7rem 0.9rem;
    }
    li + li {
      border-top: 1px solid var(--line);
    }
    li ion-icon {
      font-size: 1.35rem;
      color: var(--accent);
    }
    li div {
      display: grid;
      gap: 0.15rem;
    }
    li .hint {
      margin: 0;
      font-size: 0.8125rem;
    }
    li .privacy {
      display: flex;
      gap: 0.35rem;
      align-items: flex-start;
      color: var(--ink-2);
      font-size: 0.8125rem;
      line-height: 1.4;
    }
    li .privacy ion-icon {
      flex: none;
      font-size: 0.95rem;
      margin-top: 0.05rem;
      color: var(--mute);
    }
    li.locked {
      opacity: 0.6;
    }
    .error {
      color: var(--crit);
    }
    .page-spinner {
      display: grid;
      place-items: center;
      padding: 4rem 0;
    }
  `,
})
export class ModulesSettingsPage implements OnInit {
  readonly id = input.required<string>();

  private readonly store = inject(ClusterStore);
  private readonly client = inject(AgentClient);
  private readonly status = inject(StatusStore);
  private readonly toasts = inject(ToastController);
  private readonly language = inject(LanguageService);

  private readonly view = signal<SettingsView | null>(null);
  readonly sections = computed(() => {
    const v = this.view();
    return v ? settingsSections(v, this.language.translator()) : null;
  });
  readonly saving = signal(false);
  readonly error = signal('');
  readonly backHref = computed(() => `/cluster/${this.id()}`);
  private cluster: ClusterConfig | undefined;

  async ngOnInit(): Promise<void> {
    await this.store.loaded;
    this.cluster = this.store.find(this.id());
    if (!this.cluster) {
      this.error.set(this.language.translator().t('modules.clusterNotFound'));
      return;
    }
    try {
      this.view.set(await this.client.settings(this.cluster));
    } catch (err) {
      this.error.set(describeError(err, this.language.translator()));
    }
  }

  async toggle(row: Row, on: boolean): Promise<void> {
    if (!this.cluster || on === row.on) {
      return;
    }
    this.saving.set(true);
    try {
      this.view.set(await this.client.changeSettings(this.cluster, row.patch(on)));
      void this.status.refresh(this.cluster);
    } catch (err) {
      // Re-render from the last known state, so the toggle springs back.
      this.view.set(this.view() ? { ...this.view()! } : null);
      const toast = await this.toasts.create({ message: describeError(err, this.language.translator()), duration: 3000, position: 'bottom' });
      await toast.present();
    } finally {
      this.saving.set(false);
    }
  }
}
