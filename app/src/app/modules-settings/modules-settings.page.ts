import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  OnInit,
  signal,
} from '@angular/core';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonSpinner,
  IonTitle,
  IonToggle,
  IonToolbar,
  ToastController,
} from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';

import { helmSnippet } from '../cluster/cluster-view';
import {
  ClusterConfig,
  ModuleSetting,
  SettingsPatch,
  SettingsView,
  ToggleState,
} from '../core/agent.model';
import { AgentClient, describeError } from '../core/agent-client.service';
import { ClusterStore } from '../core/cluster-store.service';
import { copyText } from '../core/share';
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
  /** What an action may change in the cluster, in the agent's words. */
  effect?: string;
  on: boolean;
  locked: boolean;
  /** A locked action: why, in one short line, under its description. */
  why?: string;
  /** A locked opt-in action: the Helm values (YAML) that switch it on, to copy. */
  helm?: string;
  patch: (on: boolean) => SettingsPatch;
}

type ActionSetting = SettingsView['actions'][number];

function actionRow(a: ActionSetting, tr: Translator): Row {
  // Agents before lockedBy: a locked opt-in type is "not enabled", anything else locked "disabled".
  const lockedBy = a.lockedBy ?? (a.optIn ? 'opt-in' : 'disabled');
  const locked = a.state === 'locked';
  const helm = locked ? helmSnippet(a.type, lockedBy) : null;
  return {
    key: `a:${a.type}`,
    icon: a.type === 'logs' ? 'document-text-outline' : 'flash-outline',
    title: a.label,
    note: a.description,
    ...(locked
      ? {
          why: tr.t(lockedBy === 'opt-in' ? 'modules.lockedOptIn' : 'modules.lockedDisabled', {
            type: a.type,
          }),
        }
      : {}),
    ...(a.effect ? { effect: a.effect } : {}),
    on: a.state === 'on',
    locked,
    ...(helm ? { helm } : {}),
    patch: (on: boolean) => ({ actions: { [a.type]: on } }),
  };
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
  return {
    key: `m:${m.id}`,
    icon: m.icon,
    title: m.name,
    note,
    privacy: m.privacy,
    on: m.state === 'on',
    locked: m.state === 'locked',
    patch: (on) => ({ modules: { [m.id]: on } }),
  };
}

/** Builds the sections once per answer; the template only reads plain properties. */
export function settingsSections(
  view: SettingsView,
  tr: Translator,
): { title: string; hint: string; rows: Row[] }[] {
  const core = view.modules.filter((m) => m.category === 'core');
  const found = view.modules.filter((m) => m.category !== 'core' && m.detected);
  const missing = view.modules.filter((m) => m.category !== 'core' && !m.detected);
  const state = (s: ToggleState) => ({ on: s === 'on', locked: s === 'locked' });
  const row = (m: ModuleSetting) => moduleRow(m, tr);
  return [
    { title: tr.t('modules.coreTitle'), hint: tr.t('modules.coreHint'), rows: core.map(row) },
    { title: tr.t('modules.foundTitle'), hint: tr.t('modules.foundHint'), rows: found.map(row) },
    // Actions in three groups: what runs, what the app switched off (and can switch on), what only the deployment can.
    ...(
      [
        ['on', 'modules.actionsTitle', 'modules.actionsHint'],
        ['off', 'modules.actionsOffTitle', 'modules.actionsOffHint'],
        ['locked', 'modules.actionsLockedTitle', 'modules.actionsLockedHint'],
      ] as const
    )
      .map(([s, title, hint]) => ({
        title: tr.t(title),
        hint: tr.t(hint),
        rows: view.actions.filter((a) => a.state === s).map((a) => actionRow(a, tr)),
      }))
      .filter((section) => section.rows.length > 0),
    {
      title: tr.t('modules.notificationsTitle'),
      hint: tr.t('modules.notificationsHint'),
      rows: [
        {
          key: 'n',
          icon: 'notifications-outline',
          title: tr.t('modules.sendNotifications'),
          note:
            view.notifications === 'locked'
              ? tr.t('modules.locked')
              : tr.t('modules.sendNotificationsNote'),
          ...state(view.notifications),
          patch: (on: boolean) => ({ notifications: on }),
        },
      ],
    },
    ...(missing.length
      ? [
          {
            title: tr.t('modules.missingTitle'),
            hint: tr.t('modules.missingHint'),
            rows: missing.map(row),
          },
        ]
      : []),
  ];
}

