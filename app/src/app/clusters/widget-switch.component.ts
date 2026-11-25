import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { WidgetSync } from '../core/widget/widget-sync.service';

/** The global on/off for the home-screen widgets, next to the language. Only in the iOS and Android apps. */
@Component({
  selector: 'app-widget-switch',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      @if (options(); as opts) {
        <span id="widgets-label">{{ t('widget.allLabel') }}</span>
        <div class="choices" role="group" aria-labelledby="widgets-label" [title]="t('widget.allTitle')">
          @for (o of opts; track o.off) {
            <button type="button" [class.on]="o.on" [attr.aria-pressed]="o.on" (click)="choose(o.off)">{{ t(o.label) }}</button>
          }
        </div>
      }
    </ng-container>
  `,
  styles: `
    :host {
      display: contents;
    }
    .choices {
      display: inline-flex;
      background: var(--surface);
      border-radius: 999px;
      padding: 3px;
    }
    .choices button {
      border: 0;
      background: transparent;
      color: var(--mute);
      font: inherit;
      font-weight: 600;
      padding: 0.3rem 0.75rem;
      border-radius: 999px;
      cursor: pointer;
    }
    .choices button.on {
      background: var(--raise);
      color: var(--ink);
    }
  `,
})
export class WidgetSwitchComponent {
  private readonly widgets = inject(WidgetSync);

  readonly options = computed(() => {
    if (!this.widgets.supported) {
      return null;
    }
    const off = this.widgets.allOff();
    return [
      { off: false, on: !off, label: 'widget.on' as const },
      { off: true, on: off, label: 'widget.off' as const },
    ];
  });

  choose(off: boolean): void {
    void this.widgets.setAllOff(off);
  }
}
