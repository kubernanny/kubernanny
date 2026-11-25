import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { IonIcon } from '@ionic/angular/standalone';
import { ClusterConfig, HistoryView, Series } from '../../core/agent.model';
import { Loadable } from '../../core/cluster-data.store';
import { AreaChart } from '../../ui/area-chart';
import { ResourceBar } from '../../ui/resource-bar';
import { ResourceRail } from '../resource-rail';
import { PendingSyncCard } from '../pending-sync-card';
import { IssueList } from '../../ui/issue-list';
import { LanguageService } from '../../i18n/language.service';
import { Translator } from '../../i18n/translator';
import { ClusterView, IssueCard } from '../cluster-view';
import { HistorySection } from '../history-section';
import { HistoryVM } from '../history-view';

const CHART_ORDER = ['cpu', 'memory', 'net-in', 'net-out', 'restarts', 'etcd-fsync', 'apiserver-p99'];
/** The time ranges of the usage charts. */
export function hourChoices(tr: Translator): { hours: number; label: string }[] {
  return [1, 6, 24, 168].map((hours) => ({ hours, label: hours < 48 ? tr.t('overview.hours', { count: hours }) : tr.t('overview.days', { count: hours / 24 }) }));
}

/** Warnings shown before "Alle N Warnungen zeigen". */
export const WARNINGS_SHOWN = 3;

export function foldIssues(cards: IssueCard[], all: boolean, tr: Translator): { shown: IssueCard[]; folded: number; moreLabel: string } {
  const critical = cards.filter((c) => c.issue.severity === 'critical');
  const rest = cards.filter((c) => c.issue.severity !== 'critical');
  const shown = all ? rest : rest.slice(0, WARNINGS_SHOWN);
  return { shown: [...critical, ...shown], folded: rest.length - shown.length, moreLabel: tr.t('overview.showWarnings', { n: rest.length }) };
}

