import { describe, expect, it } from 'vitest';

import { Agent } from '../agent';
import { StatusService } from '../status/status.service';
import { de } from '../testing/i18n';
import { DemoKubeClient, DemoScenario } from './demo-cluster';

async function run(scenario: DemoScenario) {
  process.env.CHECK_INTERVAL_SECONDS = '3600';
  const moduleRef = new Agent({ kube: new DemoKubeClient(undefined, scenario) });
  const status = moduleRef.get(StatusService);
  await status.refresh();
  const snapshot = de(status.snapshot());
  await moduleRef.close();
  return snapshot;
}

/** Module sheets: a row of two to four key figures, and the objects as lists below (docs/DESIGN.md, "Module sheets"). */
describe('module sheets of the demo clusters', () => {
  for (const scenario of ['broken', 'warning', 'healthy'] as const) {
    it(`${scenario}: no module has more than four key figures, and lists come as details`, async () => {
      const s = await run(scenario);
      const crowded = s.modules
        .filter((m) => m.stats.length > 4)
        .map((m) => `${m.id}: ${m.stats.map((x) => x.label).join(', ')}`);
      expect(crowded).toEqual([]);
      for (const m of s.modules) {
        for (const d of m.details ?? []) {
          expect(d.rows.length, `${m.id} ${d.title}`).toBeGreaterThan(0);
        }
      }
    });
  }

  it('broken: CloudNativePG lists every cluster with its primary instead of a tile per cluster', async () => {
    const s = await run('broken');
    const cnpg = s.modules.find((m) => m.id === 'cnpg')!;
    expect(cnpg.stats.every((x) => !String(x.value).includes('Primary'))).toBe(true);
    const list = cnpg.details?.find((d) => d.kind === 'list');
    expect(list?.title).toBe('Datenbank-Cluster');
    expect(list?.kind === 'list' && list.rows[0]!.sub).toMatch(/^Primary /);
    // problems first
    expect(list?.kind === 'list' && list.rows[0]!.tone).not.toBe('ok');
  });
});
