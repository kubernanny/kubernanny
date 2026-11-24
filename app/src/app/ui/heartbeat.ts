import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Light } from '../core/agent.model';

const W = 600;
const BASE = 46;

/** One heartbeat: P wave, QRS spike, T wave, starting at x. Returns path commands. */
function beat(x: number, height: number, width: number): string {
  const s = width / 60;
  return [
    `L${x + 6 * s},${BASE}`,
    `Q${x + 10 * s},${BASE - 6 * height} ${x + 14 * s},${BASE}`,
    `L${x + 20 * s},${BASE}`,
    `L${x + 23 * s},${BASE + 7 * height}`,
    `L${x + 27 * s},${BASE - 38 * height}`,
    `L${x + 31 * s},${BASE + 16 * height}`,
    `L${x + 34 * s},${BASE}`,
    `L${x + 42 * s},${BASE}`,
    `Q${x + 48 * s},${BASE - 10 * height} ${x + 54 * s},${BASE}`,
    `L${x + 60 * s},${BASE}`,
  ].join(' ');
}

/**
 * The trace for each state. Calm and regular when healthy, an extra early beat
 * per cycle on warnings, fast and uneven when something is down, flat when the
 * agent cannot be reached. Deterministic, so it does not jump between renders.
 */
export function heartbeatPath(light: Light): string {
  if (light === 'unknown') {
    return `M0,${BASE} L${W},${BASE}`;
  }
  const parts = [`M0,${BASE}`];
  let x = 0;
  const pattern: [number, number, number][] =
    light === 'green'
      ? [
          [70, 1, 60],
          [70, 1, 60],
          [70, 1, 60],
          [70, 1, 60],
        ]
      : light === 'yellow'
        ? [
            [60, 1, 60],
            [8, 0.55, 46],
            [64, 1, 60],
            [70, 1, 60],
            [10, 0.5, 46],
          ]
        : [
            [18, 1.1, 50],
            [6, 0.7, 40],
            [22, 1.15, 48],
            [4, 0.5, 38],
            [14, 1.05, 50],
            [8, 0.8, 42],
            [20, 1.1, 48],
          ];
  let i = 0;
  while (x < W - 70) {
    const [gap, height, width] = pattern[i % pattern.length];
    x += gap;
    parts.push(`L${x},${BASE}`, beat(x, height, width));
    x += width;
    i++;
  }
  parts.push(`L${W},${BASE}`);
  return parts.join(' ');
}

@Component({
  selector: 'app-heartbeat',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg [attr.viewBox]="viewBox" preserveAspectRatio="none" role="img" [attr.aria-label]="label()" [class]="'trace ' + light()">
      <path class="base" [attr.d]="path()" />
      <path class="blip" [attr.d]="path()" pathLength="1000" />
    </svg>
  `,
  styles: `
    :host {
      display: block;
      color: var(--tone, var(--mute));
    }
    svg {
      width: 100%;
      height: var(--heartbeat-height, 72px);
      overflow: visible;
    }
    path {
      fill: none;
      stroke: currentColor;
      stroke-linejoin: round;
      stroke-linecap: round;
      vector-effect: non-scaling-stroke;
    }
    .base {
      stroke-width: 2;
      opacity: 0.28;
    }
    .blip {
      stroke-width: 2.5;
      stroke-dasharray: 140 860;
      filter: drop-shadow(0 0 6px currentColor);
      animation: travel var(--beat, 3.4s) linear infinite;
    }
    .red .blip {
      --beat: 1.5s;
    }
    .yellow .blip {
      --beat: 2.6s;
    }
    .unknown .blip {
      animation: none;
      stroke-dasharray: none;
      filter: none;
      opacity: 0.5;
    }
    @keyframes travel {
      from {
        stroke-dashoffset: 1000;
      }
      to {
        stroke-dashoffset: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .blip {
        animation: none;
        stroke-dasharray: none;
        filter: none;
      }
    }
  `,
})
export class Heartbeat {
  readonly light = input<Light>('unknown');
  readonly label = input('');
  readonly viewBox = `0 0 ${W} 80`;
  readonly path = computed(() => heartbeatPath(this.light()));
}