@Component({
  selector: 'app-overview-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IssueList, AreaChart, IonIcon, HistorySection, ResourceBar, ResourceRail, PendingSyncCard],
  template: `
    <ng-container *transloco="let t">
      @if (view().update; as update) {
        <aside class="update">
          <ion-icon name="arrow-up-circle-outline" aria-hidden="true" />
          <div>
            <strong>{{ t('overview.updateTitle') }}</strong>
            <span class="muted">{{ update.text }}</span>
            <code>{{ update.command }}</code>
          </div>
        </aside>
      }

      @if (view().maintenance.active) {
        <aside class="maintenance" role="status">
          <ion-icon name="construct-outline" aria-hidden="true" />
          <span>{{ view().maintenance.banner }}</span>
        </aside>
      }

      <section>
        @if (view().issues.length > 0) {
          <h2>{{ t('overview.needsYou') }}</h2>
          <app-issue-list [cards]="fold().shown" [cluster]="cluster()" (changed)="changed.emit()" />
          @if (fold().folded > 0) {
            <button type="button" class="more" (click)="allWarnings.set(true)">{{ fold().moreLabel }}</button>
          }
        } @else if (view().light === 'green') {
          <div class="calm">
            <ion-icon name="checkmark-circle" aria-hidden="true" />
            <div>
              <strong>{{ t('overview.calmTitle') }}</strong>
              <span class="muted">{{ t('overview.calmText') }}</span>
            </div>
          </div>
        }
      </section>

      @if (view().pendingLabel) {
        <app-pending-sync-card class="pending" [label]="view().pendingLabel" [hint]="t('pendingSync.cardHint')" (open)="openPending.emit()" />
      }

      @if (view().hints.length > 0) {
        <section class="hints">
          <h2>{{ t('overview.hints') }} <span class="count">{{ view().hints.length }}</span></h2>
          @if (openHints()) {
            <p class="muted hint-intro">{{ t('overview.hintsIntro') }}</p>
            <app-issue-list [cards]="view().hints" [cluster]="cluster()" (changed)="changed.emit()" />
          } @else {
            <button type="button" class="more" (click)="openHints.set(true)">{{ t('overview.showHints', { n: view().hints.length }) }}</button>
          }
        </section>
      }

      @if (view().silenced.length > 0) {
        <section class="hints">
          <h2>{{ t('overview.silenced') }} <span class="count">{{ view().silenced.length }}</span></h2>
          @if (openSilenced()) {
            <p class="muted hint-intro">{{ t('overview.silencedIntro') }}</p>
            <app-issue-list [cards]="view().silenced" [cluster]="cluster()" (changed)="changed.emit()" />
          } @else {
            <button type="button" class="more" (click)="openSilenced.set(true)">{{ t('overview.showSilenced', { n: view().silenced.length }) }}</button>
          }
        </section>
      }

      @if (incidents(); as vm) {
        <app-history-section [vm]="vm" />
      }

      <section>
        <div class="section-head">
          <h2>{{ t('overview.usage') }}</h2>
          @if (view().hasPrometheus) {
            <div class="range" role="group" [attr.aria-label]="t('overview.range')">
              @for (choice of hourChoices(); track choice.hours) {
                <button type="button" [class.on]="choice.hours === hours()" [attr.aria-pressed]="choice.hours === hours()" (click)="setHours.emit(choice.hours)">
                  {{ choice.label }}
                </button>
              }
            </div>
          }
        </div>
        @if (charts().length > 0) {
          <div class="charts">
            @for (s of charts(); track s.id) {
              <div class="card">
                <app-area-chart [title]="s.label" [points]="s.points" [unit]="s.unit" [loading]="rangeLoading()" />
              </div>
            }
          </div>
          @if (history().value?.source === 'agent') {
            <p class="muted note">{{ t('overview.historyFromAgent') }}</p>
          }
        } @else if (history().loading) {
          <!-- First load: empty chart frames with a shimmer in the place the charts will take. -->
          <div class="charts" [attr.aria-label]="t('overview.loadingHistory')">
            @for (n of skeletons; track n) {
              <div class="card">
                <app-area-chart title="" [points]="[]" [loading]="true" />
              </div>
            }
          </div>
        } @else {
          <p class="muted note">{{ t('overview.noHistory') }}</p>
        }
      </section>

      <section class="kpi-section">
        <h2>{{ t('overview.keyFigures') }}</h2>
        <app-resource-rail [rail]="view().rail" [nodes]="false" />
      </section>

      @if (view().perNode.length > 0) {
        <section class="per-node">
          <h2>{{ t('resources.perNode') }}</h2>
          <div class="nodes">
            @for (n of view().perNode; track n.name) {
              <div class="node">
                <strong>{{ n.name }}</strong>
                <app-resource-bar [resource]="n.cpu" [label]="t('nodes.cpu')" />
                <app-resource-bar [resource]="n.memory" [label]="t('nodes.ram')" />
              </div>
            }
          </div>
        </section>
      }

      @if (view().attention.length > 0) {
        <section>
          <h2>{{ t('overview.attention') }}</h2>
          <ul class="attention">
            @for (row of view().attention; track row.module.id) {
              <li>
                <button type="button" [class]="'tone-' + row.tone" (click)="openModule.emit(row.module.id)">
                  <span class="icon"><ion-icon [name]="row.module.icon" aria-hidden="true" /></span>
                  <span class="text">
                    <strong>{{ row.module.name }}</strong>
                    <span>{{ row.module.summary }}</span>
                  </span>
                  <span class="pill">{{ row.statusLabel }}</span>
                </button>
              </li>
            }
          </ul>
        </section>
      }
    </ng-container>
  `,
  styles: `
    .pending {
      margin: -0.5rem 0 1.75rem;
    }
    .more {
      margin-top: 0.5rem;
      padding: 0.5rem 0.2rem;
      border: none;
      background: none;
      color: var(--accent);
      font: inherit;
      font-size: 0.9375rem;
      font-weight: 600;
      cursor: pointer;
    }
    section {
      margin-bottom: 2rem;
    }
    h2 {
      font-size: 1.2rem;
      font-weight: 650;
      margin-bottom: 0.75rem;
    }
    .section-head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 0.75rem;
    }
    .section-head h2 {
      margin: 0;
    }
    .range {
      display: inline-flex;
      background: var(--surface);
      border-radius: 999px;
      padding: 3px;
    }
    .range button {
      border: 0;
      background: transparent;
      color: var(--mute);
      font: inherit;
      font-size: 0.8125rem;
      font-weight: 600;
      padding: 0.3rem 0.7rem;
      border-radius: 999px;
      cursor: pointer;
    }
    .range button.on {
      background: var(--raise);
      color: var(--ink);
    }
    .update {
      display: flex;
      gap: 0.75rem;
      margin: 0 0 1.5rem;
      padding: 0.9rem 1rem;
      border-radius: var(--radius-m);
      background: color-mix(in srgb, var(--accent) 12%, var(--surface));
    }
    .maintenance {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin: 0 0 1.5rem;
      padding: 0.7rem 1rem;
      border-radius: var(--radius-m);
      background: var(--mute-soft);
      font-weight: 600;
      font-size: 0.9375rem;
    }
    .maintenance ion-icon {
      flex: none;
      font-size: 1.2rem;
      color: var(--accent);
    }
    .update ion-icon {
      flex: none;
      font-size: 1.4rem;
      color: var(--accent);
    }
    .update div {
      display: grid;
      gap: 0.3rem;
      min-width: 0;
    }
    .update code {
      font-size: 0.75rem;
      overflow-wrap: break-word;
      user-select: all;
    }
    .hints h2 {
      display: flex;
      gap: 0.5rem;
      align-items: baseline;
    }
    .count {
      color: var(--mute);
      font-family: var(--font-body);
      font-size: 0.875rem;
      font-weight: 500;
    }
    .hint-intro {
      font-size: 0.875rem;
      margin: -0.25rem 0 0.75rem;
    }
    .calm {
      display: flex;
      gap: 0.9rem;
      align-items: center;
      background: var(--surface);
      border-radius: var(--radius-l);
      padding: 1.1rem;
    }
    .calm ion-icon {
      font-size: 2rem;
      color: var(--ok);
      flex: none;
    }
    .calm div {
      display: grid;
      gap: 0.2rem;
    }
    .charts {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 15rem), 1fr));
      gap: 0.75rem;
    }
    .card {
      background: var(--surface);
      border-radius: var(--radius-m);
      padding: 0.9rem 1rem 0.7rem;
    }
    .note {
      font-size: 0.875rem;
      margin-top: 0.75rem;
    }
    .kpis {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 9.5rem), 1fr));
      gap: 0.75rem;
      margin: 0;
    }
    .kpi {
      background: var(--surface);
      border-radius: var(--radius-m);
      padding: 0.85rem 1rem;
      box-shadow: inset 0 -3px 0 var(--tone-soft);
    }
    .kpi dt {
      color: var(--mute);
      font-size: 0.8125rem;
      font-weight: 600;
    }
    .kpi dd {
      margin: 0;
    }
    .nodes {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr));
      gap: 0.75rem;
    }
    .node {
      display: grid;
      gap: 0.7rem;
      background: var(--surface);
      border-radius: var(--radius-m);
      padding: 0.85rem 1rem;
    }
    .node strong {
      font-weight: 650;
      overflow-wrap: break-word;
    }
    .kpi .bar {
      margin: 0.45rem 0 0.2rem;
    }
    .kpi .display {
      font-size: 1.6rem;
      font-weight: 650;
      margin-top: 0.2rem;
    }
    .kpi .note {
      color: var(--mute);
      font-size: 0.8125rem;
      margin-top: 0.15rem;
    }
    .attention {
      list-style: none;
      padding: 0;
      margin: 0;
      display: grid;
      gap: 0.5rem;
    }
    .attention button {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 0.8rem;
      padding: 0.75rem 0.9rem;
      background: var(--surface);
      border: 0;
      border-radius: var(--radius-m);
      color: var(--ink);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .icon {
      flex: none;
      width: 2.25rem;
      height: 2.25rem;
      border-radius: 10px;
      display: grid;
      place-items: center;
      background: var(--tone-soft);
      color: var(--tone);
      font-size: 1.15rem;
    }
    .text {
      flex: 1;
      min-width: 0;
      display: grid;
    }
    .text span {
      color: var(--mute);
      font-size: 0.875rem;
    }
  `,
})
export class OverviewTab {
  readonly view = input.required<ClusterView>();
  readonly cluster = input.required<ClusterConfig>();
  readonly history = input.required<Loadable<HistoryView>>();
  readonly hours = input(6);
  /** The last seven days; null until the agent answered (agents before 0.4 never do). */
  readonly incidents = input<HistoryVM | null>(null);
  readonly changed = output<void>();
  readonly openModule = output<string>();
  readonly openPending = output<void>();
  /** A new range is on its way (not the quiet reload after each check, which keeps the charts as they are). */
  readonly rangeLoading = computed(() => {
    const h = this.history();
    return h.loading && h.value !== null && h.value.hours !== this.hours();
  });
  /** Placeholder charts while the first history loads. */
  readonly skeletons = [1, 2, 3, 4];
  readonly setHours = output<number>();
  private readonly language = inject(LanguageService);
  readonly hourChoices = computed(() => hourChoices(this.language.translator()));
  /** Outages always; warnings after the first three behind a button, so the figures are not pages away on a phone. */
  readonly allWarnings = signal(false);
  readonly openHints = signal(false);
  readonly openSilenced = signal(false);
  readonly fold = computed(() => foldIssues(this.view().issues, this.allWarnings(), this.language.translator()));

  readonly charts = computed<Series[]>(() => {
    const series = this.history().value?.series ?? [];
    return CHART_ORDER.map((id) => series.find((s) => s.id === id)).filter((s): s is Series => Boolean(s && s.points.length > 1));
  });
}
