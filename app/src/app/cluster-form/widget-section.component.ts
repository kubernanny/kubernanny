import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { IonButton } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';

import { ClusterConfig } from '../core/agent.model';
import { WidgetSync } from '../core/widget/widget-sync.service';
import { LanguageService } from '../i18n/language.service';
import { PushSectionComponent } from './push-section.component';
import { widgetView } from './widget-view';

/**
 * Whether this cluster appears on the home-screen widgets, and why a widget
 * may be old: when it updates, that push keeps it fresh, what grey means.
 * Shows whether push is on for this device, with a way to the push section
 * when it is off. Only in the iOS and Android apps.
 */
@Component({
  selector: 'app-widget-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonButton],
  template: `
    <ng-container *transloco="let t">
      @if (view(); as v) {
        <section>
          <h2>{{ t('widget.title') }}</h2>
          <label class="toggle">
            <input type="checkbox" [checked]="v.shown" [disabled]="v.allOff" (change)="toggle()" />
            <span>{{ t('widget.showCluster') }}</span>
          </label>
          @if (v.allOff) {
            <p class="hint">{{ t('widget.allOffNote') }}</p>
          } @else if (v.shown) {
            @if (v.pushLine) {
              <div class="push" [class.on]="v.push === 'on'">
                <span class="dot" aria-hidden="true"></span>
                <p>{{ v.pushLine }}</p>
                @if (v.offerPush) {
                  <ion-button fill="outline" size="small" (click)="showPush()">{{
                    t('widget.turnOnPush')
                  }}</ion-button>
                }
              </div>
            }
            <ul class="hint lines">
              @for (line of v.lines; track $index) {
                <li>{{ line }}</li>
              }
            </ul>
          }
          <p class="hint">{{ t('widget.hint') }}</p>
        </section>
      }
    </ng-container>
  `,
  styleUrl: './form-section.css',
  styles: `
    :host {
      display: block;
    }
    /* The dot is sized in em and sits on the first line box of the text next to it. */
    .push {
      display: grid;
      grid-template-columns: auto 1fr;
      align-items: start;
      gap: 0.5rem;
      padding: 1rem;
      border-radius: var(--radius-m);
      background: var(--mute-soft);
      font-size: 0.9375rem;
      line-height: 1.4;
    }
    .push.on {
      background: var(--ok-soft);
    }
    .push p {
      margin: 0;
    }
    .dot {
      width: 0.6em;
      height: 0.6em;
      margin-top: 0.4em;
      border-radius: 50%;
      background: var(--mute);
    }
    .push.on .dot {
      background: var(--ok);
    }
    .push ion-button {
      grid-column: 2;
      justify-self: start;
      margin: 0;
    }
    .lines {
      display: grid;
      gap: 0.5rem;
      margin: 0;
      padding-left: 1.1rem;
    }
  `,
})
export class WidgetSectionComponent {
  readonly cluster = input<ClusterConfig>();
  /** The push section on the same page: its state is this device's push, and "Turn push on" scrolls to it. */
  readonly push = input<PushSectionComponent>();
  private readonly widgets = inject(WidgetSync);
  private readonly language = inject(LanguageService);

  readonly view = computed(() => {
    const c = this.cluster();
    if (!c || !this.widgets.supported) {
      return null;
    }
    return {
      shown: !c.widgetOff,
      allOff: this.widgets.allOff(),
      ...widgetView({ cluster: c, push: this.push()?.view() ?? null }, this.language.translator()),
    };
  });

  showPush(): void {
    this.push()?.reveal();
  }

  async toggle(): Promise<void> {
    const c = this.cluster();
    if (c) {
      await this.widgets.setShown(c, Boolean(c.widgetOff));
    }
  }
}
