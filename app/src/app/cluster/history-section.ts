import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';

import { HISTORY_PREVIEW, HistoryVM } from './history-view';

/**
 * The last seven days on the overview: a strip with one cell per day, then
 * the newest incidents; "show all" unfolds the rest in place. On the overview
 * rather than in a tab of its own: it answers the overview's question ("was
 * it calm lately?"), and the phone's tab bar already scrolls.
 */
@Component({
  selector: 'app-history-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonIcon],
  template: `
    <ng-container *transloco="let t">
      <section class="history">
        <div class="head">
          <h2>{{ t('history.title') }}</h2>
          <span class="muted">{{ vm().summary }}</span>
        </div>
        <ol class="strip" [attr.aria-label]="t('history.strip')">
          @for (d of vm().days; track d.key) {
            <li
              [class]="'tone-' + d.tone"
              [class.today]="d.today"
              [attr.title]="d.title"
              [attr.aria-label]="d.title"
            >
              <span class="cell" aria-hidden="true">
                @if (d.count > 0) {
                  {{ d.count }}
                }
              </span>
              <span class="day" aria-hidden="true">{{ d.label }}</span>
            </li>
          }
        </ol>
        @if (vm().coveredNote; as note) {
          <p class="muted covered">{{ note }}</p>
        }
        @for (g of shown(); track g.key) {
          <h3>{{ g.label }}</h3>
          <ul>
            @for (r of g.rows; track r.id) {
              <li [class]="'tone-' + r.tone" [class.open]="r.open">
                <ion-icon [name]="r.icon" aria-hidden="true" />
                <div class="text">
                  <span class="title">{{ r.title }}</span>
                  <span class="meta">
                    <span>
                      {{ r.meta }}
                      @if (r.silenced) {
                        <span class="silenced"
                          ><ion-icon name="notifications-off-outline" aria-hidden="true" />{{
                            t('history.silenced')
                          }}</span
                        >
                      }
                    </span>
                    <span class="duration">{{ r.duration }}</span>
                  </span>
                </div>
              </li>
            }
          </ul>
        }
        @if (vm().total > preview) {
          <button
            type="button"
            class="more"
            [attr.aria-expanded]="expanded()"
            (click)="expanded.set(!expanded())"
          >
            {{ expanded() ? t('history.showLess') : t('history.showAll', { count: vm().total }) }}
            <ion-icon [name]="expanded() ? 'chevron-up' : 'chevron-down'" aria-hidden="true" />
          </button>
        }
      </section>
    </ng-container>
  `,
  styles: `
    :host {
      display: block;
      margin-bottom: 2rem;
    }
    .head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 0.25rem 1rem;
      margin-bottom: 0.75rem;
    }
    h2 {
      font-size: 1.2rem;
      font-weight: 650;
      margin: 0;
    }
    .head .muted {
      font-size: 0.875rem;
    }
    .strip {
      list-style: none;
      margin: 0 0 0.5rem;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(7, minmax(0, 1fr));
      gap: 0.375rem;
      max-width: 34rem;
    }
    .strip li {
      display: grid;
      gap: 0.3rem;
      justify-items: center;
    }
    .cell {
      width: 100%;
      height: 2.25rem;
      border-radius: var(--radius-s);
      display: grid;
      place-items: center;
      font-weight: 700;
      font-size: 0.875rem;
      color: var(--tone);
      background: var(--tone-soft);
    }
    /* A quiet day is still a visible cell, in both themes: a faint mint fill with a hairline. */
    .tone-ok .cell {
      background: color-mix(in srgb, var(--ok) 10%, var(--surface));
      box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ok) 22%, transparent);
    }
    .tone-muted .cell {
      background: repeating-linear-gradient(135deg, var(--mute-soft) 0 4px, transparent 4px 8px);
    }
    .tone-warning .cell,
    .tone-critical .cell {
      box-shadow: inset 0 -3px 0 var(--tone);
    }
    .day {
      font-size: 0.75rem;
      color: var(--mute);
    }
    .today .day {
      color: var(--ink);
      font-weight: 650;
    }
    .covered {
      font-size: 0.8125rem;
      margin: 0.25rem 0 0;
    }
    h3 {
      font-size: 0.8125rem;
      font-weight: 650;
      color: var(--mute);
      margin: 1.1rem 0 0.4rem;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      background: var(--surface);
      border-radius: var(--radius-m);
    }
    ul li {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 0.75rem;
      align-items: start;
      padding: 0.75rem 0.9rem;
    }
    ul li + li {
      border-top: 1px solid var(--line);
    }
    ul li > ion-icon {
      color: var(--tone);
      font-size: 1.15rem;
      margin-top: 0.1rem;
    }
    .text {
      display: grid;
      gap: 0.15rem;
      min-width: 0;
    }
    .title {
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 0.1rem 1rem;
      color: var(--mute);
      font-size: 0.8125rem;
    }
    .silenced {
      display: inline-flex;
      align-items: center;
      gap: 0.2rem;
      margin-left: 0.5rem;
    }
    .duration {
      margin-left: auto;
    }
    .open .duration {
      color: var(--tone);
      font-weight: 600;
    }
    .more {
      display: inline-flex;
      align-items: center;
      gap: 0.35rem;
      margin-top: 0.6rem;
      padding: 0.4rem 0;
      border: 0;
      background: none;
      color: var(--accent);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
  `,
})
export class HistorySection {
  readonly vm = input.required<HistoryVM>();
  readonly expanded = signal(false);
  readonly preview = HISTORY_PREVIEW;
  readonly shown = computed(() => (this.expanded() ? this.vm().groups : this.vm().preview));
}
