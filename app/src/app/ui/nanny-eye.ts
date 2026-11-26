import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { Light } from '../core/agent.model';

/**
 * The nanny's glasses from the app icon (branding/kubernanny-*.svg): the
 * right lens is the cluster's light, mint, amber or coral, with a soft glow;
 * grey and without glow while nothing is known. It only moves while a check
 * runs (`checking`): the glow breathes. Reduced motion keeps it still.
 */
@Component({
  selector: 'app-nanny-eye',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <svg
      viewBox="0 0 440 210"
      role="img"
      [attr.aria-label]="label()"
      [class]="'eye ' + light()"
      [class.checking]="checking()"
    >
      <circle class="glow" cx="320" cy="105" r="118" />
      @if (progress() !== null) {
        <circle class="ring-track" cx="322" cy="105" r="104" />
        <circle
          class="ring"
          cx="322"
          cy="105"
          r="104"
          pathLength="100"
          [attr.stroke-dasharray]="ringDash()"
        />
      }
      <path class="bridge" d="M196 99 Q220 83 244 99" />
      <circle class="lens" cx="118" cy="105" r="82" />
      <circle class="lens" cx="322" cy="105" r="82" />
      <circle class="pupil" cx="122" cy="111" r="30" />
      <circle class="light" cx="326" cy="111" r="36" />
      <circle class="shine" cx="339" cy="98" r="9" />
    </svg>
  `,
  styles: `
    :host {
      display: block;
      width: var(--eye-width, 88px);
      flex: none;
      --eye-light: var(--mute);
    }
    svg {
      display: block;
      width: 100%;
      height: auto;
      overflow: visible;
    }
    .green {
      --eye-light: var(--ok);
    }
    .yellow {
      --eye-light: var(--warn);
    }
    .red {
      --eye-light: var(--crit);
    }
    .lens {
      fill: #eef1ff;
      stroke: #7b90f3;
      stroke-width: 22;
    }
    .bridge {
      fill: none;
      stroke: #7b90f3;
      stroke-width: 20;
      stroke-linecap: round;
    }
    .pupil {
      fill: #16213b;
    }
    .light {
      fill: var(--eye-light);
    }
    .shine {
      fill: #fff;
      opacity: 0.8;
    }
    .glow {
      fill: var(--eye-light);
      opacity: 0.22;
      filter: blur(18px);
      transform-origin: 320px 105px;
    }
    .unknown .glow,
    .unknown .shine {
      display: none;
    }
    .unknown .light {
      fill: none;
      stroke: var(--mute);
      stroke-width: 8;
    }
    .ring-track,
    .ring {
      fill: none;
      stroke-width: 7;
    }
    .ring-track {
      stroke: color-mix(in srgb, var(--eye-light) 18%, transparent);
    }
    .ring {
      stroke: var(--eye-light);
      stroke-linecap: round;
      transform: rotate(-90deg);
      transform-origin: 322px 105px;
      transition: stroke-dasharray 1s linear;
    }
    .checking .ring {
      transition: none;
    }
    .checking .glow {
      animation: breathe 2.4s ease-in-out infinite;
    }
    @keyframes breathe {
      0%,
      100% {
        opacity: 0.14;
        transform: scale(0.85);
      }
      50% {
        opacity: 0.38;
        transform: scale(1.08);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .checking .glow {
        animation: none;
      }
      .ring {
        transition: none;
      }
    }
  `,
})
export class NannyEye {
  readonly light = input<Light>('unknown');
  readonly label = input('');
  /** A check runs right now: the light breathes. */
  readonly checking = input(false);
  /** 0..1 of the way to the next scheduled check: a thin ring around the right lens fills; null for none. */
  readonly progress = input<number | null>(null);
  readonly ringDash = computed(
    () => `${Math.round((this.checking() ? 0 : (this.progress() ?? 0)) * 1000) / 10} 100`,
  );
}
