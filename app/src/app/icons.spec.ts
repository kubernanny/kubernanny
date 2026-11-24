import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('icons', () => {
  it('registers every icon the agent names, so no component shows a blank slot', () => {
    const root = process.cwd();
    const registered = readFileSync(join(root, 'src/app/core/icons.ts'), 'utf8');
    const modules = readdirSync(join(root, '../agent/src/modules'), { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'))
      .map((f) => `../agent/src/modules/${f}`);
    const named = ['../agent/src/discovery/catalog.ts', ...modules].flatMap((f) => [...readFileSync(join(root, f), 'utf8').matchAll(/icon(?::| =) '([a-z-]+)'/g)].map((m) => m[1]));
    const camel = (s: string) => s.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
    const missing = [...new Set(named)].filter((n) => !registered.includes(`  ${camel(n)},`));
    expect(named.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });
});
