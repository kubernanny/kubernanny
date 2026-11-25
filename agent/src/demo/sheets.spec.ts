import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { de } from '../testing/i18n';
import { AppModule } from '../app.module';
import { KubeClient } from '../kube/kube-client';
import { StatusService } from '../status/status.service';
import { DemoKubeClient, DemoScenario } from './demo-cluster';

async function run(scenario: DemoScenario) {
  delete process.env.PULSE_TOKEN;
  process.env.CHECK_INTERVAL_SECONDS = '3600';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(KubeClient)
    .useValue(new DemoKubeClient(undefined, scenario))
    .compile();
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
      const crowded = s.modules.filter((m) => m.stats.length > 4).map((m) => `${m.id}: ${m.stats.map((x) => x.label).join(', ')}`);
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
