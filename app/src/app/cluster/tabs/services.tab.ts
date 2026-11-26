import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';

import { CategoryGroup } from '../cluster-view';

@Component({
  selector: 'app-services-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonIcon],
  template: `
    <ng-container *transloco="let t">
      <p class="muted intro">{{ t('services.intro') }}</p>
      @for (group of groups(); track group.category) {
        <section>
          <h2>
            {{ group.label }} <span class="count">{{ group.rows.length }}</span>
          </h2>
          <ul>
            @for (row of group.rows; track row.module.id) {
              <li>
                <button
                  type="button"
                  [class]="'tone-' + row.tone"
                  (click)="open.emit(row.module.id)"
                >
                  <span class="icon"><ion-icon [name]="row.module.icon" aria-hidden="true" /></span>
                  <span class="text">
                    <span class="name">
                      <strong>{{ row.module.name }}</strong>
                      @if (row.meta) {
                        <span class="meta">{{ row.meta }}</span>
                      }
                    </span>
                    <span class="summary">{{ row.module.summary }}</span>
                  </span>
                  <span class="status">
                    <span class="dot" aria-hidden="true"></span>
                    <span class="sr">{{ row.statusLabel }}</span>
                  </span>
                  <ion-icon name="chevron-forward" class="chev" aria-hidden="true" />
                </button>
              </li>
            }
          </ul>
        </section>
      }
    </ng-container>
  `,
  styles: `
    .intro {
      font-size: 0.9375rem;
      margin: 0 0 1.5rem;
      max-width: 60ch;
    }
    section {
      margin-bottom: 1.75rem;
    }
    h2 {
      font-size: 1.1rem;
      font-weight: 650;
      margin-bottom: 0.6rem;
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
    }
    .count {
      color: var(--mute);
      font-family: var(--font-body);
      font-size: 0.875rem;
      font-weight: 500;
    }
    ul {
      list-style: none;
      margin: 0;
      padding: 0;
      background: var(--surface);
      border-radius: var(--radius-l);
      overflow: hidden;
    }
    li + li {
      border-top: 1px solid var(--line);
    }
    button {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 0.85rem;
      padding: 0.8rem 0.9rem;
      background: transparent;
      border: 0;
      color: var(--ink);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    button:hover {
      background: var(--raise);
    }
    .icon {
      flex: none;
      width: 2.5rem;
      height: 2.5rem;
      border-radius: 12px;
      display: grid;
      place-items: center;
      background: var(--raise);
      color: var(--ink-2);
      font-size: 1.25rem;
    }
    .text {
      flex: 1;
      min-width: 0;
      display: grid;
      gap: 0.1rem;
      /* Long URLs in a summary break instead of widening the column under the status. */
      overflow-wrap: anywhere;
    }
    .name {
      display: flex;
      gap: 0.5rem;
      align-items: baseline;
      flex-wrap: wrap;
    }
    .meta {
      color: var(--mute);
      font-size: 0.8125rem;
    }
    .summary {
      color: var(--ink-2);
      font-size: 0.875rem;
    }
    .status {
      flex: none;
      display: flex;
      align-items: center;
      gap: 0.4rem;
      color: var(--tone);
      font-size: 0.8125rem;
      font-weight: 600;
    }
    .dot {
      width: 0.6rem;
      height: 0.6rem;
      border-radius: 50%;
      background: var(--tone);
      box-shadow: 0 0 0 4px var(--tone-soft);
    }
    .tone-ok .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
    }
    .chev {
      color: var(--mute);
      flex: none;
    }
    /* Narrow rows (small phones, large text): the status word goes under the text, so names keep their width. */
    li {
      container-type: inline-size;
    }
    @container (max-width: 20rem) {
      button:not(.tone-ok) {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        grid-template-areas:
          'icon text chev'
          'icon status chev';
        row-gap: 0.35rem;
      }
      button:not(.tone-ok) .icon {
        grid-area: icon;
        align-self: start;
      }
      button:not(.tone-ok) .text {
        grid-area: text;
      }
      button:not(.tone-ok) .status {
        grid-area: status;
      }
      button:not(.tone-ok) .chev {
        grid-area: chev;
      }
    }
  `,
})
export class ServicesTab {
  readonly groups = input.required<CategoryGroup[]>();
  readonly open = output<string>();
}
