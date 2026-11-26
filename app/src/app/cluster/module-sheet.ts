import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import {
  ActionSheetController,
  AlertController,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonToolbar,
  ModalController,
  ToastController,
} from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';

import { ClusterConfig, ModuleView, Tone } from '../core/agent.model';
import { AgentClient, describeError } from '../core/agent-client.service';
import { externalUrl } from '../core/external-url';
import { LanguageService } from '../i18n/language.service';
import { IssueList } from '../ui/issue-list';
import { AcceptedFindingRow, acceptedFindingRows } from './accepted-findings';
import { markRolledBack, RollbackRow, rollbackRows } from './argocd-rollback';
import { IssueCard, moduleRow } from './cluster-view';
import { DetailSectionView } from './detail-section';
import { buildSheetView, SheetView } from './module-sheet-view';
import { AcceptedRow, acceptedRows } from './vulnerability-acceptance';

/** Everything Kubernanny knows about one component: its numbers, its problems, its pods and where to open it. */
@Component({
  selector: 'app-module-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TranslocoDirective,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonButton,
    IonContent,
    IonIcon,
    IssueList,
    DetailSectionView,
  ],
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
        <header [class]="'tone-' + head().tone">
          <span class="icon"><ion-icon [name]="module.icon" aria-hidden="true" /></span>
          <div>
            <h1 class="display">{{ module.name }}</h1>
            <p class="muted">{{ module.description }}</p>
            @if (sheet().meta) {
              <p class="meta">{{ sheet().meta }}</p>
            }
          </div>
        </header>
        <p [class]="'summary tone-' + head().tone">
          <span class="pill">{{ head().statusLabel }}</span> {{ module.summary }}
        </p>
        @if (module.error) {
          <p class="error">{{ t('module.checkFailed', { error: module.error }) }}</p>
        }

        @if (links().length > 0) {
          <div class="links">
            @for (link of links(); track link.url) {
              <a [href]="link.url" target="_blank" rel="noopener noreferrer">
                <ion-icon name="open-outline" aria-hidden="true" />
                {{ link.label }}
              </a>
            }
          </div>
        }

        @if (sheet().figures.length > 0) {
          <dl
            class="figures"
            [attr.aria-label]="t('module.keyFigures')"
            [style.--n]="sheet().columns"
            [class.four]="sheet().columns === 4"
            [class.three]="sheet().columns === 3"
            [class.long]="sheet().longLabels"
          >
            @for (s of sheet().figures; track s.label) {
              <div [class]="'tone-' + (s.tone ?? 'muted')">
                <dt>{{ s.label }}</dt>
                <dd>{{ s.value }}</dd>
              </div>
            }
          </dl>
        }

        @if (issues().length > 0) {
          <h2>{{ t('module.issues') }}</h2>
          <app-issue-list [cards]="issues()" [cluster]="cluster" (changed)="changed.set(true)" />
        }

        @if (acceptedFindings().length > 0) {
          <section class="git-accepted">
            <button
              type="button"
              class="fold"
              [attr.aria-expanded]="acceptedOpen()"
              (click)="acceptedOpen.set(!acceptedOpen())"
            >
              <ion-icon name="checkmark-done-outline" aria-hidden="true" />
              <span>{{ t('module.acceptedInGit', { count: acceptedFindings().length }) }}</span>
              <ion-icon
                class="chev"
                [name]="acceptedOpen() ? 'chevron-up' : 'chevron-down'"
                aria-hidden="true"
              />
            </button>
            @if (acceptedOpen()) {
              <ul>
                @for (a of acceptedFindings(); track a.key) {
                  <li>
                    <div class="line">
                      <span class="wname">{{ a.name }}</span>
                      <code>{{ a.findingKey }}</code>
                    </div>
                    <span class="muted">{{ a.where }}: {{ a.finding }}</span>
                    <q class="reason">{{ a.reason }}</q>
                    <span class="source">{{ a.source }}</span>
                  </li>
                }
              </ul>
            }
          </section>
        }

        @for (sec of sheet().sections; track sec.key) {
          <app-detail-section
            [section]="sec"
            [expanded]="expanded().has(sec.key)"
            (toggled)="toggle(sec.key)"
          />
        }

        @if (rollbacks().length > 0) {
          <h2>{{ t('module.rollbackTitle') }}</h2>
          <p class="muted hint">{{ t('module.rollbackHint') }}</p>
          <ul class="accepted rollbacks">
            @for (r of rollbacks(); track r.key) {
              <li>
                <div>
                  <span class="wname">{{ r.app }}</span>
                  @if (r.now) {
                    <span class="muted">{{ r.now }}</span>
                  }
                </div>
                <button type="button" [disabled]="busy() !== null" (click)="rollback(r)">
                  {{ t('module.rollbackButton') }}
                </button>
              </li>
            }
          </ul>
        }

        @if (accepted().length > 0) {
          <h2>{{ t('module.acceptedTitle') }}</h2>
          <ul class="accepted">
            @for (a of accepted(); track a.key) {
              <li>
                <div>
                  @if (a.url) {
                    <a class="advisory" [href]="a.url" target="_blank" rel="noopener noreferrer">{{
                      a.advisory
                    }}</a>
                  } @else {
                    <span class="advisory">{{ a.advisory }}</span>
                  }
                  <span class="muted">{{ a.meta }}</span>
                  @if (a.reason) {
                    <span class="reason">{{ a.reason }}</span>
                  }
                </div>
                @if (a.canUndo) {
                  <button type="button" [disabled]="busy() !== null" (click)="unaccept(a)">
                    {{ t('module.unaccept') }}
                  </button>
                }
              </li>
            }
          </ul>
        }

        @if (module.workloads.items.length > 0 && !sheet().hasRuntime) {
          <h2>
            {{ t('module.workloads') }}
            <span class="count">{{
              t('module.podsReady', {
                ready: module.workloads.ready,
                total: module.workloads.total,
              })
            }}</span>
          </h2>
          <ul class="workloads">
            @for (w of module.workloads.items; track w.kind + w.namespace + w.name) {
              <li>
                <span class="wname">{{ w.name }}</span>
                <span class="muted">{{ w.kind }}, {{ w.namespace }}</span>
                <span
                  [class]="
                    'pill ' +
                    (w.ready >= w.desired
                      ? 'tone-ok'
                      : w.ready === 0
                        ? 'tone-critical'
                        : 'tone-warning')
                  "
                  >{{ w.ready }}/{{ w.desired }}</span
                >
              </li>
            }
          </ul>
        }
      </ion-content>
    </ng-container>
  `,
  styles: `
    header {
      display: flex;
      gap: 1rem;
      align-items: center;
      margin-bottom: 1rem;
    }
    .icon {
      flex: none;
      width: 3.25rem;
      height: 3.25rem;
      border-radius: 16px;
      display: grid;
      place-items: center;
      background: var(--tone-soft);
      color: var(--tone);
      font-size: 1.6rem;
    }
    h1 {
      font-size: 1.75rem;
      font-weight: 700;
    }
    header p {
      margin: 0.2rem 0 0;
    }
    .summary {
      font-size: 1rem;
      line-height: 1.5;
      margin: 0 0 1.25rem;
    }
    .error {
      color: var(--crit);
      font-size: 0.875rem;
    }
    .links {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      margin-bottom: 1.25rem;
    }
    .links a {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.5rem 0.85rem;
      border-radius: 999px;
      background: var(--raise);
      text-decoration: none;
      font-weight: 600;
      font-size: 0.875rem;
    }
    .meta {
      margin: 0.25rem 0 0;
      font-size: 0.8125rem;
      color: var(--mute);
      overflow-wrap: anywhere;
    }
    .figures {
      display: grid;
      grid-template-columns: repeat(var(--n, 3), minmax(0, 1fr));
      gap: 0.5rem;
      margin: 0 0 1.5rem;
    }
    @media (max-width: 459px) {
      .figures.four {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      /* Three figures with long words: the first spans the row, the other two share the next. */
      .figures.three.long {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .figures.three.long div:first-child {
        grid-column: 1 / -1;
      }
    }
    .figures div {
      background: var(--raise);
      border-radius: var(--radius-m);
      padding: 0.65rem 0.8rem 0.7rem;
      min-width: 0;
    }
    .figures dt {
      color: var(--mute);
      font-size: 0.75rem;
      line-height: 1.3;
      hyphens: auto;
    }
    .figures dd {
      margin: 0.2rem 0 0;
      font-family: var(--font-display);
      font-weight: 650;
      font-size: 1.2rem;
      line-height: 1.2;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .figures .tone-warning dd,
    .figures .tone-critical dd {
      color: var(--tone);
    }
    h2 {
      font-size: 1.1rem;
      font-weight: 650;
      margin: 1.5rem 0 0.6rem;
      display: flex;
      gap: 0.5rem;
      align-items: baseline;
      flex-wrap: wrap;
    }
    .count {
      color: var(--mute);
      font-family: var(--font-body);
      font-size: 0.875rem;
      font-weight: 500;
    }
    .workloads {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .workloads li {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 0 0.75rem;
      padding: 0.6rem 0;
      border-bottom: 1px solid var(--line);
    }
    .wname {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .workloads .muted {
      grid-row: 2;
      font-size: 0.8125rem;
    }
    .accepted {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .accepted li {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      justify-content: space-between;
      padding: 0.6rem 0;
      border-bottom: 1px solid var(--line);
    }
    .accepted li div {
      display: grid;
      gap: 0.15rem;
      min-width: 0;
    }
    .accepted .advisory {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.875rem;
      overflow-wrap: anywhere;
    }
    .accepted .muted,
    .accepted .reason {
      font-size: 0.8125rem;
      overflow-wrap: anywhere;
    }
    .accepted .reason {
      color: var(--ink-2);
    }
    .hint {
      font-size: 0.875rem;
      margin: 0 0 0.4rem;
    }
    .accepted button {
      flex: none;
      padding: 0.4rem 0.75rem;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: var(--raise);
      color: var(--ink);
      font: inherit;
      font-size: 0.8125rem;
      font-weight: 600;
      cursor: pointer;
    }
    .accepted button:disabled {
      opacity: 0.55;
    }
    .git-accepted {
      margin: 1rem 0 0;
      border-radius: var(--radius-m);
      background: var(--raise);
    }
    .git-accepted .fold {
      display: flex;
      align-items: center;
      gap: 0.55rem;
      width: 100%;
      padding: 0.75rem 0.9rem;
      border: 0;
      background: none;
      color: var(--ink-2);
      font: inherit;
      font-size: 0.9375rem;
      font-weight: 600;
      text-align: left;
      cursor: pointer;
    }
    .git-accepted .fold span {
      flex: 1;
    }
    .git-accepted .fold ion-icon {
      color: var(--mute);
      font-size: 1.1rem;
    }
    .git-accepted ul {
      list-style: none;
      margin: 0;
      padding: 0 0.9rem 0.4rem;
    }
    .git-accepted li {
      display: grid;
      gap: 0.2rem;
      padding: 0.7rem 0;
      border-top: 1px solid var(--line);
      min-width: 0;
    }
    .git-accepted .line {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 0.75rem;
    }
    .git-accepted code {
      flex: none;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.75rem;
      padding: 0.1rem 0.45rem;
      border-radius: 999px;
      background: var(--line);
      color: var(--ink-2);
    }
    .git-accepted .muted,
    .git-accepted .source {
      font-size: 0.8125rem;
      overflow-wrap: anywhere;
    }
    .git-accepted .reason {
      font-size: 0.875rem;
      color: var(--ink);
      overflow-wrap: anywhere;
    }
    .git-accepted .source {
      color: var(--mute);
      font-size: 0.75rem;
    }
    .workloads .pill {
      grid-row: 1 / span 2;
      grid-column: 2;
      align-self: center;
    }
  `,
})
export class ModuleSheet implements OnInit {
  // Plain fields: set through ModalController's componentProps.
  module!: ModuleView;
  cluster!: ClusterConfig;
  issueCards: IssueCard[] = [];

  private readonly modals = inject(ModalController);
  private readonly language = inject(LanguageService);
  private readonly client = inject(AgentClient);
  private readonly toasts = inject(ToastController);
  private readonly sheets = inject(ActionSheetController);
  private readonly alerts = inject(AlertController);
  /** The module as last known here; a rollback marks its new current deployment without waiting for the next run. */
  private readonly view = signal<ModuleView | null>(null);
  readonly rollbacks = computed<RollbackRow[]>(() => {
    const m = this.view();
    return m ? rollbackRows(m, this.language.translator()) : [];
  });
  /** Lists whose healthy rows are all shown. */
  readonly expanded = signal<ReadonlySet<string>>(new Set());
  readonly sheet = computed<SheetView>(() => {
    const m = this.view();
    return m
      ? buildSheetView(m, this.expanded(), this.language.translator())
      : { meta: '', figures: [], columns: 0, longLabels: false, hasRuntime: false, sections: [] };
  });
  readonly issues = signal<IssueCard[]>([]);
  readonly accepted = signal<AcceptedRow[]>([]);
  /** Security hints accepted in Git, folded until opened. */
  readonly acceptedFindings = signal<AcceptedFindingRow[]>([]);
  readonly acceptedOpen = signal(false);
  readonly busy = signal<string | null>(null);
  readonly changed = signal(false);
  readonly head = signal<{ tone: Tone; statusLabel: string }>({ tone: 'ok', statusLabel: '' });
  /** The component's links that are web addresses; anything else the agent sent is not offered. */
  readonly links = signal<{ url: string; label: string }[]>([]);

  ngOnInit(): void {
    const row = moduleRow(this.module, this.language.translator());
    this.head.set({ tone: row.tone, statusLabel: row.statusLabel });
    this.links.set(
      this.module.links.flatMap((l) => {
        const url = externalUrl(l.url);
        return url ? [{ url, label: l.label }] : [];
      }),
    );
    this.issues.set(this.issueCards);
    this.accepted.set(acceptedRows(this.module, this.language.translator()));
    this.acceptedFindings.set(acceptedFindingRows(this.module, this.language.translator()));
    this.view.set(this.module);
  }

  toggle(key: string): void {
    this.expanded.update((set) => {
      const next = new Set(set);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  }

  /** Earlier deployments to pick from, then a confirmation naming from and to; the agent reads the revision itself. */
  async rollback(row: RollbackRow): Promise<void> {
    const tr = this.language.translator();
    const sheet = await this.sheets.create({
      header: row.sheetTitle,
      subHeader: tr.t('module.rollbackSheetText'),
      buttons: [
        ...row.choices.map((c) => ({ text: c.label, data: c.id })),
        { text: tr.t('common.cancel'), role: 'cancel' },
      ],
    });
    await sheet.present();
    const { data: id } = await sheet.onDidDismiss<number>();
    const choice = row.choices.find((c) => c.id === id);
    if (!choice) {
      return;
    }
    const alert = await this.alerts.create({
      header: row.confirmTitle,
      message: choice.confirm,
      buttons: [
        { text: tr.t('common.cancel'), role: 'cancel' },
        { text: tr.t('module.rollbackConfirmButton'), role: 'confirm' },
      ],
    });
    await alert.present();
    if ((await alert.onDidDismiss()).role !== 'confirm') {
      return;
    }
    this.busy.set(row.key);
    try {
      const { done } = await this.client.rollbackArgoApp(
        this.cluster,
        row.namespace,
        row.app,
        choice.id,
      );
      this.view.update((m) => (m ? markRolledBack(m, row, choice.id) : m));
      this.changed.set(true);
      await this.toast(done, 'success');
    } catch (err) {
      await this.toast(describeError(err, tr), 'danger');
    } finally {
      this.busy.set(null);
    }
  }

  /** Lets the advisory count again; the page reloads the status when the sheet closes. */
  async unaccept(row: AcceptedRow): Promise<void> {
    this.busy.set(row.key);
    try {
      await this.client.unacceptAdvisory(this.cluster, row.component, row.advisory);
      this.accepted.update((rows) => rows.filter((r) => r.key !== row.key));
      this.changed.set(true);
      await this.toast(this.language.translator().t('issues.unaccepted'), 'success');
    } catch (err) {
      await this.toast(describeError(err, this.language.translator()), 'danger');
    } finally {
      this.busy.set(null);
    }
  }

  private async toast(message: string, color: 'success' | 'danger'): Promise<void> {
    const toast = await this.toasts.create({ message, color, duration: 3500, position: 'bottom' });
    await toast.present();
  }

  close(): Promise<boolean> {
    return this.modals.dismiss({ changed: this.changed() });
  }
}
