/** The languages of the UI. The agent answers in the same two (`Language` in @kubernanny/protocol). */
export type Lang = 'de' | 'en';
export const LANGS: readonly Lang[] = ['de', 'en'];

/** The BCP 47 locale for dates and numbers in each language. */
export const LOCALE: Record<Lang, string> = { de: 'de-DE', en: 'en-US' };

/** German for any `de*` locale, English for everything else. */
export function langFromLocale(locale: string | null | undefined): Lang {
  return locale?.toLowerCase().startsWith('de') ? 'de' : 'en';
}
