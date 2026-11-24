import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { Unit } from '../core/agent.model';
import { NO_VALUE, clockTime, formatValue } from '../core/format';
import { LanguageService } from '../i18n/language.service';

const W = 320;
const H = 96;
const PAD_TOP = 6;

interface Geometry {
  line: string;
  area: string;
  xs: number[];
  ys: number[];
  max: number;
}

/** Maps points into the viewBox; ratios are drawn against 100 %, everything else against its own peak. */
export function chartGeometry(points: [number, number][], unit: Unit): Geometry | null {
  if (points.length < 2) {
    return null;
  }
  const t0 = points[0][0];
  const t1 = points[points.length - 1][0];
  const peak = Math.max(...points.map((p) => p[1]));
  const max = unit === 'ratio' ? Math.max(1, peak) : peak > 0 ? peak * 1.15 : 1;
  const xs = points.map(([t]) => ((t - t0) / Math.max(1, t1 - t0)) * W);
  const ys = points.map(([, v]) => PAD_TOP + (1 - v / max) * (H - PAD_TOP));
  const line = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  return { line, area: `${line} L${W},${H} L0,${H} Z`, xs, ys, max };
}

/**
 * A single series over time: 2px line, a quiet fill, gridlines at 0 and the
 * top, start and end on the time axis. Hover or touch shows a crosshair with
 * the value and time. No legend: the title names the series.
 */
@Component({
  selector: 'app-area-chart',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      <div class="head">
        <span class="title">{{ title() }}</span>
        <span class="value display">{{ shown().value }}</span>
      </div>
      @if (geometry(); as g) {
        <div class="plot" (pointermove)="track($event)" (pointerleave)="hover.set(null)" (pointerdown)="track($event)">
          <svg [attr.viewBox]="viewBox" preserveAspectRatio="none" role="img" [attr.aria-label]="ariaLabel()">
            <defs>
              <linearGradient [attr.id]="gradientId" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stop-color="currentColor" stop-opacity="0.28" />
                <stop offset="1" stop-color="currentColor" stop-opacity="0" />
              </linearGradient>
            </defs>
            <line class="grid" x1="0" [attr.y1]="padTop" [attr.x2]="width" [attr.y2]="padTop" />
            <line class="grid" x1="0" [attr.y1]="height" [attr.x2]="width" [attr.y2]="height" />
            <path [attr.d]="g.area" [attr.fill]="'url(#' + gradientId + ')'" />
            <path class="line" [attr.d]="g.line" />
            @if (cursor(); as c) {
              <line class="cross" [attr.x1]="c.x" y1="0" [attr.x2]="c.x" [attr.y2]="height" />
              <circle class="dot" [attr.cx]="c.x" [attr.cy]="c.y" r="4" />
            }
          </svg>
          @if (cursor(); as c) {
            <div class="tip" [style.left.%]="c.leftPct">
              <strong>{{ c.value }}</strong>
              <span>{{ c.time }}</span>
            </div>
          }
        </div>
        <div class="axis">
          <span>{{ axis().start }}</span>
          <span>{{ axis().max }}</span>
          <span>{{ t('chart.now') }}</span>
        </div>
      } @else {
        <p class="empty">{{ t('chart.tooFew') }}</p>
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
      color: var(--chart);
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      gap: 0.5rem;
      margin-bottom: 0.4rem;
    }
    .title {
      color: var(--mute);
      font-size: 0.875rem;
      font-weight: 600;
    }
    .value {
      color: var(--ink);
      font-size: 1.35rem;
      font-weight: 650;
    }
    .plot {
      position: relative;
      touch-action: pan-y;
      cursor: crosshair;
    }
    svg {
      display: block;
      width: 100%;
      height: var(--chart-height, 88px);
      overflow: visible;
    }
    .grid {
      stroke: var(--line);
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .line {
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linejoin: round;
      vector-effect: non-scaling-stroke;
    }
    .cross {
      stroke: var(--mute);
      stroke-width: 1;
      stroke-dasharray: 3 3;
      vector-effect: non-scaling-stroke;
    }
    .dot {
      fill: currentColor;
      stroke: var(--surface);
      stroke-width: 2;
      vector-effect: non-scaling-stroke;
    }
    .tip {
      position: absolute;
      top: -0.25rem;
      transform: translate(-50%, -100%);
      background: var(--ink);
      color: var(--ground);
      padding: 0.25rem 0.5rem;
      border-radius: var(--radius-s);
      font-size: 0.75rem;
      display: flex;
      gap: 0.4rem;
      white-space: nowrap;
      pointer-events: none;
    }
    .axis {
      display: flex;
      justify-content: space-between;
      color: var(--mute);
      font-size: 0.75rem;
      margin-top: 0.3rem;
    }
    .empty {
      color: var(--mute);
      font-size: 0.875rem;
      margin: 1rem 0;
    }
  `,
})
export class AreaChart {
  readonly title = input.required<string>();
  readonly points = input.required<[number, number][]>();
  readonly unit = input<Unit>('ratio');

  readonly viewBox = `0 0 ${W} ${H}`;
  readonly width = W;
  readonly height = H;
  readonly padTop = PAD_TOP;
  readonly gradientId = `g${Math.random().toString(36).slice(2, 9)}`;
  readonly hover = signal<number | null>(null);
  private readonly language = inject(LanguageService);

  readonly geometry = computed(() => chartGeometry(this.points(), this.unit()));

  readonly shown = computed(() => {
    const pts = this.points();
    const last = pts[pts.length - 1];
    return { value: last ? formatValue(last[1], this.unit(), this.language.lang()) : NO_VALUE };
  });

  readonly axis = computed(() => {
    const pts = this.points();
    const g = this.geometry();
    const tr = this.language.translator();
    const hours = pts.length > 1 ? Math.round((pts[pts.length - 1][0] - pts[0][0]) / 3_600_000) : 0;
    const max = g ? formatValue(this.unit() === 'ratio' ? Math.max(...pts.map((p) => p[1])) : g.max / 1.15, this.unit(), tr.lang) : null;
    return { start: hours >= 1 ? tr.t('chart.hoursAgo', { count: hours }) : '', max: max ? tr.t('chart.max', { value: max }) : '' };
  });

  readonly cursor = computed(() => {
    const i = this.hover();
    const g = this.geometry();
    const pts = this.points();
    if (i === null || !g || !pts[i]) {
      return null;
    }
    return {
      x: g.xs[i],
      y: g.ys[i],
      leftPct: (g.xs[i] / W) * 100,
      value: formatValue(pts[i][1], this.unit(), this.language.lang()),
      time: clockTime(pts[i][0], this.language.lang()),
    };
  });

  readonly ariaLabel = computed(() => this.language.translator().t('chart.label', { title: this.title(), value: this.shown().value, max: this.axis().max }));

  track(event: PointerEvent): void {
    const g = this.geometry();
    if (!g) {
      return;
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < g.xs.length; i++) {
      if (Math.abs(g.xs[i] - x) < Math.abs(g.xs[best] - x)) {
        best = i;
      }
    }
    this.hover.set(best);
  }
}
