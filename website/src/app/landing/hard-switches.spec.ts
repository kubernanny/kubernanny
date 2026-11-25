import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { HARD_SWITCHES } from './hard-switches';

const values = load(readFileSync(join(__dirname, '../../../../deploy/helm/kubernanny/values.yaml'), 'utf8')) as Record<string, unknown>;
const at = (path: string): unknown => path.split('.').reduce<unknown>((v, key) => (v as Record<string, unknown> | undefined)?.[key], values);

describe('hard switches on the landing page', () => {
  it.each(HARD_SWITCHES.map((s) => [s.setting, s] as const))('%s exists in the chart with the stated default', (_, s) => {
    const value = at(s.value);
    expect(value, `${s.value} in values.yaml`).not.toBeUndefined();
    if (s.default === null) {
      expect(Array.isArray(value)).toBe(true);
    } else if (Array.isArray(s.default)) {
      // An opt-in list: empty unless the person adds to it.
      expect(value).toEqual(s.default);
    } else {
      expect(value).toBe(s.default);
    }
  });
});
