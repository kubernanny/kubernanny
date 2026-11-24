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
 * against what there is. The label and number are always written out, the
 * colour only repeats them.
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
    </div>
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
  `,
})
export class Meter {
  readonly label = input.required<string>();
  /** 0..1, or null when unknown. */
  readonly used = input<number | null>(null);
  readonly reserved = input<number | null>(null);
  readonly text = input('');
  readonly toneOverride = input<Tone | null>(null);

  readonly usedPct = computed(() => Math.min(100, Math.round((this.used() ?? 0) * 100)));
  readonly reservedPct = computed(() => Math.min(100, Math.round((this.reserved() ?? 0) * 100)));
  readonly tone = computed(() => this.toneOverride() ?? usageTone(this.used()));
}
