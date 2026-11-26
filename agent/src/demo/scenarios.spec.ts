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

describe('demo scenarios', () => {
  it('healthy is green with no issue at all, so no check fires on a sound cluster', async () => {
    const s = await run('healthy');
    expect(s.issues.map((i) => i.title)).toEqual([]);
    expect(s.light).toBe('green');
    expect(s.score).toBe(100);
    expect(s.modules.filter((m) => m.status !== 'ok').map((m) => m.id)).toEqual([]);
    // Changes waiting in Git for a manual sync are routine: listed as ready to sync, not as issues.
    expect(s.modules.find((m) => m.id === 'argocd')?.pendingSyncs?.length).toBe(2);
  });

  it('warning is yellow with the things that want attention, a hint about a coming API removal, and two apps ready to sync that are no issue', async () => {
    const s = await run('warning');
    expect(s.light).toBe('yellow');
    const removal = s.issues.find((i) => i.id.startsWith('kubernetes-support/deprecated-apis/'));
    expect(removal?.severity).toBe('info');
    const argo = s.modules.find((m) => m.id === 'argocd');
    expect(argo?.pendingSyncs?.map((p) => p.app)).toEqual(['weblate-chart', 'kubernanny-chart']);
    expect(
      s.issues
        .map((i) => i.id)
        .filter((id) => id !== removal?.id)
        .sort(),
    ).toEqual([
      'certificates/weblate/weblate-tls',
      'cnpg/default/shop-api-pg/backup',
      'standard-alerts/cpu-throttled/default/Cluster/shop-api-pg',
      'standard-alerts/etcd-peer-rtt/rke2-node-1/rke2-node-5',
    ]);
    expect(s.issues.find((i) => i.id.startsWith('standard-alerts/'))?.title).toBe(
      'etcd rke2-node-1 → rke2-node-5: Netzwerk-Laufzeit 243 ms',
    );
    // A database at its CPU limit: a hint with the fix and the line to accept it, never a warning.
    const throttled = s.issues.find((i) => i.id.startsWith('standard-alerts/cpu-throttled/'));
    expect([throttled?.severity, throttled?.title]).toEqual([
      'info',
      'default/shop-api-pg wird gedrosselt: 40 % der Zeit am CPU-Limit von 1 Kern',
    ]);
    expect(throttled?.cause).toMatch(/^Der Kernel hält den Container postgres in 40 % seiner CPU-Perioden/);
    expect(throttled?.cause).toMatch(
      /Bewusst so\? Am Workload die Annotation kubernanny\.io\/accept: "cpu-throttled: <Grund>" setzen\.$/,
    );
  });

  it('broken shows the slow etcd link once: the built-in issue, saying Alertmanager fires it too', async () => {
    const s = await run('broken');
    const rtt = s.issues.find((i) => i.id === 'standard-alerts/etcd-peer-rtt/rke2-node-1/rke2-node-5');
    expect(rtt?.severity).toBe('warning');
    expect(rtt?.cause).toMatch(/Alertmanager meldet das ebenfalls \(etcdMemberCommunicationSlow\)\.$/);
    expect(s.issues.map((i) => i.id)).not.toContain('alertmanager/etcdMemberCommunicationSlow');
    expect(s.modules.find((m) => m.id === 'alertmanager')?.issueIds).toEqual([
      'alertmanager/BlackboxProbeFailed',
      'alertmanager/KubePersistentVolumeFillingUp',
    ]);
    expect(s.issues.find((i) => i.id === 'standard-alerts/dns-errors/coredns')?.severity).toBe('critical');
  });

  it('broken is red', async () => {
    expect((await run('broken')).light).toBe('red');
  });

  it('broken runs a CloudNativePG operator with a known advisory and a loosely configured pgadmin, without calling the internet', async () => {
    const s = await run('broken');
    const vuln = s.issues.find((i) => i.id === 'vulnerabilities/cnpg');
    expect(vuln).toMatchObject({
      severity: 'warning',
      title: 'CloudNativePG 1.26.1: 1 bekannte Schwachstelle',
      advisories: ['GHSA-423p-g724-fr39'],
    });
    expect(s.modules.find((m) => m.id === 'cnpg')?.issueIds).toContain('vulnerabilities/cnpg');
    expect(s.issues.filter((i) => i.module === 'security').map((i) => [i.id, i.severity])).toEqual([
      ['security/pgadmin/root', 'info'],
      ['security/pgadmin/no-memory-limit', 'info'],
    ]);
    // Discourse runs as root too, and accepts it in its kubernanny.io/accept annotation.
    expect(s.modules.find((m) => m.id === 'security')?.acceptedFindings).toEqual([
      {
        key: 'root',
        finding: 'läuft womöglich als root',
        namespace: 'discourse',
        kind: 'Deployment',
        name: 'discourse',
        reason: 'the image boots runit as root and drops privileges itself',
        source: 'workload',
      },
    ]);
  });

  it('broken runs Trivy Operator: a fixable high in the own-image app, an unfixed medium as a hint on Valkey', async () => {
    const s = await run('broken');
    expect(s.issues.filter((i) => i.module === 'trivy').map((i) => [i.id, i.severity, i.title, i.advisories])).toEqual([
      [
        'trivy/default/Deployment/social-importer',
        'warning',
        'social-importer (default): 1 bekannte Schwachstelle',
        ['CVE-2024-21538'],
      ],
      [
        'trivy/default/StatefulSet/shop-api-valkey',
        'info',
        'shop-api-valkey (default): 1 bekannte Schwachstelle',
        ['CVE-2023-42363'],
      ],
    ]);
    expect(s.modules.find((m) => m.id === 'redis')?.issueIds).toContain('trivy/default/StatefulSet/shop-api-valkey');
    const trivy = s.modules.find((m) => m.id === 'trivy')!;
    // Beyond the four severities, the facts sit in a list on the sheet.
    const fact = (id: string, label: string) =>
      s.modules
        .find((m) => m.id === id)
        ?.details?.flatMap((d) => (d.kind === 'list' ? d.rows : []))
        .find((r) => r.name === label)?.value;
    expect(trivy.stats.map((st) => st.label)).toEqual(['Kritisch', 'Hoch', 'Mittel', 'Niedrig oder ohne Einstufung']);
    expect(fact('trivy', 'Alte Berichte übergangen')).toBe('1');
    expect(fact('vulnerabilities', 'Jedes Image')).toBe('Trivy Operator gefunden: jedes Image wird geprüft');
  });

  it('healthy and warning check vulnerabilities and security too, and find nothing', async () => {
    for (const scenario of ['healthy', 'warning'] as const) {
      const s = await run(scenario);
      expect(
        s.modules.filter((m) => m.id === 'vulnerabilities' || m.id === 'security').map((m) => [m.id, m.status]),
      ).toEqual([
        ['security', 'ok'],
        ['vulnerabilities', 'ok'],
      ]);
    }
  });
});
