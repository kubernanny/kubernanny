import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { IonIcon, IonSpinner } from '@ionic/angular/standalone';
import { Termination, Tone, WorkloadView } from '../../core/agent.model';
import { ResourceBar, ResourceInput } from '../../ui/resource-bar';
import { Loadable } from '../../core/cluster-data.store';
import { age, bytes, cores, relativeTime } from '../../core/format';
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
  /** "last 2 h ago: OOMKilled at the limit of 512 MiB", when it restarted; `oom` tints it. */
  restart: { text: string; oom: boolean } | null;
  /** CPU and RAM: use against requests and limits (agents from 0.4 on). */
  resources: { label: string; bar: ResourceInput }[];
  pods: { name: string; tone: Tone; text: string; containers: { name: string; text: string; oom: boolean }[] }[];
}

/** Why a container's last run ended, and when: "OOMKilled at the limit of 512 MiB, exit code 137, 2 h ago". */
export function terminationText(term: Termination, now: Date, tr: Translator): string {
  const lang = tr.lang;
  const parts: string[] = [];
  if (term.reason === 'OOMKilled') {
    parts.push(term.memLimit ? tr.t('workloads.oomLimit', { limit: bytes(term.memLimit, lang) }) : tr.t('workloads.oomNoLimit'));
  } else if (term.reason) {
    parts.push(term.reason);
  }
  if (term.exitCode !== undefined && term.exitCode !== 0) {
    parts.push(tr.t('workloads.exitCode', { code: term.exitCode }));
  }
  if (term.signal) {
    parts.push(tr.t('workloads.signal', { n: term.signal }));
  }
  if (term.finishedAt) {
    parts.push(relativeTime(term.finishedAt, now, lang));
  }
  return parts.join(', ');
}

/**
 * Use against what a workload asks for: the track runs to its limit (amber
 * from 80 %, coral from 90 %), without a limit to the request or the use,
 * whichever is larger, and says how many containers set no limit.
 */
function resourceRows(w: WorkloadView, tr: Translator): WorkloadRow['resources'] {
  const r = w.resources;
  if (!r) {
    return [];
  }
  const row = (kind: 'cpu' | 'memory', used: number | null, request: number, limit: number | null, unlimited: number) => ({
    label: tr.t(kind === 'cpu' ? 'nodes.cpu' : 'nodes.ram'),
    bar: {
      kind,
      used,
      capacity: limit ?? Math.max(request, used ?? 0),
      requested: request,
      ...(limit ? { capacityIsLimit: true } : { limit: 0, uncapped: true }),
      withoutLimit: limit ? unlimited : 0,
    } as ResourceInput,
  });
  return [row('cpu', w.cpuMilli, r.cpuRequestMilli, r.cpuLimitMilli, r.cpuUnlimited), row('memory', w.memBytes, r.memRequest, r.memLimit, r.memUnlimited)];
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
      restart:
        w.restarts > 0 && w.lastRestart
          ? { text: tr.t('workloads.lastRestart', { why: terminationText(w.lastRestart, now, tr) }), oom: w.lastRestart.reason === 'OOMKilled' }
          : null,
      resources: resourceRows(w, tr),
      pods: w.pods.map((p) => ({
        name: p.name,
        tone: (p.ready ? 'ok' : p.phase === 'Pending' ? 'warning' : 'critical') as Tone,
        text: [p.phase, p.node, p.restarts > 0 ? tr.n('workloads.restarts', p.restarts) : null].filter(Boolean).join(', '),
        containers: (p.containers ?? [])
          .filter((c) => c.restarts > 0 || c.waiting || !c.ready)
          .map((c) => ({
            name: c.name,
            text: [c.waiting, c.restarts > 0 ? tr.n('workloads.restarts', c.restarts) : null, c.lastTermination ? terminationText(c.lastTermination, now, tr) : null].filter(Boolean).join(', '),
            oom: c.lastTermination?.reason === 'OOMKilled',
          })),
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
  imports: [TranslocoDirective, IonIcon, IonSpinner, ResourceBar],
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
                    @if (r.restart; as rs) {
                      <span class="restart" [class.oom]="rs.oom">{{ rs.text }}</span>
                    }
                  </span>
                  <span class="usage muted">{{ r.usage }}</span>
                  <ion-icon [name]="open() === r.key ? 'chevron-down' : 'chevron-forward'" aria-hidden="true" />
                </button>
                @if (open() === r.key) {
                  <div class="detail">
                    @for (img of r.w.images; track img) {
                      <code>{{ img }}</code>
                    }
                    @if (r.resources.length > 0) {
                      <div class="res">
                        @for (x of r.resources; track x.label) {
                          <app-resource-bar [resource]="x.bar" [label]="x.label" [compact]="true" />
                        }
                      </div>
                    }
                    <ul class="pods">
                      @for (p of r.pods; track p.name) {
                        <li [class]="'tone-' + p.tone">
                          <span class="dot" aria-hidden="true"></span><span>{{ p.name }}</span><span class="muted">{{ p.text }}</span>
                          @for (c of p.containers; track c.name) {
                            <span class="container" [class.oom]="c.oom">{{ c.name }}: {{ c.text }}</span>
                          }
                        </li>
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
      overflow-wrap: break-word;
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
      overflow-wrap: break-word;
    }
    .pods li {
      display: flex;
      gap: 0.5rem;
      align-items: center;
      flex-wrap: wrap;
      font-size: 0.8125rem;
      padding: 0.2rem 0;
    }
    .restart {
      font-size: 0.8125rem;
      color: var(--ink-2);
      overflow-wrap: break-word;
    }
    .oom {
      color: var(--warn);
      font-weight: 600;
    }
    .res {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(100%, 12rem), 1fr));
      gap: 0.6rem 1rem;
      margin: 0.3rem 0;
      font-size: 0.8125rem;
    }
    .container {
      flex-basis: 100%;
      padding-left: 1rem;
      color: var(--ink-2);
      overflow-wrap: break-word;
    }
    .container.oom {
      color: var(--warn);
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
