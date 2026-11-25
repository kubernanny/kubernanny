import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { IonButton } from '@ionic/angular/standalone';
import { TranslocoDirective } from '@jsverse/transloco';
import { MAX_MARKER_LENGTH, markedTitle, normalizeMarker, suggestMarker } from '../core/push/push-marker';

/**
 * Picks the authenticity marker for native push (core/push/push-marker.ts):
 * three random emoji (a new draw on request), the sign in use, or an own
 * word of at least three characters. Emits the normalised marker.
 */
@Component({
  selector: 'app-push-marker-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslocoDirective, IonButton],
  template: `
    <ng-container *transloco="let t">
      <div class="picker">
        <h3>{{ t('push.markerTitle') }}</h3>
        <p class="hint">{{ t('push.markerExplain') }}</p>
        <div class="choices" role="radiogroup" [attr.aria-label]="t('push.markerTitle')">
          @for (chip of vm().chips; track chip.value) {
            <button type="button" role="radio" class="chip" [class.selected]="chip.selected" [attr.aria-checked]="chip.selected" (click)="pick(chip.value)">{{ chip.value }}</button>
          }
          <button type="button" role="radio" class="chip own" [class.selected]="vm().own" [attr.aria-checked]="vm().own" (click)="useOwn()">{{ t('push.markerOwn') }}</button>
        </div>
        @if (!vm().own) {
          <ion-button fill="clear" size="small" (click)="reroll()">{{ t('push.markerAnother') }}</ion-button>
        }
        @if (vm().own) {
          <label>
            <span>{{ t('push.markerOwn') }}</span>
            <input type="text" [value]="ownWord()" [attr.maxlength]="maxInput" [placeholder]="t('push.markerOwnPlaceholder')" autocomplete="off" (input)="typed($event)" />
          </label>
          @if (vm().invalid) {
            <p class="hint error">{{ t('push.markerInvalid') }}</p>
          }
        }
        @if (vm().marker) {
          <p class="hint">{{ t('push.markerPreview') }}</p>
          <p class="preview">{{ vm().preview }} {{ t('push.markerSample') }}</p>
        }
        <p class="hint">{{ t('push.markerDevice') }}</p>
        <div class="actions">
          <ion-button fill="solid" [disabled]="!vm().marker" (click)="save()">{{ t('push.markerSave') }}</ion-button>
          <ion-button fill="clear" (click)="cancelled.emit()">{{ t('common.cancel') }}</ion-button>
        </div>
      </div>
    </ng-container>
  `,
  styleUrl: './form-section.css',
  styles: `
    .picker {
      display: grid;
      gap: 0.75rem;
      margin: 1rem 0;
      padding: 1rem;
      border-radius: var(--radius-m);
      background: var(--surface);
    }
    h3 {
      font-size: 1rem;
      font-weight: 650;
      margin: 0;
    }
    .choices {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
    .chip {
      min-width: 2.75rem;
      min-height: 2.75rem;
      padding: 0 0.75rem;
      border-radius: var(--radius-m);
      border: 1px solid var(--line);
      background: transparent;
      color: var(--ink);
      font: inherit;
      font-size: 1.25rem;
    }
    .chip.own {
      font-size: 0.875rem;
    }
    .chip.selected {
      border-color: var(--accent, #8ea2ff);
      box-shadow: 0 0 0 2px var(--accent, #8ea2ff);
    }
    .preview {
      margin: 0;
      font-weight: 600;
      overflow-wrap: anywhere;
    }
    .error {
      color: var(--crit, #ff5d73);
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }
  `,
})
export class PushMarkerPickerComponent {
  /** The marker in use, if any: preselected (or prefilled as own word). */
  readonly current = input<string | null>(null);
  readonly clusterName = input('');
  readonly chosen = output<string>();
  readonly cancelled = output<void>();

  /** Room for a pasted word with spaces around it; normalizeMarker decides. */
  protected readonly maxInput = MAX_MARKER_LENGTH * 4;

  private readonly picked = signal<string | null>(null);
  private readonly own = signal<boolean | null>(null);
  readonly ownWord = signal<string | null>(null);
  private readonly suggestion = signal(suggestMarker());

  readonly vm = computed(() => {
    const current = this.current();
    // The sign in use stays offered next to a fresh suggestion, so keeping it is one tap.
    const choices = [...new Set([...(current ? [current] : []), this.suggestion()])];
    const own = this.own() ?? false;
    const choice = this.picked() ?? current ?? this.suggestion();
    const word = this.ownWord() ?? '';
    const marker = own ? normalizeMarker(word) : choice;
    return {
      chips: choices.map((value) => ({ value, selected: !own && value === choice })),
      own,
      marker,
      invalid: own && word.trim() !== '' && marker === null,
      preview: markedTitle(marker, `${this.clusterName() || 'homelab'}:`),
    };
  });

  pick(value: string): void {
    this.picked.set(value);
    this.own.set(false);
  }

  useOwn(): void {
    if (this.ownWord() === null) {
      this.ownWord.set('');
    }
    this.own.set(true);
  }

  reroll(): void {
    const next = suggestMarker();
    this.suggestion.set(next);
    this.picked.set(next);
    this.own.set(false);
  }

  typed(event: Event): void {
    this.ownWord.set((event.target as HTMLInputElement).value);
  }

  save(): void {
    const marker = this.vm().marker;
    if (marker) {
      this.chosen.emit(marker);
    }
  }
}
