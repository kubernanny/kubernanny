import { de } from './de';

/** The shape every language has: de.ts with every text a string. */
export type Dictionary = DeepStrings<typeof de>;
type DeepStrings<T> = { [K in keyof T]: T[K] extends string ? string : DeepStrings<T[K]> };

interface Plural {
  one: string;
  other: string;
}

/** Every key that names a single text, e.g. `cluster.tabs.nodes`. */
export type TranslationKey = Leaves<Dictionary>;
type Leaves<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : T[K] extends Plural ? never : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Every key that names a pair picked by count, e.g. `cluster.subline.nodes`. */
export type PluralKey = Plurals<Dictionary>;
type Plurals<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? never : T[K] extends Plural ? `${P}${K}` : Plurals<T[K], `${P}${K}.`>;
}[keyof T & string];

/** Nested texts as `{ 'a.b': text }`, the way Transloco and the tests see them. */
export function flatten(tree: object, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string') {
      out[prefix + key] = value;
    } else {
      Object.assign(out, flatten(value as object, `${prefix}${key}.`));
    }
  }
  return out;
}
