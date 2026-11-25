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

/**
 * Every Text the agent made itself, and nothing else. A response from an
 * in-cluster service (Grafana, Prometheus, Alertmanager) is plain JSON, and
 * `{"$t": "valueOf"}` in it must stay data: `localize` would otherwise call
 * whatever the key names on the catalog. A WeakSet rather than a property,
 * so a Text still compares equal to `{ $t, p }` in tests and serializes as
 * before; objects parsed from JSON are never in it.
 */
const MADE = new WeakSet<object>();

function make(key: string, p?: Readonly<Record<string, Param>>): Text {
  const text = (p ? { $t: key, p } : { $t: key }) as Text;
  MADE.add(text);
  return text;
}

/** `t('nodes.notReady.title', { node })`: the parameters are checked against the German catalog. */
export function t<K extends MessageKey>(key: K, ...args: ArgsOf<K>): Text {
  return make(key, args.length ? (args[0] as Record<string, Param>) : undefined);
}

/** Text that is the same in every language: a message from the cluster, a name, an error from a library. */
export function raw(text: string): Text {
  return make('raw', { text: String(text) });
}

/** The cluster's own message when it gave one, else ours. */
export function rawOr(text: string | undefined | null, fallback: Text): Text {
  return text ? raw(text) : fallback;
}

/** True only for a Text made by `t`, `raw` or `reviveText`: a look-alike from outside input is data. */
export function isText(value: unknown): value is Text {
  return typeof value === 'object' && value !== null && MADE.has(value);
}

const KNOWN_KEYS = new Set(Object.keys(CATALOGS.de));

/**
 * A Text read back from the agent's own storage (the notified issues in the
 * ConfigMap): only a known key, with parameters that are strings, numbers or
 * revivable Texts themselves. Anything else is null.
 */
export function reviveText(value: unknown, depth = 0): Text | null {
  if (typeof value !== 'object' || value === null || depth > 4) {
    return null;
  }
  const { $t, p } = value as { $t?: unknown; p?: unknown };
  if (typeof $t !== 'string' || !KNOWN_KEYS.has($t)) {
    return null;
  }
  if (p === undefined) {
    return make($t);
  }
  if (typeof p !== 'object' || p === null || Array.isArray(p)) {
    return null;
  }
  const params: Record<string, Param> = {};
  for (const [name, v] of Object.entries(p)) {
    const one = (x: unknown): string | number | Text | null =>
      typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)) ? x : reviveText(x, depth + 1);
    if (Array.isArray(v)) {
      const items = v.slice(0, 50).map(one);
      if (items.some((x) => x === null || typeof x === 'number')) {
        return null;
      }
      params[name] = items as (string | Text)[];
    } else if (v !== undefined && v !== null) {
      const x = one(v);
      if (x === null) {
        return null;
      }
      params[name] = x;
    }
  }
  return make($t, params);
}

type Entry = string | ((p: Record<string, unknown>) => string);

/** A parameter as the catalog may see it: a primitive, or a short JSON rendering of anything else (outside input that slipped through). */
function plainParam(value: unknown): unknown {
  if (value === undefined || typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  try {
    return (JSON.stringify(value) ?? '').slice(0, 200);
  } catch {
    return '';
  }
}

export function render(text: Text, lang: Lang): string {
  const catalog = CATALOGS[lang] as unknown as Record<string, Entry>;
  // Own keys only: `valueOf`, `constructor` and friends are not messages.
  const entry = typeof text.$t === 'string' && Object.hasOwn(catalog, text.$t) ? catalog[text.$t] : undefined;
  if (entry === undefined) {
    // Unreachable for typed keys; a stale key from somewhere must not take the response down.
    return String(text.$t);
  }
  if (typeof entry === 'string') {
    return entry;
  }
  const params: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(text.p ?? {})) {
    params[name] = Array.isArray(value)
      ? value.map((v: unknown) => (isText(v) ? render(v, lang) : plainParam(v)))
      : isText(value)
        ? render(value, lang)
        : plainParam(value);
  }
  try {
    return entry(params);
  } catch {
    // A parameter of the wrong shape: the key is better than a failed response or a crashed run.
    return text.$t;
  }
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
