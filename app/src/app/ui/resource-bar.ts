import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Tone } from '../core/agent.model';
import { bytes, decimal, percent } from '../core/format';
import { LanguageService } from '../i18n/language.service';
import { Translator } from '../i18n/translator';

export type ResourceKind = 'cpu' | 'memory';

/** What one bar shows; CPU in millicores, memory in bytes. */
export interface ResourceInput {
  kind: ResourceKind;
  /** Current use (metrics-server); null when unknown. */
  used: number | null;
  /** What the track stands for: allocatable for a node or the cluster, the limit or the request for a workload. */
  capacity: number;
  /** Sum of requests; undefined from agents that do not send it. */
  requested?: number;
  /** Sum of the limits that are set; undefined to draw no limit marker. */
  limit?: number;
  /** Pods (or containers) that set no limit at all. */
  withoutLimit?: number;
  /** The track ends at the workload's own limit: the header says so, and no extra marker is drawn. */
  capacityIsLimit?: boolean;
  /** Nothing caps it (a workload without a limit): the track only scales the bar, so no percentage and a neutral tone. */
  uncapped?: boolean;
}

export interface LegendItem {
  kind: 'used' | 'reserved' | 'limit';
  text: string;
  /** "+ 8 Pods ohne Limit", attached to the limit item. */
  extra?: string;
  /** "+60 % überbucht" when the limits exceed the capacity. */
  over?: string;
}

export interface ResourceBarView {
  label: string;
  value: string;
  pct: string;
  tone: Tone;
  usedPct: number;
  reservedPct: number;
  /** Where the limit marker sits, 0..100; null for none. */
  limitPct: number | null;
  /** Limits above the capacity: the striped overflow cap at the right end. */
  overbooked: boolean;
  legend: LegendItem[];
  aria: string;
}

/** CPU always in cores with the locale's decimals ("0,40", "1,73", "4"), memory in GiB/MiB. */
export function amount(kind: ResourceKind, v: number, tr: Translator): string {
  if (kind === 'memory') {
    return bytes(v, tr.lang);
  }
  const cores = v / 1000;
  return Number.isInteger(cores) ? String(cores) : decimal(cores, tr.lang, cores >= 10 ? 1 : 2);
}

const clamp = (v: number) => Math.max(0, Math.min(100, v));

/**
 * A loading bar for CPU or RAM: the track is the capacity, the reserved part
 * (requests) a striped layer from the left, the use a solid bar on top of it,
 * the limits a marker with a cap, and an amber overflow cap when they add up
 * to more than there is. Tone: coral from 90 % use, amber from 80 % use or
 * when requests take 90 % (nothing more can be scheduled).
 */
