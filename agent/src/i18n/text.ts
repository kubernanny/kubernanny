/**
 * Texts the agent shows people, in English and German (docs/decisions/0006-agent-languages.md).
 *
 * Checks and modules never build a sentence themselves: they return a `Text`,
 * a message key with its parameters, and the language is chosen at the edge,
 * per request (`localize`), or from `LANGUAGE` for notifications. So one run
 * of the checks serves every language, and a missing translation is a
 * compile error, not a German sentence in an English app.
 */
import type { Language } from '@kubernanny/protocol';
import { de, type Messages } from './messages.de';
import { en } from './messages.en';

export type Lang = Language;
export const LANGS: readonly Lang[] = ['en', 'de'];
export const DEFAULT_LANG: Lang = 'en';

export const CATALOGS: Readonly<Record<Lang, Messages>> = { de, en };

export type MessageKey = keyof Messages;

/** A parameter: a value inserted as is, or a nested text (or a list of them) rendered in the same language first. */
export type Param = string | number | Text | undefined | readonly (string | Text)[];

/** A text in no language yet. `$t` marks it, so `localize` finds it anywhere inside a response. */
export interface Text {
  readonly $t: MessageKey;
  readonly p?: Readonly<Record<string, Param>>;
}

type ParamsOf<K extends MessageKey> = Messages[K] extends (p: infer P) => string ? P : never;
/** String parameters also take a nested Text (an age, a fallback sentence), lists a list of them; numbers stay numbers, for plural forms. */
type Accepts<P> = {
  [N in keyof P]: P[N] extends string | undefined ? P[N] | Text : P[N] extends string[] ? readonly (string | Text)[] : P[N];
};
type ArgsOf<K extends MessageKey> = Messages[K] extends string ? [] : [params: Accepts<ParamsOf<K>>];

/** `t('nodes.notReady.title', { node })`: the parameters are checked against the German catalog. */
export function t<K extends MessageKey>(key: K, ...args: ArgsOf<K>): Text {
  return args.length ? { $t: key, p: args[0] as Record<string, Param> } : { $t: key };
}

/** Text that is the same in every language: a message from the cluster, a name, an error from a library. */
export function raw(text: string): Text {
  return { $t: 'raw', p: { text } };
}

/** The cluster's own message when it gave one, else ours. */
export function rawOr(text: string | undefined | null, fallback: Text): Text {
  return text ? raw(text) : fallback;
}

export function isText(value: unknown): value is Text {
  return typeof value === 'object' && value !== null && typeof (value as { $t?: unknown }).$t === 'string';
}

export function render(text: Text, lang: Lang): string {
  const entry = (CATALOGS[lang] as unknown as Record<string, string | ((p: Record<string, unknown>) => string)>)[text.$t];
  if (entry === undefined) {
    // Unreachable for typed keys; a stale key from somewhere must not take the response down.
    return text.$t;
  }
  if (typeof entry === 'string') {
    return entry;
  }
  const params: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(text.p ?? {})) {
    params[name] = Array.isArray(value) ? value.map((v: string | Text) => (isText(v) ? render(v, lang) : v)) : isText(value) ? render(value, lang) : value;
  }
  return entry(params);
}

/** Replaces every Text inside a value (snapshot, view, error body) with its rendering. */
export type Localized<T> = T extends Text
  ? string
  : T extends readonly (infer U)[]
    ? Localized<U>[]
    : T extends Date | RegExp | Uint8Array
      ? T
      : T extends object
        ? { [K in keyof T]: Localized<T[K]> }
        : T;

export function localize<T>(value: T, lang: Lang): Localized<T> {
  return walk(value, lang) as Localized<T>;
}

function walk(value: unknown, lang: Lang): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => walk(v, lang));
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (isText(value)) {
    return render(value, lang);
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  if (proto !== Object.prototype && proto !== null) {
    return value; // Dates, buffers, class instances: not ours to rewrite
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = walk(v, lang);
  }
  return out;
}

/** A known language, else the fallback: the request field and the env var are both outside input. */
export function resolveLang(value: unknown, fallback: Lang = DEFAULT_LANG): Lang {
  return LANGS.includes(value as Lang) ? (value as Lang) : fallback;
}

/** An error whose message people see (a module that cannot run shows it): carries a Text, renders per request. */
export class TextError extends Error {
  constructor(readonly text: Text) {
    super(render(text, 'en'));
    this.name = 'TextError';
  }
}

/** What a caught error says, as a Text. */
export function errorText(err: unknown): Text {
  if (err instanceof TextError) {
    return err.text;
  }
  return raw(err instanceof Error ? err.message : String(err));
}
