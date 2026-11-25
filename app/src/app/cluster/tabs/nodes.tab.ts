import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { IonSpinner } from '@ionic/angular/standalone';
import { HistoryView, NodeView, Series, Tone } from '../../core/agent.model';
import { Loadable } from '../../core/cluster-data.store';
import { NO_VALUE, age, bytes, cores, percent, ratio, sinceText } from '../../core/format';
import { LanguageService } from '../../i18n/language.service';
import { Translator } from '../../i18n/translator';
import { AreaChart } from '../../ui/area-chart';
import { Meter } from '../../ui/meter';
import { ResourceBar, ResourceInput } from '../../ui/resource-bar';

export interface NodeCard {
  node: NodeView;
  tone: Tone;
  state: string;
  facts: { label: string; value: string }[];
  cpu: ResourceInput;
  memory: ResourceInput;
  disk: { used: number | null; text: string } | null;
  pods: { used: number | null; text: string };
  cpuSeries: Series | null;
  memorySeries: Series | null;
  warnings: string[];
}

export function nodeCards(nodes: NodeView[], history: HistoryView | null, now: Date, tr: Translator): NodeCard[] {
  const lang = tr.lang;
  const rank: Record<Tone, number> = { critical: 0, warning: 1, muted: 2, ok: 3 };
  // Nodes with a problem first, then by name (the agent sends them by name).
  const cards = nodes.map((n): NodeCard => {
    const state = tr.t(!n.ready ? 'nodes.notReady' : n.rebooting ? 'nodes.rebooting' : n.cordoned ? 'nodes.cordoned' : 'nodes.ready');
    const tone: Tone = !n.ready ? (n.cordoned || n.rebooting ? 'warning' : 'critical') : n.rebooting || n.cordoned ? 'muted' : 'ok';
    return {
      node: n,
      tone,
      state,
      facts: [
        { label: tr.t('nodes.roles'), value: n.roles.length ? n.roles.join(', ') : tr.t('nodes.worker') },
        { label: tr.t('nodes.ip'), value: n.internalIp ?? NO_VALUE },
        { label: tr.t('nodes.kubelet'), value: n.kubelet ?? NO_VALUE },
        { label: tr.t('nodes.os'), value: n.os ?? NO_VALUE },
        { label: tr.t('nodes.kernel'), value: n.kernel ?? NO_VALUE },
        { label: tr.t('nodes.runtime'), value: n.runtime?.replace('containerd://', 'containerd ') ?? NO_VALUE },
        { label: tr.t('nodes.arch'), value: n.arch ?? NO_VALUE },
        { label: tr.t('nodes.inCluster'), value: age(n.createdAt, now, lang) },
      ],
      cpu: { kind: 'cpu', used: n.cpu.usedMilli, capacity: n.cpu.allocatableMilli, requested: n.cpu.requestedMilli, limit: n.cpu.limitMilli, withoutLimit: n.podsWithoutLimit?.cpu },
      memory: { kind: 'memory', used: n.memory.used, capacity: n.memory.allocatable, requested: n.memory.requested, limit: n.memory.limit, withoutLimit: n.podsWithoutLimit?.memory },
      disk: n.disk === null ? null : { used: n.disk, text: tr.t('nodes.diskText', { used: percent(n.disk, lang) }) },
      pods: { used: ratio(n.pods.count, n.pods.capacity), text: tr.t('nodes.podsText', { count: n.pods.count, capacity: n.pods.capacity }) },
      cpuSeries: history?.series.find((s) => s.id === `node-cpu:${n.name}`) ?? null,
      memorySeries: history?.series.find((s) => s.id === `node-memory:${n.name}`) ?? null,
      warnings: [...n.conditions.filter((c) => c.type !== 'Ready').map((c) => `${c.type}${c.since ? ` (${sinceText(c.since, now, lang)})` : ''}${c.message ? `: ${c.message}` : ''}`), ...n.taints.filter((t) => !t.includes('control-plane') && !t.includes('master') && !t.includes('etcd'))],
    };
  });
  return cards.map((c, i) => ({ c, i })).sort((x, y) => rank[x.c.tone] - rank[y.c.tone] || (y.c.warnings.length ? 1 : 0) - (x.c.warnings.length ? 1 : 0) || x.i - y.i).map((x) => x.c);
}

