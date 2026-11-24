import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { de } from './de';
import { flatten } from './dictionary';
import { en } from './en';
import { langFromLocale } from './lang';
import { interpolate, translatorFor } from './translator';

const flatDe = flatten(de);
const flatEn = flatten(en);
const placeholders = (text: string) => [...text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]).sort();

/** Every .ts and .html file under src/app, without the specs. */
function sources(dir = join(process.cwd(), 'src/app')): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return sources(path);
    }
    return /\.(ts|html)$/.test(name) && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('translations', () => {
  it('have exactly the same keys in both languages', () => {
    expect(Object.keys(flatEn).sort()).toEqual(Object.keys(flatDe).sort());
  });

  it('have the same placeholders in both languages', () => {
    const differing = Object.keys(flatDe).filter((key) => placeholders(flatDe[key]).join() !== placeholders(flatEn[key] ?? '').join());
    expect(differing).toEqual([]);
  });

  it('have no empty text and no em or en dash in the copy', () => {
    const bad = Object.entries({ ...prefixed('de', flatDe), ...prefixed('en', flatEn) }).filter(([, text]) => !text.trim() || /[–—]/.test(text));
    expect(bad).toEqual([]);
  });

  it('cover every key the templates and the code ask for', () => {
    const used = new Set<string>();
    for (const file of sources()) {
      const text = readFileSync(file, 'utf8');
      // t('a.b') in templates and tr.t('a.b') / tr.n('a.b', n) in code; keys passed around as values are typed TranslationKey.
      for (const m of text.matchAll(/\b[tn]\(\s*'([a-zA-Z0-9_.]+)'/g)) {
        used.add(m[1]);
      }
      for (const m of text.matchAll(/'((?:app|common|language|clusters|cluster|categories|status|actions|overview|services|nodes|workloads|storage|network|events|issues|logs|module|chart|pair|form|modules|errors|demo)\.[a-zA-Z0-9_.]+)'/g)) {
        used.add(m[1]);
      }
    }
    const known = (key: string) => key in flatDe || (`${key}.one` in flatDe && `${key}.other` in flatDe);
    expect([...used].filter((key) => !known(key))).toEqual([]);
    expect(used.size).toBeGreaterThan(200);
  });
});

describe('translator', () => {
  it('fills in parameters like Transloco does', () => {
    expect(interpolate('Agent {{agent}} ist älter als {{ app }}', { agent: '0.2.0', app: '0.3.0' })).toBe('Agent 0.2.0 ist älter als 0.3.0');
    expect(interpolate('{{missing}} bleibt', {})).toBe('{{missing}} bleibt');
  });

  it('picks the plural form by count', () => {
    expect(translatorFor('de').n('cluster.subline.nodes', 1)).toBe('1 Node');
    expect(translatorFor('de').n('cluster.subline.nodes', 3)).toBe('3 Nodes');
    expect(translatorFor('en').n('workloads.restarts', 1)).toBe('1 restart');
    expect(translatorFor('en').n('workloads.restarts', 0)).toBe('0 restarts');
  });

  it('follows the device: German for de*, English otherwise', () => {
    expect(langFromLocale('de-AT')).toBe('de');
    expect(langFromLocale('DE')).toBe('de');
    expect(langFromLocale('en-GB')).toBe('en');
    expect(langFromLocale('fr-FR')).toBe('en');
    expect(langFromLocale(undefined)).toBe('en');
  });
});

function prefixed(lang: string, texts: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(texts).map(([k, v]) => [`${lang}:${k}`, v]));
}
