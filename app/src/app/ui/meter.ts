import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { Tone } from '../core/agent.model';

/** Tone for a usage ratio: amber from 80 %, coral from 90 %. */
export function usageTone(ratio: number | null): Tone {
  if (ratio === null) {
    return 'muted';
  }
  return ratio >= 0.9 ? 'critical' : ratio >= 0.8 ? 'warning' : 'ok';
}

/**
 * A capacity bar: what is used (solid), what is reserved by requests (hatched),
 * and where the limits end (a tick; at the right edge, dashed, when they add
 * up to more than there is), against what there is. The label and numbers are
 * always written out (`text`, `note`), the colour and marks only repeat them.
 */
@Component({
  selector: 'app-meter',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="row">
      <span class="label">{{ label() }}</span>
      <span class="value">{{ text() }}</span>
    </div>
    <div class="track" [class]="'track tone-' + tone()" role="meter" [attr.aria-label]="label()" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="usedPct()">
      @if (reservedPct() > usedPct()) {
        <span class="reserved" [style.width.%]="reservedPct()"></span>
      }
      <span class="used" [style.width.%]="usedPct()"></span>
      @if (limitPct() !== null) {
        <span class="limit" [class.over]="limitOver()" [style.left.%]="limitPct()"></span>
      }
    </div>
    @if (note()) {
      <p class="note">{{ note() }}</p>
    }
  `,
  styles: `
    :host {
      display: block;
    }
    .row {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
      font-size: 0.8125rem;
      margin-bottom: 0.3rem;
    }
    .label {
      color: var(--mute);
      font-weight: 600;
    }
    .value {
      color: var(--ink-2);
      text-align: right;
    }
    .track {
      position: relative;
      height: 8px;
      border-radius: 4px;
      background: var(--raise);
      overflow: hidden;
    }
    .used,
    .reserved {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: 4px;
    }
    .used {
      background: var(--tone);
    }
    .reserved {
      background: repeating-linear-gradient(135deg, var(--tone-soft) 0 3px, transparent 3px 6px);
      box-shadow: inset 0 0 0 1px var(--tone-soft);
    }
    .limit {
      position: absolute;
      top: 0;
      bottom: 0;
      width: 2px;
      margin-left: -1px;
      background: var(--ink-2);
      opacity: 0.7;
    }
    .limit.over {
      margin-left: -2px;
      background: repeating-linear-gradient(180deg, var(--ink-2) 0 2px, transparent 2px 4px);
    }
    .note {
      margin: 0.3rem 0 0;
      font-size: 0.75rem;
      color: var(--mute);
      overflow-wrap: anywhere;
    }
  `,
})
export class Meter {
  readonly label = input.required<string>();
  /** 0..1, or null when unknown. */
  readonly used = input<number | null>(null);
  readonly reserved = input<number | null>(null);
  readonly text = input('');
  readonly toneOverride = input<Tone | null>(null);
  /** Limits as a share of what there is (may exceed 1), or null for no mark. */
  readonly limit = input<number | null>(null);
  /** A line under the bar: requests and limits in numbers. */
  readonly note = input('');

  readonly usedPct = computed(() => Math.min(100, Math.round((this.used() ?? 0) * 100)));
  readonly reservedPct = computed(() => Math.min(100, Math.round((this.reserved() ?? 0) * 100)));
  readonly limitPct = computed(() => {
    const l = this.limit();
    return l === null || l <= 0 ? null : Math.min(100, l * 100);
  });
  readonly limitOver = computed(() => (this.limit() ?? 0) > 1);
  readonly tone = computed(() => this.toneOverride() ?? usageTone(this.used()));
}