export function resourceBarView(r: ResourceInput, label: string, tr: Translator, short = false): ResourceBarView {
  const cap = r.capacity > 0 ? r.capacity : 0;
  const share = (v: number | null | undefined) => (v === null || v === undefined || cap === 0 ? null : v / cap);
  const used = share(r.used);
  const reserved = share(r.requested);
  const limit = r.capacityIsLimit ? null : share(r.limit);
  const tone: Tone = used === null || r.uncapped ? 'muted' : used >= 0.9 ? 'critical' : used >= 0.8 || (reserved ?? 0) >= 0.9 ? 'warning' : 'ok';
  const unit = r.kind === 'cpu' ? ` ${tr.t('bar.cores')}` : '';
  const fmt = (v: number) => amount(r.kind, v, tr);
  const value =
    r.used === null
      ? `${fmt(cap)}${unit}`
      : r.uncapped
        ? `${fmt(r.used)}${unit}`
        : r.kind === 'cpu'
        ? `${fmt(r.used)} / ${fmt(cap)}${unit}`
        : `${fmt(r.used)} / ${fmt(cap)}`;
  const legend: LegendItem[] = [];
  if (r.used !== null) {
    legend.push({ kind: 'used', text: tr.t('bar.used', { value: fmt(r.used) }) });
  }
  if (r.requested !== undefined) {
    legend.push({ kind: 'reserved', text: tr.t('bar.reserved', { value: fmt(r.requested) }) });
  }
  if (r.capacityIsLimit) {
    legend.push({ kind: 'limit', text: tr.t('bar.limit', { value: fmt(cap) }), ...(r.withoutLimit ? { extra: tr.n(short ? 'bar.withoutLimitShort' : 'bar.withoutLimit', r.withoutLimit) } : {}) });
  } else if (r.limit !== undefined) {
    const over = limit !== null && limit > 1 ? Math.round((limit - 1) * 100) : 0;
    legend.push({
      kind: 'limit',
      text: r.limit > 0 ? tr.t('bar.limit', { value: fmt(r.limit) }) : tr.t('bar.noLimit'),
      ...(r.withoutLimit ? { extra: tr.n(short ? 'bar.withoutLimitShort' : 'bar.withoutLimit', r.withoutLimit) } : {}),
      ...(over > 0 ? { over: tr.t('bar.over', { pct: over }) } : {}),
    });
  }
  const aria = [label, value, ...legend.map((l) => [l.text, l.extra, l.over].filter(Boolean).join(' '))].join(', ');
  return {
    label,
    value,
    pct: r.uncapped ? '' : percent(used, tr.lang),
    tone,
    usedPct: used === null ? 0 : clamp(used * 100),
    reservedPct: reserved === null ? 0 : clamp(reserved * 100),
    limitPct: limit === null || (r.limit ?? 0) <= 0 ? null : clamp(limit * 100),
    overbooked: limit !== null && limit > 1,
    legend,
    aria,
  };
}

