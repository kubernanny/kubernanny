import { EnvironmentProviders, Injectable, Provider, effect, inject, isDevMode, provideAppInitializer, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { RouterStateSnapshot, TitleStrategy } from '@angular/router';
import { Translation, TranslocoLoader, TranslocoService, provideTransloco } from '@jsverse/transloco';
import { of } from 'rxjs';
import { TranslationKey, flatten } from './dictionary';
import { LANGS, Lang } from './lang';
import { LanguageService } from './language.service';
import { DICTIONARIES } from './translator';

/**
 * The texts ship inside the bundle: no HTTP loader, so the static demo, the
 * agent's web UI and the native apps all start offline and without a flash
 * of keys.
 */
@Injectable({ providedIn: 'root' })
export class BundledLoader implements TranslocoLoader {
  getTranslation(lang: string) {
    return of(flatten(DICTIONARIES[lang as Lang] ?? DICTIONARIES.en) as Translation);
  }
}

/** Route titles are translation keys (`title: 'app.titles.clusters'`); shown as "Cluster · Kubernanny", again when the language changes. */
@Injectable({ providedIn: 'root' })
export class TranslatedTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  private readonly language = inject(LanguageService);
  private readonly key = signal<TranslationKey | null>(null);

  constructor() {
    super();
    effect(() => {
      const key = this.key();
      this.title.setTitle(key ? `${this.language.translator().t(key)} · Kubernanny` : 'Kubernanny');
    });
  }

  override updateTitle(snapshot: RouterStateSnapshot): void {
    this.key.set((this.buildTitle(snapshot) as TranslationKey | undefined) ?? null);
  }
}

export function provideI18n(): (Provider | EnvironmentProviders)[] {
  return [
    provideTransloco({
      config: { availableLangs: [...LANGS], defaultLang: 'en', fallbackLang: 'en', reRenderOnLangChange: true, prodMode: !isDevMode() },
      loader: BundledLoader,
    }),
    provideAppInitializer(() => followLanguage(null)),
    { provide: TitleStrategy, useClass: TranslatedTitleStrategy },
  ];
}

/**
 * Keeps Transloco on the LanguageService's language: the device's before the
 * first render, then on every change. Runs in an app initializer (injection
 * context). A stored choice is read without holding up the start: on the web
 * Preferences loads its implementation lazily, and waiting for it delayed the
 * router's first navigation (deep links like /#/demo arrived too late).
 */
function followLanguage(choice: Lang | null): void {
  const language = inject(LanguageService);
  const transloco = inject(TranslocoService);
  if (choice) {
    language.use(choice);
  } else {
    void language.init();
  }
  transloco.setActiveLang(language.lang());
  effect(() => {
    transloco.setActiveLang(language.lang());
    // Hyphenation (long German labels in narrow figures) follows the document's language.
    if (typeof document !== 'undefined') {
      document.documentElement.lang = language.lang();
    }
  });
}

/** For component tests: Transloco with the bundled texts, fixed to one language and not stored. */
export function provideI18nTesting(lang: Lang = 'de'): (Provider | EnvironmentProviders)[] {
  return [
    provideTransloco({ config: { availableLangs: [...LANGS], defaultLang: lang, reRenderOnLangChange: true, prodMode: true }, loader: BundledLoader }),
    provideAppInitializer(() => followLanguage(lang)),
  ];
}
