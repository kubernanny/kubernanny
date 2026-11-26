import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { IonButton, ToastController } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';

import { AgentPushView, ClusterConfig } from '../core/agent.model';
import { AgentClient, describeError } from '../core/agent-client.service';
import { NativePushStatus, PushNative } from '../core/push/push-native';
import { PushRegistration } from '../core/push/push-registration.service';
import { pushTestResult } from '../core/push/push-test-result';
import { pushView } from '../core/push/push-view';
import { LanguageService } from '../i18n/language.service';
import { PushMarkerPickerComponent } from './push-marker-picker.component';

/**
 * "Push to this device": native push straight from the agent, sealed for
 * this device (docs/NOTIFICATIONS.md). Hidden unless this build can push
 * (the iOS or Android app with Firebase configured) and the agent answered;
 * locked when the deployment switched it off. The notification permission
 * is asked for only on the tap, never at start.
 *
 * Turning push on asks for nothing more. The authenticity marker
 * (core/push/push-marker.ts) is an optional setting under "Advanced", off
 * by default: while on, every push the phone opens starts with it, which is
 * how a notification someone else showed is told apart. On means this device
 * keeps a sign; turning it off forgets the sign, so the iOS extension and the
 * Android service show pushes without one.
 */
@Component({
  selector: 'app-push-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonButton, PushMarkerPickerComponent],
  template: `
    <ng-container *transloco="let t">
      @if (view().visible) {
        <section>
          <h2>{{ t('push.title') }}</h2>
          <p class="hint" [class.locked]="view().locked">{{ view().note }}</p>
          @if (view().deadman; as d) {
            <div class="deadman">
              <label class="toggle">
                <input
                  type="checkbox"
                  [checked]="d.on"
                  [disabled]="!d.editable || busy()"
                  (change)="setDeadman(d.on ? false : d.grace)"
                />
                <span>{{ t('push.deadmanTitle') }}</span>
              </label>
              @if (d.on && d.editable) {
                <span class="after" id="deadman-after">{{ t('push.deadmanAfter') }}</span>
                <div class="graces" role="radiogroup" aria-labelledby="deadman-after">
                  @for (g of d.graces; track g.minutes) {
                    <button
                      type="button"
                      role="radio"
                      [attr.aria-checked]="g.minutes === d.grace"
                      [class.chosen]="g.minutes === d.grace"
                      [disabled]="busy()"
                      (click)="setDeadman(g.minutes)"
                    >
                      {{ g.label }}
                    </button>
                  }
                </div>
              }
              <p class="hint">{{ d.note }}</p>
            </div>
          }
          <div class="actions">
            @if (view().action) {
              <ion-button fill="outline" [disabled]="busy()" (click)="toggle()">{{
                view().actionLabel
              }}</ion-button>
            }
            @if (view().canTest) {
              <ion-button fill="clear" [disabled]="busy()" (click)="test()">{{
                t('push.test')
              }}</ion-button>
            }
          </div>
          @if (view().sign; as sign) {
            <details class="advanced" [open]="advancedOpen()" (toggle)="advancedToggled($event)">
              <summary>{{ t('push.advanced') }}</summary>
              <div class="sign">
                <label class="toggle sign-toggle">
                  <input
                    type="checkbox"
                    [checked]="sign.on || picking()"
                    [disabled]="busy()"
                    (change)="toggleSign(sign.on)"
                  />
                  <span>{{ t('push.markerToggle') }}</span>
                </label>
                @if (picking()) {
                  <app-push-marker-picker
                    [current]="marker()"
                    [clusterName]="clusterName()"
                    (chosen)="markerChosen($event)"
                    (cancelled)="picking.set(false)"
                  />
                } @else {
                  <p class="hint">{{ sign.line }}</p>
                }
                @if (sign.on && !picking()) {
                  <ion-button
                    class="change"
                    fill="clear"
                    size="small"
                    [disabled]="busy()"
                    (click)="picking.set(true)"
                    >{{ t('push.markerChange') }}</ion-button
                  >
                }
                <details class="why">
                  <summary>{{ t('push.markerWhy') }}</summary>
                  <p class="hint">{{ t('push.markerWhyForge') }}</p>
                  <p class="hint">{{ t('push.markerWhySealed') }}</p>
                  <p class="hint">{{ t('push.markerWhySign') }}</p>
                  <p class="hint">{{ t('push.markerWhyNotNeeded') }}</p>
                </details>
              </div>
            </details>
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
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .locked::before {
      content: '🔒 ';
    }
    .advanced {
      margin: 1.25rem 0 0;
      border-top: 1px solid var(--line);
      padding-top: 0.75rem;
    }
    summary {
      cursor: pointer;
      color: var(--mute);
      font-size: 0.875rem;
      font-weight: 600;
      padding: 0.35rem 0;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 0.4rem;
    }
    summary::-webkit-details-marker {
      display: none;
    }
    summary::before {
      content: '';
      width: 0.45rem;
      height: 0.45rem;
      border-right: 2px solid currentColor;
      border-bottom: 2px solid currentColor;
      transform: rotate(-45deg);
      transition: transform 0.15s ease;
      margin-right: 0.15rem;
    }
    details[open] > summary::before {
      transform: rotate(45deg);
    }
    .sign {
      display: grid;
      gap: 0.6rem;
      margin-top: 0.5rem;
      padding: 0.8rem 0.9rem;
      border-radius: var(--radius-m);
      background: var(--surface);
    }
    .sign .change {
      justify-self: start;
      margin: -0.25rem 0 0 -0.6rem;
    }
    .why summary {
      color: var(--accent, currentColor);
    }
    .why p + p,
    .why summary + p {
      margin-top: 0.5rem;
    }
    .deadman {
      display: grid;
      gap: 0.6rem;
      margin: 0.9rem 0 0.9rem;
      padding: 0.8rem 0.9rem;
      border-radius: var(--radius-m);
      background: var(--surface);
    }
    .toggle {
      display: flex;
      gap: 0.6rem;
      align-items: center;
      font-size: 0.9375rem;
    }
    .toggle span {
      color: var(--ink);
      font-size: 0.9375rem;
      font-weight: 600;
    }
    .toggle input {
      width: 1.1rem;
      height: 1.1rem;
      padding: 0;
      accent-color: var(--accent, currentColor);
    }
    .graces {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 0.4rem;
      margin-top: -0.25rem;
    }
    .after {
      color: var(--mute);
      font-size: 0.8125rem;
      font-weight: 600;
    }
    .graces button {
      min-height: 2.5rem;
      padding: 0 0.25rem;
      white-space: nowrap;
      border-radius: 999px;
      border: 1px solid var(--line);
      background: transparent;
      color: var(--ink);
      font: inherit;
      font-size: 0.875rem;
      cursor: pointer;
    }
    .graces button.chosen {
      border-color: var(--accent, currentColor);
      background: var(--accent, currentColor);
      color: var(--ion-color-primary-contrast, #fff);
      font-weight: 600;
    }
  `,
})
export class PushSectionComponent {
  readonly cluster = input<ClusterConfig>();

