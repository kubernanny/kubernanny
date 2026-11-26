import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseLanguage } from '../config';
import { CATALOGS, errorText, Lang, LANGS, localize, raw, render, resolveLang, t, TextError } from './text';

type Entry = string | ((p: Record<string, unknown>) => string);
const catalog = (lang: Lang) => CATALOGS[lang] as unknown as Record<string, Entry>;

/**
 * Calls an entry with parameters that record which names it reads. Each value
 * passes as a string, a number (`one` decides whether it reads as 1 or 2, so
 * both plural branches run) and a list, which is all the catalogs ask of one.
 */
function probe(entry: Entry, one: boolean): { text: string; read: Set<string> } {
  if (typeof entry === 'string') {
    return { text: entry, read: new Set() };
  }
  const read = new Set<string>();
  const value = (name: string) => ({
    [Symbol.toPrimitive]: (hint: string) => (hint === 'number' ? (one ? 1 : 2) : `{${name}}`),
    toFixed: () => `{${name}}`,
    toLocaleString: () => `{${name}}`,
    join: () => `{${name}}`,
  });
  const params = new Proxy({} as Record<string, unknown>, {
    get: (_, name) => {
      read.add(String(name));
      return value(String(name));
    },
  });
  return { text: String(entry(params)), read };
}

describe('message catalogs', () => {
  it('have exactly the same keys in every language (the compiler checks this too)', () => {
    const keys = Object.keys(catalog('de')).sort();
    for (const lang of LANGS) {
      expect(Object.keys(catalog(lang)).sort(), lang).toEqual(keys);
    }
  });

  it('read the same placeholders in every language, and are plain strings or functions alike', () => {
    for (const key of Object.keys(catalog('de'))) {
      const reference = catalog('de')[key]!;
      for (const lang of LANGS) {
        const entry = catalog(lang)[key]!;
        expect(typeof entry, `${lang} ${key}`).toBe(typeof reference);
        const read = (e: Entry) => [...new Set([...probe(e, true).read, ...probe(e, false).read])].sort();
        expect(read(entry), `${lang} ${key}`).toEqual(read(reference));
      }
    }
  });

  it('never renders an empty text or an em or en dash', () => {
    for (const lang of LANGS) {
      for (const [key, entry] of Object.entries(catalog(lang))) {
        for (const one of [true, false]) {
          const { text } = probe(entry, one);
          if (key !== 'raw' && key !== 'common.sentences') {
            expect(text.trim(), `${lang} ${key}`).not.toBe('');
          }
          expect(text, `${lang} ${key}`).not.toMatch(/[–—]/);
        }
      }
    }
    for (const file of ['messages.de.ts', 'messages.en.ts', 'components.de.ts', 'components.en.ts']) {
      expect(readFileSync(join(__dirname, file), 'utf8'), file).not.toMatch(/[–—]/);
    }
  });
});

/** Keys built at run time from an id: `t(\`action.${type}.label\`)` and the like. */
const DYNAMIC_KEYS = [
  /^action\.[a-z-]+\.(label|description|effect)$/,
  /^security\.[a-z-]+\.(title|why|fix|short)$/,
  /^error\.[A-Z_]+$/,
];

describe('catalog keys in use', () => {
  it('names every key somewhere in the agent, so a text nobody shows cannot pile up', () => {
    const src = join(__dirname, '..');
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
      );
    const catalogFile = /i18n\/(messages|components|standard-alerts)\.[a-z]+\.ts$/;
    const code = walk(src)
      .filter((f) => !catalogFile.test(f) && !f.endsWith('.spec.ts'))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const unused = Object.keys(catalog('en')).filter(
      (key) =>
        key !== 'raw' &&
        !DYNAMIC_KEYS.some((re) => re.test(key)) &&
        !code.includes(`'${key}'`) &&
        !code.includes(`"${key}"`) &&
        !code.includes(`\`${key}\``),
    );
    expect(unused).toEqual([]);
  });
});

describe('rendering', () => {
  it('renders nested texts and lists of texts in the same language', () => {
    const age = t('age.days', { n: 3 });
    expect(render(t('cnpg.oldBackup.title', { cluster: 'db/pg', age }), 'de')).toBe(
      'Letztes Backup von db/pg vor 3 Tagen',
    );
    expect(render(t('cnpg.oldBackup.title', { cluster: 'db/pg', age }), 'en')).toBe(
      'Last backup of db/pg was 3 days ago',
    );
    const parts = [t('vulnerabilities.noFix'), raw('x.')];
    expect(render(t('common.sentences', { parts }), 'en')).toBe('No update that fixes them is known yet. x.');
  });

  it('localizes every text inside a response and leaves everything else alone', () => {
    const at = new Date(0);
    const body = { id: 'a/b', count: 2, at, nested: [{ title: t('ready.summary.ok'), list: [raw('n1')] }], none: null };
    expect(localize(body, 'en')).toEqual({
      id: 'a/b',
      count: 2,
      at,
      nested: [{ title: 'All ready', list: ['n1'] }],
      none: null,
    });
    expect(localize(body, 'de').nested[0]!.title).toBe('Alles bereit');
    expect(localize('plain', 'de')).toBe('plain');
  });

  it('keeps a library error as it is and renders its own errors per language', () => {
    expect(errorText(new Error('ECONNREFUSED'))).toEqual(raw('ECONNREFUSED'));
    const err = new TextError(t('vulnerabilities.noDatabase'));
    expect(err.message).toBe('no vulnerability database configured');
    expect(render(errorText(err), 'de')).toBe('keine Schwachstellen-Datenbank eingerichtet');
  });
});

describe('choosing the language', () => {
  it('takes a known language and falls back for anything else', () => {
    expect(resolveLang('de')).toBe('de');
    expect(resolveLang('fr')).toBe('en');
    expect(resolveLang(['de'])).toBe('en');
    expect(resolveLang(undefined, 'de')).toBe('de');
  });

  it('reads LANGUAGE, also in the glibc list form, and never refuses to start over it', () => {
    expect(parseLanguage(undefined)).toBe('en');
    expect(parseLanguage('de')).toBe('de');
    expect(parseLanguage('DE')).toBe('de');
    expect(parseLanguage('de_DE:en')).toBe('de');
    expect(parseLanguage('en_US.UTF-8')).toBe('en');
    expect(parseLanguage('fr')).toBe('en');
    expect(parseLanguage('')).toBe('en');
  });
});
