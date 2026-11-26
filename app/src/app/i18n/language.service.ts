import { computed, DOCUMENT, inject, Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

import { Lang, langFromLocale, LANGS } from './lang';
import { Translator, translatorFor } from './translator';

/** What the person picked: follow the device, or one language for good. */
export type LangChoice = 'auto' | Lang;

const KEY = 'language';

/**
 * The UI language: the device's (German for any `de*` locale, English
 * otherwise) unless the person picked one, stored with Capacitor
 * Preferences. Code reads `translator`; provideI18n() keeps Transloco, which
 * templates read, on the same language.
 */
@Injectable({ providedIn: 'root' })
export class LanguageService {
  private readonly document = inject(DOCUMENT);
  private readonly device = signal<Lang>(deviceLang());
  readonly choice = signal<LangChoice>('auto');
  readonly lang = computed<Lang>(() => {
    const choice = this.choice();
    return choice === 'auto' ? this.device() : choice;
  });
  /** Texts in the active language for view models, toasts and errors; a new value when the language changes. */
  readonly translator = computed<Translator>(() => translatorFor(this.lang()));

  constructor() {
    this.apply();
    // The device language can change while the app runs (Android, browsers).
    this.document.defaultView?.addEventListener('languagechange', () => {
      this.device.set(deviceLang());
      this.apply();
    });
  }

  /** Reads the stored choice; until it is read, the device language applies. */
  async init(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: KEY });
      if (value === 'auto' || LANGS.includes(value as Lang)) {
        this.choice.set(value as LangChoice);
      }
    } catch {
      // No stored choice readable: follow the device.
    }
    this.apply();
  }

  /** Switches the language for this session only. */
  use(choice: LangChoice): void {
    this.choice.set(choice);
    this.apply();
  }

  /** Switches the language and remembers it. */
  async choose(choice: LangChoice): Promise<void> {
    this.use(choice);
    try {
      await Preferences.set({ key: KEY, value: choice });
    } catch {
      // Not persisted (storage blocked): the choice still holds for this session.
    }
  }

  private apply(): void {
    const lang = this.lang();
    const root = this.document.documentElement;
    root.lang = lang;
    this.document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', translatorFor(lang).t('app.description'));
  }
}

function deviceLang(): Lang {
  return langFromLocale(globalThis.navigator?.languages?.[0] ?? globalThis.navigator?.language);
}
