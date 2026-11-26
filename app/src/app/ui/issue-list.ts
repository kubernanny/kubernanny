import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { ActionSheetController, AlertController, IonIcon, IonSpinner, ModalController, ToastController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { ActionButton, IssueCard } from '../cluster/cluster-view';
import { AgentClient, describeError } from '../core/agent-client.service';
import { ClusterConfig } from '../core/agent.model';
import { TranslationKey } from '../i18n/dictionary';
import { LanguageService } from '../i18n/language.service';
import { LogsModal } from './logs-modal';
import { ACCEPT_CHOICES } from '../cluster/vulnerability-acceptance';

export const SILENCE_CHOICES: readonly { hours: number; label: TranslationKey }[] = [
  { hours: 1, label: 'issues.hour' },
  { hours: 8, label: 'issues.hours8' },
  { hours: 24, label: 'issues.day' },
  { hours: 168, label: 'issues.week' },
];

/** Problems with their cause and the actions the agent offers for them. */
@Component({
  selector: 'app-issue-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonIcon, IonSpinner],
  template: `
    <ng-container *transloco="let t">
      <ul>
        @for (item of cards(); track item.issue.id) {
          <li [class]="'tone-' + item.tone">
            <ion-icon [name]="item.icon" aria-hidden="true" />
            <div class="body">
              <div class="title">{{ item.issue.title }}</div>
              <p class="cause">{{ item.issue.cause }}</p>
              @if (item.advisoryLinks.length > 0) {
                <ul class="advisories" [attr.aria-label]="t('issues.advisories')">
                  @for (a of item.advisoryLinks; track a.id) {
                    <li>
                      <a [href]="a.url" target="_blank" rel="noopener noreferrer">{{ a.id }}<ion-icon name="open-outline" aria-hidden="true" /></a>
                      @if (item.acceptComponent) {
                        <button type="button" class="accept" [disabled]="busy() !== null" [attr.aria-label]="t('issues.acceptLabel', { id: a.id })" (click)="accept(item, a.id)">
                          {{ t('issues.accept') }}
                        </button>
                      }
                    </li>
                  }
                </ul>
              }
              <div class="meta">
                <span>
                  {{ item.area }}, {{ item.sinceText }}
                  @if (item.silencedText) {
                    <span class="silenced"><ion-icon name="notifications-off-outline" aria-hidden="true" />{{ item.silencedText }}</span>
                  }
                </span>
                @if (item.buttons.length === 0 && item.canSilence) {
                  <!-- Nothing to fix from here: the mute icon sits on this row instead of a row of its own. -->
                  <button type="button" class="quiet icon-only inline" [disabled]="busy() !== null" (click)="silence(item)" [attr.aria-label]="t('issues.silence')" [title]="t('issues.silence')">
                    <ion-icon name="notifications-off-outline" aria-hidden="true" />
                  </button>
                }
              </div>
              @if (item.buttons.length > 0 || item.silencedText) {
                <div class="actions">
                  @for (button of item.buttons; track button.type + button.index) {
                    @if (button.emphasis !== 'secondary') {
                    <button type="button" [class]="button.emphasis" [disabled]="busy() !== null" (click)="run(item, button)">
                      @if (busy() === item.issue.id + button.type + button.index) {
                        <ion-spinner name="crescent" />
                      } @else {
                        <ion-icon [name]="button.icon" aria-hidden="true" />
                      }
                      {{ button.label }}
                    </button>
                    }
                  }
                  @if (item.canSilence) {
                    <button type="button" class="quiet icon-only" [disabled]="busy() !== null" (click)="silence(item)" [attr.aria-label]="t('issues.silence')" [title]="t('issues.silence')">
                      <ion-icon name="notifications-off-outline" aria-hidden="true" />
                    </button>
                  } @else if (item.silencedText) {
                    <button type="button" class="quiet" [disabled]="busy() !== null" (click)="unsilence(item)">
                      <ion-icon name="notifications-outline" aria-hidden="true" />
                      {{ t('issues.unsilence') }}
                    </button>
                  }
                </div>
                <!-- A second choice (the crash loop's restart) sits on a row of its own, with when it helps. -->
                @for (button of item.buttons; track button.type + button.index) {
                  @if (button.emphasis === 'secondary') {
                    <div class="second">
                      <button type="button" class="secondary" [disabled]="busy() !== null" (click)="run(item, button)">
                        @if (busy() === item.issue.id + button.type + button.index) {
                          <ion-spinner name="crescent" />
                        } @else {
                          <ion-icon [name]="button.icon" aria-hidden="true" />
                        }
                        {{ button.label }}
                      </button>
                      @if (button.hint) {
                        <p class="hint">{{ button.hint }}</p>
                      }
                    </div>
                  }
                }
              }
            </div>
          </li>
        }
      </ul>
    </ng-container>
  `,
  styles: `
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 2px;
      grid-template-columns: minmax(0, 1fr);
      border-radius: var(--radius-l);
      overflow: hidden;
    }
    li {
      display: flex;
      gap: 0.85rem;
      min-width: 0;
      padding: 1rem 1rem 1rem 0.9rem;
      background: var(--surface);
      box-shadow: inset 3px 0 0 var(--tone);
    }
    ion-icon {
      flex: none;
      color: var(--tone);
      font-size: 1.3rem;
      margin-top: 0.1rem;
    }
    .body {
      min-width: 0;
      flex: 1;
    }
    .title {
      font-weight: 650;
      font-size: 1rem;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .cause {
      margin: 0.3rem 0 0;
      color: var(--ink-2);
      font-size: 0.9375rem;
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .meta {
      margin-top: 0.4rem;
      color: var(--mute);
      font-size: 0.8125rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.5rem;
    }
    .meta .inline {
      flex: none;
      padding: 0.35rem 0.5rem;
      margin: -0.35rem 0;
    }
    /* One row: what fixes it first, the quiet silence as an icon at the end; scrolls sideways rather than stacking. */
    .actions {
      display: flex;
      flex-wrap: nowrap;
      gap: 0.5rem;
      margin-top: 0.75rem;
      overflow-x: auto;
      scrollbar-width: none;
      /* Fades out at the right edge when the buttons go on past it, so the row reads as one that scrolls. */
      mask-image: linear-gradient(to right, #000 calc(100% - 1.25rem), transparent);
      padding-right: 1.25rem;
    }
    .actions button {
      flex: none;
      /* Each button keeps its one-line width; only a label wider than the whole row (large text) wraps instead of running under the fade. */
      max-width: 100%;
      text-align: left;
    }
    .actions .icon-only {
      padding: 0.5rem 0.6rem;
      margin-left: auto;
    }
    button {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.5rem 0.8rem;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: var(--raise);
      color: var(--ink);
      font: inherit;
      font-size: 0.875rem;
      font-weight: 600;
      cursor: pointer;
    }
    button ion-icon {
      color: var(--accent);
      font-size: 1rem;
      margin: 0;
    }
    button:hover:not(:disabled) {
      border-color: var(--accent);
    }
    button:disabled {
      opacity: 0.55;
      cursor: default;
    }
    ion-spinner {
      width: 1rem;
      height: 1rem;
    }
    button.quiet {
      background: transparent;
    }
    /* What to try first: filled. A second choice (the crash loop's restart): no fill, lighter text, explained by the hint below. */
    .actions button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--ion-color-primary-contrast);
    }
    .actions button.primary ion-icon {
      color: inherit;
    }
    .actions button.primary:hover:not(:disabled) {
      filter: brightness(1.08);
    }
    .second {
      margin-top: 0.6rem;
      padding-top: 0.6rem;
      border-top: 1px solid var(--line);
    }
    .second button.secondary {
      background: transparent;
      color: var(--ink-2);
      font-weight: 600;
      max-width: 100%;
      text-align: left;
    }
    .second button.secondary ion-icon {
      color: var(--mute);
    }
    .hint {
      margin: 0.4rem 0 0;
      color: var(--mute);
      font-size: 0.8125rem;
      line-height: 1.4;
    }
  `,
})
export class IssueList {
  readonly cards = input.required<IssueCard[]>();
  readonly cluster = input.required<ClusterConfig>();
  /** After an action ran, so the page can reload the status. */
  readonly changed = output<void>();

  private readonly client = inject(AgentClient);
  private readonly alerts = inject(AlertController);
  private readonly toasts = inject(ToastController);
  private readonly modals = inject(ModalController);
  private readonly sheets = inject(ActionSheetController);
  private readonly language = inject(LanguageService);
  readonly busy = signal<string | null>(null);

  async run(item: IssueCard, button: ActionButton): Promise<void> {
    if (button.type === 'logs') {
      const modal = await this.modals.create({
        component: LogsModal,
        componentProps: { cluster: this.cluster(), issueId: item.issue.id, index: button.index, title: item.issue.title },
      });
      await modal.present();
      return;
    }
    if (button.confirm && !(await this.confirm(button))) {
      return;
    }
    this.busy.set(item.issue.id + button.type + button.index);
    try {
      const { done } = await this.client.runAction(this.cluster(), item.issue.id, button.type, button.index);
      await this.toast(done, 'success');
    } catch (err) {
      await this.toast(describeError(err, this.language.translator()), 'danger');
    } finally {
      this.busy.set(null);
      this.changed.emit();
    }
  }

  /** Asks for how long, then silences: for a maintenance window or a known slow backup. */
  async silence(item: IssueCard): Promise<void> {
    const tr = this.language.translator();
    const sheet = await this.sheets.create({
      header: tr.t('issues.silenceHeader'),
      subHeader: tr.t('issues.silenceText'),
      buttons: [...SILENCE_CHOICES.map((c) => ({ text: tr.t(c.label), data: c.hours })), { text: tr.t('common.cancel'), role: 'cancel' }],
    });
    await sheet.present();
    const { data } = await sheet.onDidDismiss<number>();
    if (typeof data !== 'number') {
      return;
    }
    await this.busyWhile(item.issue.id + 'silence', async () => {
      await this.client.silence(this.cluster(), item.issue.id, data);
      await this.toast(this.language.translator().t('issues.silenced'), 'success');
    });
  }

  /** Asks for how long and, optionally, why; then marks the advisory as not applicable on this component. */
  async accept(item: IssueCard, advisory: string): Promise<void> {
    const component = item.acceptComponent;
    if (!component) {
      return;
    }
    const tr = this.language.translator();
    const sheet = await this.sheets.create({
      header: tr.t('issues.acceptHeader', { id: advisory }),
      subHeader: tr.t('issues.acceptText'),
      buttons: [...ACCEPT_CHOICES.map((c) => ({ text: tr.t(c.label), data: c.days })), { text: tr.t('common.cancel'), role: 'cancel' }],
    });
    await sheet.present();
    const { data: days } = await sheet.onDidDismiss<number>();
    if (typeof days !== 'number') {
      return;
    }
    const alert = await this.alerts.create({
      header: tr.t('issues.acceptReasonHeader'),
      inputs: [{ name: 'reason', type: 'text', placeholder: tr.t('issues.acceptReasonPlaceholder'), attributes: { maxlength: 200 } }],
      buttons: [
        { text: tr.t('common.cancel'), role: 'cancel' },
        { text: tr.t('issues.acceptConfirm'), role: 'confirm' },
      ],
    });
    await alert.present();
    const { role, data } = await alert.onDidDismiss<{ values?: { reason?: string } }>();
    if (role !== 'confirm') {
      return;
    }
    const reason = data?.values?.reason?.trim() || undefined;
    await this.busyWhile(item.issue.id + 'accept' + advisory, async () => {
      await this.client.acceptAdvisory(this.cluster(), component, advisory, days, reason);
      await this.toast(this.language.translator().t('issues.accepted'), 'success');
    });
  }

  async unsilence(item: IssueCard): Promise<void> {
    await this.busyWhile(item.issue.id + 'unsilence', async () => {
      await this.client.unsilence(this.cluster(), item.issue.id);
      await this.toast(this.language.translator().t('issues.unsilenced'), 'success');
    });
  }

  private async busyWhile(key: string, work: () => Promise<void>): Promise<void> {
    this.busy.set(key);
    try {
      await work();
    } catch (err) {
      await this.toast(describeError(err, this.language.translator()), 'danger');
    } finally {
      this.busy.set(null);
      this.changed.emit();
    }
  }

  private async confirm(button: ActionButton): Promise<boolean> {
    const alert = await this.alerts.create({
      header: button.label,
      message: button.confirm ?? '',
      buttons: [
        { text: this.language.translator().t('common.cancel'), role: 'cancel' },
        { text: button.label, role: 'confirm' },
      ],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    return role === 'confirm';
  }

  private async toast(message: string, color: 'success' | 'danger'): Promise<void> {
    const toast = await this.toasts.create({ message, color, duration: 3500, position: 'bottom' });
    await toast.present();
  }
}
