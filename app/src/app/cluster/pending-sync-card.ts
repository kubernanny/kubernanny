import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';

/** "⟳ 3 Apps bereit zum Sync ›": a calm line, not a problem; opens the list. Hidden by its parent when there are none. */
@Component({
  selector: 'app-pending-sync-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon],
  template: `
    <button type="button" (click)="open.emit()">
      <ion-icon class="lead" name="sync-outline" aria-hidden="true" />
      <span class="text">
        <strong>{{ label() }}</strong>
        <span class="hint">{{ hint() }}</span>
      </span>
      <ion-icon class="chev" name="chevron-forward" aria-hidden="true" />
    </button>
  `,
  styles: `
    :host {
      display: block;
    }
    button {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 0.8rem;
      padding: 0.8rem 1rem;
      border: 1px solid var(--line);
      border-radius: var(--radius-m);
      background: var(--surface);
      color: var(--ink);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    button:hover {
      background: var(--raise);
    }
    .lead {
      flex: none;
      font-size: 1.3rem;
      color: var(--accent);
    }
    .text {
      flex: 1;
      min-width: 0;
      display: grid;
      gap: 0.1rem;
    }
    strong {
      font-weight: 650;
    }
    .hint {
      color: var(--mute);
      font-size: 0.8125rem;
    }
    .chev {
      flex: none;
      color: var(--mute);
    }
  `,
})
export class PendingSyncCard {
  readonly label = input.required<string>();
  readonly hint = input('');
  readonly open = output<void>();
}
