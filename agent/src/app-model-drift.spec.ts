import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'vitest';

const root = join(__dirname, '..');

describe("the app's copy of the agent types (app/src/app/core/agent.model.ts)", () => {
  it('still reads what the agent sends: drift/app-model.ts compiles', () => {
    try {
      execFileSync(join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.drift.json'], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      const { stdout, stderr } = err as { stdout?: string; stderr?: string };
      throw new Error(`agent.model.ts drifted from the agent's types:\n${stdout ?? ''}${stderr ?? ''}`);
    }
  }, 60_000);
});
