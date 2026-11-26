import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { AlertController, IonIcon, ModalController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';

import { SyncOffer, SyncOptions } from '../core/agent.model';
import { LanguageService } from '../i18n/language.service';
import { Translator } from '../i18n/translator';
import { needsSyncSheet, SyncOptionsView, syncOptionsView } from './sync-options';

/**
 * The confirmation of a sync that has more to decide than yes or no: what a
 * prune would delete (each resource, and a second question before it does),
 * and after a sync Kubernetes refused, its message and the options that can
 * get past it. Nothing is ticked at first: a plain sync stays the default.
 */
@Component({
  selector: 'app-sync-options',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonIcon],
  template: `
    <ng-container *transloco="let t">
      <div class="scroll">
        <header>
          <span class="icon"><ion-icon name="sync-outline" aria-hidden="true" /></span>
          <div>
            <h1 class="display">{{ view.title }}</h1>
            <p class="muted">{{ t('syncOptions.intro') }}</p>
          </div>
        </header>
        @if (view.failure; as f) {
          <section class="failure" role="note">
            <h2>
              <ion-icon name="alert-circle" aria-hidden="true" />{{ t('syncOptions.failed') }}
            </h2>
            <code>{{ f.message }}</code>
            <p>{{ f.explanation }}</p>
            @if (view.serverSideOn) {
              <p class="muted small">{{ view.serverSideOn }}</p>
            }
          </section>
        }
        @if (view.prune || view.serverSide || view.replace) {
          <h2 class="label">{{ t('syncOptions.choose') }}</h2>
          <div class="options">
            @if (view.prune; as o) {
              <label
                class="option"
                data-option="prune"
                [class.off]="!o.enabled"
                [class.on]="prune()"
              >
                <input
                  type="checkbox"
                  [disabled]="!o.enabled"
                  [checked]="prune()"
                  (change)="prune.set($any($event.target).checked)"
                />
                <span class="body">
                  <strong>{{ o.title }}</strong>
                  <span class="text">{{ o.intro }}</span>
                  <ul class="res">
                    @for (r of o.resources; track r.key) {
                      <li><ion-icon name="trash-outline" aria-hidden="true" />{{ r.text }}</li>
                    }
                  </ul>
                  @if (o.note) {
                    <span class="note">{{ o.note }}</span>
                  }
                </span>
              </label>
            }
            @if (view.serverSide; as o) {
              <label class="option" data-option="ssa" [class.on]="serverSide()">
                <input
                  type="checkbox"
                  [checked]="serverSide()"
                  (change)="serverSide.set($any($event.target).checked)"
                />
                <span class="body">
                  <strong
                    >{{ o.title }}
                    @if (o.recommended) {
                      <span class="tag">{{ t('syncOptions.recommended') }}</span>
                    }
                  </strong>
                  <span class="text">{{ o.text }}</span>
                </span>
              </label>
            }
            @if (view.replace; as o) {
              <label
                class="option"
                data-option="replace"
                [class.off]="!o.enabled"
                [class.on]="replace()"
              >
                <input
                  type="checkbox"
                  [disabled]="!o.enabled"
                  [checked]="replace()"
                  (change)="replace.set($any($event.target).checked)"
                />
                <span class="body">
                  <strong
                    >{{ o.title }}
                    @if (o.recommended) {
                      <span class="tag">{{ t('syncOptions.recommended') }}</span>
                    }
                  </strong>
                  <span class="text">{{ o.text }}</span>
                  @if (o.note) {
                    <span class="note">{{ o.note }}</span>
                  }
                </span>
              </label>
            }
          </div>
        }
      </div>
      <footer>
        <div class="actions">
          <button type="button" class="cancel" (click)="cancel()">{{ t('common.cancel') }}</button>
          <button type="button" class="go" [class.danger]="prune()" (click)="go()">
            <ion-icon [name]="prune() ? 'trash-outline' : 'sync-outline'" aria-hidden="true" />
            {{ goLabel() }}
          </button>
        </div>
      </footer>
    </ng-container>
  `,
  styles: `
    /* An auto-height sheet (ion-modal.sheet.fit): only as tall as its content, scrolling past 85 % of the screen. */
    .scroll {
      max-height: calc(85vh - 5rem);
      overflow-y: auto;
      padding: 1.75rem 1rem 0.5rem;
    }
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
      font-size: 1.45rem;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    header p {
      margin: 0.25rem 0 0;
      font-size: 0.9375rem;
    }
    .failure {
      background: var(--crit-soft);
      border-radius: var(--radius-m);
      padding: 0.85rem 1rem;
      margin-bottom: 1.25rem;
    }
    .failure h2 {
      display: flex;
      align-items: center;
      gap: 0.4rem;
      margin: 0 0 0.5rem;
      font-size: 0.9375rem;
      font-weight: 700;
      color: var(--crit);
    }
    .failure code {
      display: block;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.78rem;
      line-height: 1.45;
      color: var(--ink-2);
      overflow-wrap: anywhere;
    }
    .failure p {
      margin: 0.6rem 0 0;
      font-size: 0.875rem;
      line-height: 1.45;
    }
    .small {
      font-size: 0.8125rem;
    }
    .label {
      margin: 0 0 0.5rem;
      color: var(--mute);
      font-size: 0.75rem;
      font-weight: 600;
    }
    .options {
      display: grid;
      gap: 0.6rem;
    }
    .option {
      display: flex;
      gap: 0.75rem;
      align-items: flex-start;
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: var(--radius-m);
      padding: 0.8rem 0.9rem;
      cursor: pointer;
    }
    .option.on {
      border-color: var(--accent);
    }
    .option[data-option='prune'].on {
      border-color: var(--crit);
    }
    .option.off {
      cursor: default;
    }
    .option.off strong,
    .option.off .text {
      color: var(--mute);
    }
    input {
      flex: none;
      width: 1.2rem;
      height: 1.2rem;
      margin: 0.15rem 0 0;
      accent-color: var(--accent);
    }
    .option[data-option='prune'] input {
      accent-color: var(--crit);
    }
    .body {
      display: grid;
      gap: 0.3rem;
      min-width: 0;
    }
    strong {
      font-size: 0.9875rem;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.4rem;
    }
    .tag {
      font-size: 0.6875rem;
      font-weight: 700;
      padding: 0.1rem 0.45rem;
      border-radius: 999px;
      background: var(--ok-soft);
      color: var(--ok);
    }
    .text {
      font-size: 0.875rem;
      line-height: 1.45;
      color: var(--ink-2);
    }
    .note {
      font-size: 0.8125rem;
      color: var(--mute);
    }
    .res {
      list-style: none;
      margin: 0.1rem 0 0;
      padding: 0;
      display: grid;
      gap: 0.2rem;
    }
    .res li {
      display: flex;
      gap: 0.4rem;
      align-items: baseline;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.8125rem;
      overflow-wrap: anywhere;
    }
    .res ion-icon {
      flex: none;
      color: var(--warn);
      position: relative;
      top: 0.1rem;
    }
    footer {
      background: var(--surface);
      border-top: 1px solid var(--line);
    }
    .actions {
      display: flex;
      gap: 0.6rem;
      padding: 0.75rem 1rem calc(0.75rem + var(--ion-safe-area-bottom, 0px));
    }
    .actions button {
      font: inherit;
      font-weight: 600;
      font-size: 0.9375rem;
      border-radius: 999px;
      padding: 0.75rem 1rem;
      cursor: pointer;
    }
    .cancel {
      flex: none;
      background: var(--raise);
      border: 1px solid var(--line);
      color: var(--ink);
    }
    .go {
      flex: 1;
      display: inline-flex;
      justify-content: center;
      align-items: center;
      gap: 0.45rem;
      border: none;
      background: var(--accent);
      color: var(--ion-color-primary-contrast);
    }
    .go.danger {
      background: var(--crit);
    }
  `,
})
export class SyncOptionsSheet implements OnInit {
  // Plain fields: set through ModalController's componentProps.
  app = '';
  offer!: SyncOffer;