  private readonly native = inject(PushNative);
  private readonly registration = inject(PushRegistration);
  private readonly client = inject(AgentClient);
  private readonly toasts = inject(ToastController);
  private readonly language = inject(LanguageService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  private readonly nativeStatus = signal<NativePushStatus | null>(null);
  private readonly agent = signal<AgentPushView | null>(null);
  readonly busy = signal(false);
  /** The device's authenticity marker, read from the native store; never leaves the device. */
  readonly marker = signal<string | null>(null);
  /** The sign picker is open: turning the sign on, or changing it. */
  readonly picking = signal(false);
  /** "Advanced" starts open where a sign is on (people who chose one before it was optional see it), else closed. */
  readonly advancedOpen = signal(false);

  readonly clusterName = computed(() => this.cluster()?.name ?? '');
  readonly view = computed(() =>
    pushView(
      {
        demo: !!this.cluster()?.demo,
        native: this.nativeStatus(),
        agent: this.agent(),
        marker: this.marker(),
      },
      this.language.translator(),
    ),
  );

  constructor() {
    void this.native.status().then(async (s) => {
      this.nativeStatus.set(s);
      if (s.available) {
        const marker = await this.native.marker();
        this.marker.set(marker);
        this.advancedOpen.set(marker !== null);
      }
    });
    effect(() => {
      const cluster = this.cluster();
      if (cluster && !cluster.demo) {
        void this.load(cluster);
      }
    });
  }

  private async load(cluster: ClusterConfig): Promise<void> {
    try {
      this.agent.set(await this.client.pushState(cluster));
    } catch {
      // An agent before native push (no /push) or out of reach: the section stays hidden.
      this.agent.set(null);
    }
  }

  /** Scrolls the section into view and focuses its button (the widget section's "Turn push on"). */
  reveal(): void {
    const el = this.host.nativeElement;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.querySelector<HTMLElement>('ion-button')?.focus({ preventScroll: true });
  }

  async toggle(): Promise<void> {
    const cluster = this.cluster();
    const action = this.view().action;
    if (!cluster || !action) {
      return;
    }
    await this.run(action);
  }

  advancedToggled(event: Event): void {
    this.advancedOpen.set((event.target as HTMLDetailsElement).open);
  }

  /**
   * The sign switch. On opens the picker; the sign is kept, and the switch
   * shows on, only once one is chosen (cancel leaves it off). Off forgets
   * the sign on this device, so pushes show without it.
   */
  async toggleSign(on: boolean): Promise<void> {
    if (!on) {
      this.picking.update((open) => !open);
      return;
    }
    const tr = this.language.translator();
    this.picking.set(false);
    try {
      await this.native.removeMarker();
      this.marker.set(null);
      await this.toast(tr.t('push.markerRemoved'));
    } catch (err) {
      await this.toast(describeError(err, tr), 'danger');
    }
  }

  async markerChosen(marker: string): Promise<void> {
    const tr = this.language.translator();
    this.picking.set(false);
    try {
      await this.native.setMarker(marker);
      this.marker.set(marker);
      await this.toast(tr.t('push.markerSaved'));
    } catch (err) {
      await this.toast(describeError(err, tr), 'danger');
    }
  }

  private async run(action: 'enable' | 'disable'): Promise<void> {
    const cluster = this.cluster();
    if (!cluster) {
      return;
    }
    const tr = this.language.translator();
    this.busy.set(true);
    try {
      if (action === 'enable') {
        const outcome = await this.registration.enable(cluster);
        await this.toast(
          tr.t(
            outcome === 'enabled'
              ? 'push.enabled'
              : outcome === 'denied'
                ? 'push.denied'
                : 'push.noRelay',
          ),
        );
      } else {
        await this.registration.disable(cluster);
        await this.toast(tr.t('push.disabled'));
      }
      await this.load(cluster);
    } catch (err) {
      await this.toast(describeError(err, tr), 'danger');
    } finally {
      this.busy.set(false);
    }
  }

  /** The dead man's switch: a grace in minutes, or false for off; registered again at once. */
  async setDeadman(deadman: number | false): Promise<void> {
    const cluster = this.cluster();
    if (!cluster) {
      return;
    }
    const tr = this.language.translator();
    this.busy.set(true);
    try {
      await this.registration.setDeadman(cluster, deadman);
      await this.load(cluster);
      await this.toast(
        deadman === false ? tr.t('push.deadmanOff') : tr.t('push.deadmanOn', { n: deadman }),
      );
    } catch (err) {
      await this.toast(describeError(err, tr), 'danger');
    } finally {
      this.busy.set(false);
    }
  }

  async test(): Promise<void> {
    const cluster = this.cluster();
    if (!cluster) {
      return;
    }
    const tr = this.language.translator();
    this.busy.set(true);
    try {
      const { outcome } = await this.client.testPush(cluster);
      const result = pushTestResult(outcome, cluster.relayUrl, tr);
      await this.toast(result.message, result.color);
    } catch (err) {
      await this.toast(describeError(err, tr), 'danger');
    } finally {
      this.busy.set(false);
    }
  }

  private async toast(message: string, color?: 'success' | 'danger'): Promise<void> {
    const toast = await this.toasts.create({
      message,
      duration: 3000,
      position: 'bottom',
      ...(color ? { color } : {}),
    });
    await toast.present();
  }
}
