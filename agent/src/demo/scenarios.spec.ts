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

describe('demo scenarios', () => {
  it('healthy is green with no issue at all, so no check fires on a sound cluster', async () => {
    const s = await run('healthy');
    expect(s.issues.map((i) => i.title)).toEqual([]);
    expect(s.light).toBe('green');
    expect(s.score).toBe(100);
    expect(s.modules.filter((m) => m.status !== 'ok').map((m) => m.id)).toEqual([]);
  });

  it('warning is yellow with the three things that want attention, and a hint about a coming API removal', async () => {
    const s = await run('warning');
    expect(s.light).toBe('yellow');
    const removal = s.issues.find((i) => i.id.startsWith('kubernetes-support/deprecated-apis/'));
    expect(removal?.severity).toBe('info');
    expect(s.issues.map((i) => i.id).filter((id) => id !== removal?.id).sort()).toEqual(['argocd/argocd/weblate-chart/sync', 'certificates/weblate/weblate-tls', 'cnpg/default/shop-api-pg/backup']);
  });

  it('broken is red', async () => {
    expect((await run('broken')).light).toBe('red');
  });

  it('broken runs a CloudNativePG operator with a known advisory and a loosely configured pgadmin, without calling the internet', async () => {
    const s = await run('broken');
    const vuln = s.issues.find((i) => i.id === 'vulnerabilities/cnpg');
    expect(vuln).toMatchObject({ severity: 'warning', title: 'CloudNativePG 1.26.1: 1 bekannte Schwachstelle', advisories: ['GHSA-423p-g724-fr39'] });
    expect(s.modules.find((m) => m.id === 'cnpg')?.issueIds).toContain('vulnerabilities/cnpg');
    expect(s.issues.filter((i) => i.module === 'security').map((i) => [i.id, i.severity])).toEqual([
      ['security/pgadmin/root', 'info'],
      ['security/pgadmin/no-memory-limit', 'info'],
    ]);
  });

  it('broken runs Trivy Operator: a fixable high in the own-image app, an unfixed medium as a hint on Valkey', async () => {
    const s = await run('broken');
    expect(s.issues.filter((i) => i.module === 'trivy').map((i) => [i.id, i.severity, i.title, i.advisories])).toEqual([
      ['trivy/default/Deployment/social-importer', 'warning', 'social-importer (default): 1 bekannte Schwachstelle', ['CVE-2024-21538']],
      ['trivy/default/StatefulSet/shop-api-valkey', 'info', 'shop-api-valkey (default): 1 bekannte Schwachstelle', ['CVE-2023-42363']],
    ]);
    expect(s.modules.find((m) => m.id === 'redis')?.issueIds).toContain('trivy/default/StatefulSet/shop-api-valkey');
    const trivy = s.modules.find((m) => m.id === 'trivy')!;
    expect(trivy.stats.find((st) => st.label === 'Alte Berichte übergangen')?.value).toBe('1');
    expect(s.modules.find((m) => m.id === 'vulnerabilities')?.stats.find((st) => st.label === 'Jedes Image')?.value).toBe('Trivy Operator gefunden: jedes Image wird geprüft');
  });

  it('healthy and warning check vulnerabilities and security too, and find nothing', async () => {
    for (const scenario of ['healthy', 'warning'] as const) {
      const s = await run(scenario);
      expect(s.modules.filter((m) => m.id === 'vulnerabilities' || m.id === 'security').map((m) => [m.id, m.status])).toEqual([
        ['security', 'ok'],
        ['vulnerabilities', 'ok'],
      ]);
    }
  });
});