  private readonly modals = inject(ModalController);
  private readonly alerts = inject(AlertController);
  private readonly language = inject(LanguageService);
  view!: SyncOptionsView;
  readonly prune = signal(false);
  readonly serverSide = signal(false);
  readonly replace = signal(false);
  private readonly tr = signal<Translator | null>(null);
  readonly goLabel = computed(() => {
    const tr = this.tr();
    if (!tr) {
      return '';
    }
    return this.prune()
      ? tr.n('syncOptions.syncAndDelete', this.offer.prune.length)
      : tr.t('syncOptions.sync');
  });

  ngOnInit(): void {
    const tr = this.language.translator();
    this.tr.set(tr);
    this.view = syncOptionsView(this.app, this.offer, tr);
  }

  cancel(): Promise<boolean> {
    return this.modals.dismiss(null, 'cancel');
  }

  /** With prune ticked, one more question naming what goes: deleting is the one choice that cannot be undone. */
  async go(): Promise<void> {
    const tr = this.language.translator();
    const prune = this.prune() && this.view.prune !== null;
    if (prune) {
      const alert = await this.alerts.create({
        header: tr.n('syncOptions.confirmDeleteHeader', this.offer.prune.length),
        message: tr.t('syncOptions.confirmDelete', {
          app: this.app,
          list: this.view.prune!.resources.map((r) => r.text).join(', '),
        }),
        buttons: [
          { text: tr.t('common.cancel'), role: 'cancel' },
          { text: tr.t('syncOptions.confirmDeleteButton'), role: 'destructive' },
        ],
      });
      await alert.present();
      if ((await alert.onDidDismiss()).role !== 'destructive') {
        return;
      }
    }
    const options: SyncOptions = {
      ...(prune ? { prune: this.view.prune!.resources.map((r) => r.key) } : {}),
      ...(this.serverSide() && this.view.serverSide ? { serverSideApply: true } : {}),
      ...(this.replace() && this.view.replace?.enabled ? { replace: true } : {}),
    };
    await this.modals.dismiss(options, 'confirm');
  }
}

/**
 * Asks before a sync: the plain question when there is nothing more to
 * decide, else the sheet. Resolves to the options to send (empty for a plain
 * sync), or null when cancelled.
 */
export async function confirmSync(
  deps: { modals: ModalController; alerts: AlertController; tr: Translator },
  app: string,
  offer: SyncOffer | undefined,
  label: string,
): Promise<SyncOptions | null> {
  const { modals, alerts, tr } = deps;
  if (!needsSyncSheet(offer)) {
    const alert = await alerts.create({
      header: label,
      message: tr.t('actions.syncConfirm', { app }),
      buttons: [
        { text: tr.t('common.cancel'), role: 'cancel' },
        { text: label, role: 'confirm' },
      ],
    });
    await alert.present();
    return (await alert.onDidDismiss()).role === 'confirm' ? {} : null;
  }
  const modal = await modals.create({
    component: SyncOptionsSheet,
    cssClass: ['sheet', 'fit'],
    breakpoints: [0, 1],
    initialBreakpoint: 1,
    componentProps: { app, offer },
  });
  await modal.present();
  const { data, role } = await modal.onDidDismiss<SyncOptions | null>();
  return role === 'confirm' && data ? data : null;
}
