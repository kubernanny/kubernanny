import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { TranslocoDirective } from '@jsverse/transloco';
import { ClusterConfig } from '../core/agent.model';
import { WidgetSync } from '../core/widget/widget-sync.service';

/** Whether this cluster appears on the home-screen widgets. Only in the iOS and Android apps. */
@Component({
  selector: 'app-widget-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective],
  template: `
    <ng-container *transloco="let t">
      @if (view(); as v) {
        <section>
          <h2>{{ t('widget.title') }}</h2>
          <label class="toggle">
            <input type="checkbox" [checked]="v.shown" [disabled]="v.allOff" (change)="toggle()" />
            <span>{{ t('widget.showCluster') }}</span>
          </label>
          <p class="hint">{{ t('widget.hint') }}</p>
          @if (v.allOff) {
            <p class="hint">{{ t('widget.allOffNote') }}</p>
          }
        </section>
      }
    </ng-container>
  `,
  styleUrl: './form-section.css',
  styles: `
    :host {
      display: block;
    }
    .toggle {
      display: flex;
      gap: 0.6rem;
      align-items: center;
      margin: 0 0 0.75rem;
      font-size: 0.9375rem;
    }
    .toggle input {
      width: 1.1rem;
      height: 1.1rem;
      accent-color: var(--accent, currentColor);
    }
    .hint + .hint {
      margin-top: 0.5rem;
    }
  `,
})
export class WidgetSectionComponent {
  readonly cluster = input<ClusterConfig>();
  private readonly widgets = inject(WidgetSync);

  readonly view = computed(() => {
    const c = this.cluster();
    return c && this.widgets.supported ? { shown: !c.widgetOff, allOff: this.widgets.allOff() } : null;
  });

  async toggle(): Promise<void> {
    const c = this.cluster();
    if (c) {
      await this.widgets.setShown(c, Boolean(c.widgetOff));
    }
  }
}
