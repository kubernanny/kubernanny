import { ChangeDetectionStrategy, Component, DestroyRef, inject, input, signal } from '@angular/core';
import { IconComponent } from './icon.component';
import { copyText } from '../core/clipboard';

@Component({
  selector: 'kn-copy-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  template: `
    <button type="button" class="copy" (click)="copy()" [attr.aria-label]="copied() ? 'Copied' : 'Copy ' + what()">
      <kn-icon [name]="copied() ? 'check' : 'copy'" />
      <span class="label" aria-hidden="true">{{ copied() ? 'Copied' : 'Copy' }}</span>
    </button>
    <span class="visually-hidden" aria-live="polite">{{ copied() ? 'Copied to the clipboard' : '' }}</span>
  `,
  styles: `
    :host {
      display: inline-flex;
    }
    .copy {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: var(--radius-s);
      border: 1px solid var(--line);
      background: var(--raise);
      color: var(--ink-2);
      font: 600 0.8125rem/1 var(--font-body);
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s, background 0.15s;
    }
    .copy:hover {
      color: var(--ink);
      border-color: var(--accent);
    }
  `,
})
export class CopyButtonComponent {
  readonly text = input.required<string>();
  /** What is copied, for the screen reader label ("Copy the install command"). */
  readonly what = input('the command');
  protected readonly copied = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
  }

  async copy(): Promise<void> {
    if (await copyText(this.text())) {
      this.copied.set(true);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.copied.set(false), 1800);
    }
  }
}
