import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { Tone, WorkloadView } from '../../core/agent.model';
import { Loadable } from '../../core/cluster-data.store';
import { age, bytes, cores } from '../../core/format';
import { LanguageService } from '../../i18n/language.service';
import { Translator } from '../../i18n/translator';

export type WorkloadFilter = 'all' | 'problems' | 'restarts';

export interface WorkloadRow {
  key: string;
  w: WorkloadView;
  tone: Tone;
  readyText: string;
  usage: string;
  detail: string;
  pods: { name: string; tone: Tone; text: string }[];
}

export interface NamespaceGroup {
  namespace: string;
  rows: WorkloadRow[];
  problems: number;
}

export function workloadGroups(list: WorkloadView[], query: string, filter: WorkloadFilter, now: Date, tr: Translator): NamespaceGroup[] {
  const lang = tr.lang;
  const q = query.trim().toLowerCase();
  const rows = list
    .filter((w) => !q || `${w.namespace}/${w.name} ${w.component ?? ''} ${w.images.join(' ')}`.toLowerCase().includes(q))
    .filter((w) => (filter === 'problems' ? w.health !== 'ok' : filter === 'restarts' ? w.restarts > 0 : true))
    .map((w) => ({
      key: `${w.namespace}/${w.kind}/${w.name}`,
      w,
      tone: w.health as Tone,
      readyText: `${w.ready}/${w.desired}`,
      usage: w.cpuMilli === null ? '' : tr.t('workloads.cpu', { cores: cores(w.cpuMilli, lang), memory: bytes(w.memBytes, lang) }),
      detail: [w.kind, w.component, w.restarts > 0 ? tr.n('workloads.restarts', w.restarts) : null, w.createdAt ? age(w.createdAt, now, lang) : null].filter(Boolean).join(', '),
      pods: w.pods.map((p) => ({
        name: p.name,
        tone: (p.ready ? 'ok' : p.phase === 'Pending' ? 'warning' : 'critical') as Tone,
        text: [p.phase, p.node, p.restarts > 0 ? tr.n('workloads.restarts', p.restarts) : null].filter(Boolean).join(', '),
      })),
    }));
  const byNs = new Map<string, WorkloadRow[]>();
  for (const r of rows) {
    byNs.set(r.w.namespace, [...(byNs.get(r.w.namespace) ?? []), r]);
  }
  return [...byNs.entries()]
    .map(([namespace, items]) => ({ namespace, rows: items, problems: items.filter((r) => r.tone !== 'ok').length }))
    .sort((a, b) => b.problems - a.problems || a.namespace.localeCompare(b.namespace));
}

