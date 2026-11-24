import { localize } from '../i18n/text';

/** A value with its texts rendered in German: most specs assert the reviewed German copy. */
export const de = <T>(value: T) => localize(value, 'de');
/** The same in English. */
export const en = <T>(value: T) => localize(value, 'en');
