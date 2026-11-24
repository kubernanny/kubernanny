// npm run test:scripts (node:test, no Angular needed)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextVersion } from './release.mjs';

test('bumps patch, minor and major', () => {
  assert.equal(nextVersion('1.4.2', 'patch'), '1.4.3');
  assert.equal(nextVersion('1.4.2', 'minor'), '1.5.0');
  assert.equal(nextVersion('1.4.2', 'major'), '2.0.0');
});

test('takes an exact version as it is', () => {
  assert.equal(nextVersion('0.0.0', '1.0.0'), '1.0.0');
});

test('refuses anything else', () => {
  assert.throws(() => nextVersion('1.0.0', 'next'), /Unknown bump/);
});
