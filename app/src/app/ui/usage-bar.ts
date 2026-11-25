import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * A slim bar for the key figures: use (solid, in the figure's tone), requests
 * (hatched) and the end of the limits (a tick, dashed at the edge when they
 * exceed what there is). Decorative: the numbers are written next to it.
 */
@Component({
  selector: 'app-usage-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="track" aria-hidden="true">
      @if (reservedPct() > usedPct()) {
        <span class="reserved" [style.width.%]="reservedPct()"></span>
      }
      <span class="used" [style.width.%]="usedPct()"></span>
      @if (limitPct() !== null) {
        <span class="limit" [class.over]="limitOver()" [style.left.%]="limitPct()"></span>
      }
    </span>
  `,
  styles: `
    :host {
      display: block;
    }
    .track {
      position: relative;
      display: block;
      height: 6px;
      border-radius: 3px;
      background: var(--raise);
      overflow: hidden;
    }
    .used,
    .reserved {
      position: absolute;
      inset: 0 auto 0 0;
      border-radius: 3px;
    }
    .used {
      background: var(--tone, var(--chart));
    }
    .reserved {
      background: repeating-linear-gradient(135deg, var(--tone-soft, var(--mute-soft)) 0 3px, transparent 3px 6px);
      box-shadow: inset 0 0 0 1px var(--tone-soft, var(--mute-soft));
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
  `,
})
export class UsageBar {
  /** Shares of what there is, 0..1 (the limit may exceed 1). */
  readonly used = input<number | null>(null);
  readonly reserved = input<number | null>(null);
  readonly limit = input<number | null>(null);

  readonly usedPct = computed(() => Math.min(100, Math.round((this.used() ?? 0) * 100)));
  readonly reservedPct = computed(() => Math.min(100, Math.round((this.reserved() ?? 0) * 100)));
  readonly limitPct = computed(() => {
    const l = this.limit();
    return l === null || l <= 0 ? null : Math.min(100, l * 100);
  });
  readonly limitOver = computed(() => (this.limit() ?? 0) > 1);
}
