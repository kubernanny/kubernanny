import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CATALOG } from './discovery/catalog';

describe('docs/COMPONENTS.md', () => {
  it('lists every recognised component, so the docs never lag behind the catalog', () => {
    const doc = readFileSync(join(__dirname, '../../docs/COMPONENTS.md'), 'utf8');
    const missing = CATALOG.filter((e) => !doc.includes(`| \`${e.id}\` |`)).map((e) => e.id);
    expect(missing).toEqual([]);
  });
});