/** CPU or RAM as a loading bar with its legend; one component wherever CPU and RAM appear. */
@Component({
  selector: 'app-resource-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (view(); as v) {
      <div [class]="'rb tone-' + v.tone" [class.compact]="compact()" role="meter" [attr.aria-label]="v.aria" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="v.usedPct">
        @if (head()) {
          <div class="head">
            <span class="label">{{ v.label }}</span>
            <span class="value">
              @if (v.pct) {
                <strong>{{ v.pct }}</strong>
              }
              {{ v.value }}
            </span>
          </div>
        }
        <div class="bar" aria-hidden="true">
          <div class="lane">
            <div class="track">
              <span class="seg-reserved" [style.width.%]="v.reservedPct"></span>
              <span class="seg-used" [style.width.%]="v.usedPct"></span>
            </div>
            @if (v.limitPct !== null) {
              <span class="seg-limit" [class.at-end]="v.overbooked" [style.left.%]="v.limitPct"></span>
            }
          </div>
          @if (v.overbooked) {
            <span class="seg-over"></span>
          }
        </div>
        @if (legend()) {
        <ul class="legend" [class.one-line]="oneLine()" aria-hidden="true">
          @for (l of v.legend; track l.kind) {
            <li [class]="l.kind">
              <span class="swatch"></span>
              <span>{{ l.text }}</span>
              @if (l.extra) {
                <span class="extra">{{ l.extra }}</span>
              }
              @if (l.over) {
                <span class="over-text">{{ l.over }}</span>
              }
            </li>
          }
        </ul>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      --rb-h: 12px;
    }
    .compact {
      --rb-h: 8px;
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 0.5rem;
      flex-wrap: wrap;
      margin-bottom: 0.35rem;
      font-size: 0.8125rem;
    }
    .label {
      color: var(--mute);
      font-weight: 600;
    }
    .value {
      color: var(--ink-2);
      text-align: right;
    }
    .value strong {
      color: var(--ink);
      font-weight: 650;
      margin-right: 0.25rem;
    }
    .tone-warning .value strong,
    .tone-critical .value strong {
      color: var(--tone);
    }
    .bar {
      display: flex;
      align-items: center;
    }
    .lane {
      position: relative;
      flex: 1;
      padding: 4px 0;
    }
    .track {
      position: relative;
      height: var(--rb-h);
      border-radius: 999px;
      background: var(--raise);
      overflow: hidden;
    }
    .seg-reserved {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: 999px;
      background:
        repeating-linear-gradient(135deg, color-mix(in srgb, var(--tone) 55%, transparent) 0 2px, transparent 2px 5px),
        color-mix(in srgb, var(--tone) 22%, transparent);
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 55%, transparent);
    }
    .seg-used {
      position: absolute;
      top: 3px;
      bottom: 3px;
      left: 3px;
      max-width: calc(100% - 6px);
      border-radius: 999px;
      background: linear-gradient(90deg, var(--tone) 0, var(--tone) calc(100% - 6px), color-mix(in srgb, var(--tone) 45%, white) 100%);
      box-shadow: 0 0 6px color-mix(in srgb, var(--tone) 45%, transparent);
      transition: width 0.6s cubic-bezier(0.2, 0.8, 0.2, 1);
    }
    .compact .seg-used {
      top: 1.5px;
      bottom: 1.5px;
    }
    .seg-limit {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 2px;
      margin-left: -1px;
      background: var(--ink);
      border-radius: 1px;
    }
    .seg-limit::before {
      content: '';
      position: absolute;
      top: -4px;
      left: -3px;
      border: 4px solid transparent;
      border-top: 5px solid var(--ink);
      border-bottom: 0;
    }
    .seg-limit.at-end {
      background: var(--warn);
    }
    .seg-limit.at-end::before {
      border-top-color: var(--warn);
    }
    .seg-over {
      flex: none;
      width: 1.1rem;
      height: var(--rb-h);
      margin-left: 3px;
      border-radius: 0 999px 999px 0;
      background: repeating-linear-gradient(135deg, var(--warn) 0 2px, transparent 2px 4px);
      box-shadow: inset 0 0 0 1px var(--warn);
    }
    .legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.2rem 0.9rem;
      list-style: none;
      margin: 0.35rem 0 0;
      padding: 0;
      font-size: 0.75rem;
      color: var(--ink-2);
    }
    /* Compact: items never break inside, but the row wraps between them when
       the rail is narrow, so nothing is cut off. */
    .legend.one-line {
      gap: 0.15rem 0.75rem;
      font-size: 0.6875rem;
    }
    .legend.one-line li {
      flex-wrap: nowrap;
      white-space: nowrap;
    }
    .legend li {
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      flex-wrap: wrap;
    }
    .swatch {
      flex: none;
      width: 0.7rem;
      height: 0.55rem;
      border-radius: 2px;
    }
    .used .swatch {
      background: var(--tone);
    }
    .reserved .swatch {
      background:
        repeating-linear-gradient(135deg, color-mix(in srgb, var(--tone) 50%, transparent) 0 2px, transparent 2px 4px),
        color-mix(in srgb, var(--tone) 18%, transparent);
    }
    .limit .swatch {
      width: 2px;
      height: 0.75rem;
      background: var(--ink);
    }
    .extra {
      color: var(--mute);
    }
    .over-text {
      color: var(--warn);
      font-weight: 600;
    }
    @media (prefers-reduced-motion: reduce) {
      .seg-used {
        transition: none;
      }
    }
  `,
})
export class ResourceBar {
  readonly resource = input.required<ResourceInput>();
  readonly label = input('');
  /** Header line with label, percentage and "1,73 / 4 Kerne"; off where the figure above says it already. */
  readonly head = input(true);
  readonly compact = input(false);
  /** The legend under the bar; off in per-node rows where the cluster bar above explains the marks. */
  readonly legend = input(true);
  /** Legend on one line with the short "+ 57 ohne Limit" (the overview rail). */
  readonly oneLine = input(false);
  private readonly language = inject(LanguageService);
  readonly view = computed(() => resourceBarView(this.resource(), this.label(), this.language.translator(), this.oneLine()));
}