@Component({
  selector: 'app-workloads-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonIcon, IonSpinner],
  template: `
    <ng-container *transloco="let t">
      <div class="tools">
        <label class="search">
          <ion-icon name="search-outline" aria-hidden="true" />
          <input type="search" [placeholder]="t('workloads.search')" [value]="query()" (input)="query.set($any($event.target).value)" [attr.aria-label]="t('workloads.searchLabel')" />
        </label>
        <div class="filters" role="group" [attr.aria-label]="t('workloads.filter')">
          @for (f of filters(); track f.id) {
            <button type="button" [class.on]="filter() === f.id" [attr.aria-pressed]="filter() === f.id" (click)="filter.set(f.id)">{{ f.label }}</button>
          }
        </div>
      </div>

      @if (workloads().loading && !workloads().value) {
        <div class="page-spinner"><ion-spinner /></div>
      }
      <p class="muted count">{{ total() }}</p>

      @for (g of groups(); track g.namespace) {
        <section>
          <h2>{{ g.namespace }}@if (g.problems > 0) {<span class="pill tone-warning">{{ t('workloads.withProblems', { count: g.problems }) }}</span>}</h2>
          <ul>
            @for (r of g.rows; track r.key) {
              <li [class]="'tone-' + r.tone">
                <button type="button" class="row" [attr.aria-expanded]="open() === r.key" (click)="toggle(r.key)">
                  <span class="ready pill">{{ r.readyText }}</span>
                  <span class="main">
                    <strong>{{ r.w.name }}</strong>
                    <span class="muted">{{ r.detail }}</span>
                  </span>
                  <span class="usage muted">{{ r.usage }}</span>
                  <ion-icon [name]="open() === r.key ? 'chevron-down' : 'chevron-forward'" aria-hidden="true" />
                </button>
                @if (open() === r.key) {
                  <div class="detail">
                    @for (img of r.w.images; track img) {
                      <code>{{ img }}</code>
                    }
                    <ul class="pods">
                      @for (p of r.pods; track p.name) {
                        <li [class]="'tone-' + p.tone"><span class="dot" aria-hidden="true"></span><span>{{ p.name }}</span><span class="muted">{{ p.text }}</span></li>
                      } @empty {
                        <li class="muted">{{ t('workloads.noPods') }}</li>
                      }
                    </ul>
                  </div>
                }
              </li>
            }
          </ul>
        </section>
      } @empty {
        @if (workloads().value) {
          <p class="muted">{{ t('workloads.nothingFound') }}</p>
        }
      }
    </ng-container>
  `,
  styles: `
    .tools {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      align-items: center;
      margin-bottom: 0.75rem;
    }
    .search {
      flex: 1 1 16rem;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      background: var(--surface);
      border-radius: 999px;
      padding: 0 0.9rem;
      color: var(--mute);
    }
    .search input {
      flex: 1;
      min-width: 0;
      border: 0;
      background: transparent;
      color: var(--ink);
      font: inherit;
      padding: 0.65rem 0;
      outline: none;
    }
    .filters {
      display: inline-flex;
      background: var(--surface);
      border-radius: 999px;
      padding: 3px;
    }
    .filters button {
      border: 0;
      background: transparent;
      color: var(--mute);
      font: inherit;
      font-size: 0.8125rem;
      font-weight: 600;
      padding: 0.35rem 0.8rem;
      border-radius: 999px;
      cursor: pointer;
    }
    .filters button.on {
      background: var(--raise);
      color: var(--ink);
    }
    .count {
      font-size: 0.8125rem;
      margin: 0 0 1rem;
    }
    section {
      margin-bottom: 1.5rem;
    }
    h2 {
      font-size: 1.05rem;
      font-weight: 650;
      margin-bottom: 0.5rem;
      display: flex;
      gap: 0.6rem;
      align-items: center;
      flex-wrap: wrap;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    section > ul {
      background: var(--surface);
      border-radius: var(--radius-l);
      overflow: hidden;
    }
    section > ul > li + li {
      border-top: 1px solid var(--line);
    }
    .row {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 0.8rem;
      padding: 0.7rem 0.9rem;
      border: 0;
      background: transparent;
      color: var(--ink);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .ready {
      min-width: 3.2rem;
      justify-content: center;
    }
    .main {
      flex: 1;
      min-width: 0;
      display: grid;
    }
    .main strong {
      overflow-wrap: anywhere;
    }
    .main .muted {
      font-size: 0.8125rem;
    }
    .usage {
      font-size: 0.8125rem;
      text-align: right;
    }
    @media (max-width: 560px) {
      .usage {
        display: none;
      }
    }
    .detail {
      padding: 0 0.9rem 0.9rem 4.9rem;
      display: grid;
      gap: 0.4rem;
    }
    code {
      font-size: 0.75rem;
      color: var(--ink-2);
      overflow-wrap: anywhere;
    }
    .pods li {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
      font-size: 0.8125rem;
      padding: 0.2rem 0;
    }
    .dot {
      width: 0.5rem;
      height: 0.5rem;
      border-radius: 50%;
      background: var(--tone);
      flex: none;
    }
  `,
})
export class WorkloadsTab {
  readonly workloads = input.required<Loadable<WorkloadView[]>>();
  readonly now = input.required<Date>();
  readonly query = signal('');
  readonly filter = signal<WorkloadFilter>('all');
  readonly open = signal<string | null>(null);
  private readonly language = inject(LanguageService);
  readonly filters = computed<{ id: WorkloadFilter; label: string }[]>(() => {
    const tr = this.language.translator();
    return [
      { id: 'all', label: tr.t('workloads.all') },
      { id: 'problems', label: tr.t('workloads.problems') },
      { id: 'restarts', label: tr.t('workloads.withRestarts') },
    ];
  });

  readonly groups = computed(() => workloadGroups(this.workloads().value ?? [], this.query(), this.filter(), this.now(), this.language.translator()));
  readonly total = computed(() => {
    const shown = this.groups().reduce((s, g) => s + g.rows.length, 0);
    const all = this.workloads().value?.length ?? 0;
    const tr = this.language.translator();
    return shown === all ? tr.n('workloads.total', all) : tr.t('workloads.shown', { shown, count: all });
  });

  toggle(key: string): void {
    this.open.set(this.open() === key ? null : key);
  }
}