@Component({
  selector: 'app-nodes-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, Meter, ResourceBar, AreaChart, IonSpinner],
  template: `
    <ng-container *transloco="let t">
      @if (cards().length === 0 && nodes().loading) {
        <div class="page-spinner"><ion-spinner /></div>
      } @else if (nodes().error && cards().length === 0) {
        <p class="error">{{ nodes().error }}</p>
      }
      <div class="grid">
        @for (c of cards(); track c.node.name) {
          <article [class]="'tone-' + c.tone">
            <header>
              <h2 class="display">{{ c.node.name }}</h2>
              <span class="pill">{{ c.state }}</span>
            </header>
            <div class="meters">
              <app-resource-bar [resource]="c.cpu" [label]="t('nodes.cpu')" />
              <app-resource-bar [resource]="c.memory" [label]="t('nodes.ram')" />
              @if (c.disk; as d) {
                <app-meter [label]="t('nodes.disk')" [used]="d.used" [text]="d.text" />
              }
              <app-meter [label]="t('nodes.pods')" [used]="c.pods.used" [text]="c.pods.text" toneOverride="muted" />
            </div>
            @if (c.cpuSeries || c.memorySeries) {
              <div class="charts">
                @if (c.cpuSeries; as s) {
                  <app-area-chart [title]="t('nodes.cpu')" [points]="s.points" unit="ratio" />
                }
                @if (c.memorySeries; as s) {
                  <app-area-chart [title]="t('nodes.ram')" [points]="s.points" unit="ratio" />
                }
              </div>
            }
            @if (c.warnings.length > 0) {
              <ul class="warnings">
                @for (w of c.warnings; track w) {
                  <li>{{ w }}</li>
                }
              </ul>
            }
            <dl>
              @for (f of c.facts; track f.label) {
                <div>
                  <dt>{{ f.label }}</dt>
                  <dd>{{ f.value }}</dd>
                </div>
              }
            </dl>
          </article>
        }
      </div>
    </ng-container>
  `,
  styles: `
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 21rem), 1fr));
      gap: 1rem;
    }
    article {
      background: var(--surface);
      border-radius: var(--radius-l);
      padding: 1.1rem 1.1rem 0.9rem;
      box-shadow: inset 0 3px 0 var(--tone);
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }
    h2 {
      font-size: 1.25rem;
      font-weight: 650;
      overflow-wrap: break-word;
    }
    .meters {
      display: grid;
      gap: 0.85rem;
    }
    .charts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1rem;
      margin-top: 1.1rem;
      --chart-height: 56px;
    }
    .warnings {
      margin: 1rem 0 0;
      padding: 0.6rem 0.8rem 0.6rem 1.6rem;
      background: var(--warn-soft);
      border-radius: var(--radius-s);
      color: var(--ink);
      font-size: 0.875rem;
    }
    dl {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0.6rem 1rem;
      margin: 1.1rem 0 0;
      padding-top: 0.9rem;
      border-top: 1px solid var(--line);
    }
    dt {
      color: var(--mute);
      font-size: 0.75rem;
    }
    dd {
      margin: 0.1rem 0 0;
      font-size: 0.875rem;
      overflow-wrap: break-word;
    }
    .error {
      color: var(--crit);
    }
  `,
})
export class NodesTab {
  readonly nodes = input.required<Loadable<NodeView[]>>();
  readonly history = input.required<Loadable<HistoryView>>();
  readonly now = input.required<Date>();
  private readonly language = inject(LanguageService);
  readonly cards = computed(() => nodeCards(this.nodes().value ?? [], this.history().value, this.now(), this.language.translator()));
}
