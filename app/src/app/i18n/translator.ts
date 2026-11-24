import { de } from './de';
import { Dictionary, PluralKey, TranslationKey, flatten } from './dictionary';
import { en } from './en';
import { LOCALE, Lang } from './lang';

export const DICTIONARIES: Record<Lang, Dictionary> = { de, en };

export type Params = Record<string, string | number>;

/**
 * Texts in one language, for code outside templates: view-model builders,
 * toasts, alerts, error messages. A plain value, so the builders stay pure
 * and tests pass `translatorFor('de')` without Angular.
 */
export interface Translator {
  readonly lang: Lang;
  /** For Intl: "de-DE" or "en-US". */
  readonly locale: string;
  t(key: TranslationKey, params?: Params): string;
  /** The `one` or `other` form by count, with `{{count}}` filled in. */
  n(key: PluralKey, count: number, params?: Params): string;
}

/** Same placeholder syntax as Transloco (`{{ name }}`), so one text works in templates and in code. */
export function interpolate(text: string, params?: Params): string {
  return params ? text.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, name: string) => (name in params ? String(params[name]) : all)) : text;
}

const cache = new Map<Lang, Translator>();

export function translatorFor(lang: Lang): Translator {
  let translator = cache.get(lang);
  if (!translator) {
    const texts = flatten(DICTIONARIES[lang]);
    const rules = new Intl.PluralRules(LOCALE[lang]);
    translator = {
      lang,
      locale: LOCALE[lang],
      t: (key, params) => interpolate(texts[key] ?? key, params),
      n: (key, count, params) => interpolate(texts[`${key}.${rules.select(count) === 'one' ? 'one' : 'other'}`] ?? key, { ...params, count }),
    };
    cache.set(lang, translator);
  }
  return translator;
}
