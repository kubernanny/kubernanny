import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { IonButton } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';

import { ClusterConfig } from '../core/agent.model';
import { WidgetBridge } from '../core/widget/widget-bridge';
import { REFRESH_CHOICES, RefreshMinutes } from '../core/widget/widget-summary';
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
          @if (!v.allOff) {
            <h3 id="widget-refresh-label">{{ t('widget.refreshTitle') }}</h3>
            @if (refreshSupported()) {
              <div class="choices" role="group" aria-labelledby="widget-refresh-label">
                @for (m of choices; track m) {
                  <button
                    type="button"
                    [class.on]="m === refreshMinutes()"
                    [attr.aria-pressed]="m === refreshMinutes()"
                    (click)="setRefresh(m)"
                  >
                    {{ m === 0 ? t('widget.refreshOff') : t('widget.refreshEvery', { n: m }) }}
                  </button>
                }
              </div>
              <p class="hint">{{ t('widget.refreshHint') }}</p>
              @if (refreshMinutes() > 0) {
                <p class="hint">
                  {{ android ? t('widget.refreshAndroid') : t('widget.refreshIos') }}
                </p>
                @if (android) {
                  <ion-button fill="outline" size="small" (click)="openBattery()">{{
                    t('widget.batterySettings')
                  }}</ion-button>
                }
              }
            } @else {
              <p class="hint">{{ t('widget.refreshUnsupported') }}</p>
            }
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
    h3 {
      font-size: 1rem;
      font-weight: 650;
      margin: 1.25rem 0 0.5rem;
    }
    .choices {
      display: inline-flex;
      flex-wrap: wrap;
      background: var(--surface);
      border-radius: 999px;
      padding: 3px;
      margin-bottom: 0.5rem;
    }
    .choices button {
      border: 0;
      background: transparent;
      color: var(--mute);
      font: inherit;
      font-weight: 600;
      padding: 0.35rem 0.8rem;
      border-radius: 999px;
      cursor: pointer;
    }
    .choices button.on {
      background: var(--raise);
      color: var(--ink);
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
  private readonly bridge = inject(WidgetBridge);
  private readonly language = inject(LanguageService);
  readonly choices = REFRESH_CHOICES;
  readonly refreshMinutes = this.widgets.refreshMinutes;
  readonly refreshSupported = this.widgets.refreshSupported;
  readonly android = Capacitor.getPlatform() === 'android';

  readonly view = computed(() => {
    const c = this.cluster();
    if (!c || !this.widgets.supported) {
      return null;
    }
    return {
      shown: !c.widgetOff,
      allOff: this.widgets.allOff(),
      ...widgetView(
        {
          cluster: c,
          push: this.push()?.view() ?? null,
          refreshMinutes: this.widgets.refreshMinutes(),
        },
        this.language.translator(),
      ),
    };
  });

  setRefresh(minutes: RefreshMinutes): void {
    void this.widgets.setRefreshMinutes(minutes);
  }

  openBattery(): void {
    void this.bridge.openBatterySettings();
  }

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
