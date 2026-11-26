import { inject, Injectable } from '@angular/core';
import { ToastButton, ToastController, ToastOptions } from '@ionic/angular/standalone';

import { LanguageService } from '../i18n/language.service';

/** What a toast says about itself; the call sites name it with Ionic's `color`. */
export type ToastKind = 'error' | 'warning' | 'success' | 'info';

const KIND_BY_COLOR: Record<string, ToastKind> = {
  danger: 'error',
  warning: 'warning',
  success: 'success',
};

const ICON: Record<ToastKind, string> = {
  error: 'alert-circle',
  warning: 'warning',
  success: 'checkmark-circle',
  info: 'information-circle-outline',
};

/** Longest a toast stays on its own; past that the close button is the way out. */
const MAX_MS = 15_000;
/** Past this a toast gets a close button: nobody should have to wait for a long one to go. */
const CLOSE_AFTER_MS = 5_000;

/** Enough time to read the message: 1.5 s plus 60 ms per character, between the caller's duration and 15 s. */
export function readingTime(message: string, requested = 0): number {
  return Math.max(requested, Math.min(MAX_MS, 1500 + message.length * 60));
}

/**
 * The options every toast of the app gets, whatever the call site asked for
 * (docs/DESIGN.md, "Toasts"): no Ionic colour fill (white text on the dark
 * mode's light tones fell below 3:1, and the default toast drew the dark
 * mode's navy text on grey), but one readable surface with the kind as an
 * icon and a coloured edge (`kn-toast-<kind>`, styles.scss), a duration that
 * grows with the text, and a close button on long and error toasts.
 */
export function readableToastOptions(options: ToastOptions, closeLabel: string): ToastOptions {
  const { color, cssClass, ...rest } = options;
  const kind = KIND_BY_COLOR[color ?? ''] ?? 'info';
  const message = typeof rest.message === 'string' ? rest.message : '';
  const duration = readingTime(message, rest.duration ?? 3000);
  const extra = Array.isArray(cssClass) ? cssClass : cssClass ? [cssClass] : [];
  const closable = kind === 'error' || duration > CLOSE_AFTER_MS;
  const close: ToastButton = {
    icon: 'close',
    role: 'cancel',
    side: 'end',
    htmlAttributes: { 'aria-label': closeLabel },
  };
  return {
    ...rest,
    icon: rest.icon ?? ICON[kind],
    duration,
    cssClass: ['kn-toast', `kn-toast-${kind}`, ...extra],
    swipeGesture: rest.swipeGesture ?? 'vertical',
    buttons: closable && !rest.buttons?.length ? [close] : rest.buttons,
  };
}

/**
 * Every `inject(ToastController)` in the app gets this one (app.config.ts):
 * the call sites keep calling `create({ message, color, duration })`, and
 * readable toasts follow without each of them knowing the rules.
 */
@Injectable()
export class ReadableToastController extends ToastController {
  private readonly language = inject(LanguageService);

  override create(options: ToastOptions = {}): Promise<HTMLIonToastElement> {
    return super.create(
      readableToastOptions(options, this.language.translator().t('common.close')),
    );
  }
}