@Component({
  selector: 'app-modules-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TranslocoDirective,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButtons,
    IonBackButton,
    IonContent,
    IonToggle,
    IonIcon,
    IonSpinner,
  ],
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
                          <span class="privacy"
                            ><ion-icon name="cloud-upload-outline" aria-hidden="true" />{{
                              r.privacy
                            }}</span
                          >
                        }
                        @if (r.effect) {
                          <span class="privacy"
                            ><ion-icon name="key-outline" aria-hidden="true" />{{ r.effect }}</span
                          >
                        }
                        @if (r.why) {
                          <span class="why">{{ r.why }}</span>
                        }
                        @if (r.helm) {
                          <div class="snippet">
                            <pre>{{ r.helm }}</pre>
                            <button
                              type="button"
                              (click)="copy(r.helm)"
                              [attr.aria-label]="t('issues.copyLine')"
                              [title]="t('issues.copyLine')"
                            >
                              <ion-icon name="copy-outline" aria-hidden="true" />
                            </button>
                          </div>
                        }
                      </div>
                      @if (r.locked) {
                        <!-- Only the deployment can switch it: no switch, a lock. -->
                        <ion-icon
                          class="lock"
                          name="lock-closed-outline"
                          [attr.aria-label]="t('modules.lockedLabel')"
                        />
                      } @else {
                        <ion-toggle
                          [checked]="r.on"
                          [disabled]="saving()"
                          (ionChange)="toggle(r, $event.detail.checked)"
                          [attr.aria-label]="r.title"
                        />
                      }
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
      /* minmax(0, 1fr): a long line in the middle wraps instead of widening the row past the card. */
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 0.85rem;
      align-items: center;
      padding: 0.7rem 0.9rem;
    }
    li + li {
      border-top: 1px solid var(--line);
    }
    .why {
      color: var(--ink-2);
      font-weight: 600;
      font-size: 0.8125rem;
      line-height: 1.4;
    }
    .snippet {
      position: relative;
      margin-top: 0.35rem;
      min-width: 0;
    }
    .snippet pre {
      margin: 0;
      padding: 0.55rem 2.6rem 0.55rem 0.7rem;
      background: var(--ground);
      border: 1px solid var(--line);
      border-radius: var(--radius-s, 6px);
      color: var(--ink-2);
      font-size: 0.8125rem;
      line-height: 1.45;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .snippet button {
      position: absolute;
      top: 0.25rem;
      right: 0.25rem;
      display: grid;
      place-items: center;
      width: 2rem;
      height: 2rem;
      border: 0;
      border-radius: var(--radius-s, 6px);
      background: transparent;
      color: var(--accent);
      cursor: pointer;
    }
    .snippet button ion-icon {
      font-size: 1.05rem;
      color: inherit;
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
    li ion-icon {
      font-size: 1.35rem;
      color: var(--accent);
    }
    li div {
      display: grid;
      gap: 0.15rem;
      min-width: 0;
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
    /* Long rows: the icon and the lock stay beside the title, not in the middle of the text. */
    li.locked {
      align-items: start;
    }
    li.locked > ion-icon {
      margin-top: 0.1rem;
    }
    li.locked > ion-icon:first-child,
    li .lock {
      color: var(--mute);
    }
    li .lock {
      font-size: 1.15rem;
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
      const toast = await this.toasts.create({
        message: describeError(err, this.language.translator()),
        duration: 3000,
        position: 'bottom',
      });
      await toast.present();
    } finally {
      this.saving.set(false);
    }
  }

  /** The Helm values line of a locked action. */
  async copy(line: string): Promise<void> {
    const tr = this.language.translator();
    const ok = await copyText(line);
    const toast = await this.toasts.create({
      message: tr.t(ok ? 'common.copied' : 'issues.copyFailed'),
      duration: 2000,
      position: 'bottom',
    });
    await toast.present();
  }
}
