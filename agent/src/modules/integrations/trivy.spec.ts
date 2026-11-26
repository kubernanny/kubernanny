import { describe, expect, it } from 'vitest';

import { DemoKubeClient } from '../../demo/demo-cluster';
import { DemoVulnDb } from '../../demo/demo-vulns';
import { CATALOG } from '../../discovery/catalog';
import { Detected } from '../../discovery/discovery';
import { emptyInventory, Inventory, Workload } from '../../inventory/inventory';
import { KubeClient } from '../../kube/kube-client';
import { de, en } from '../../testing/i18n';
import { ModuleContext } from '../types';
import { Acceptance, acceptanceKey, acceptComponentOfIssue, COMPONENT } from '../vulnerabilities/acceptance';
import {
  MAPPED_COMPONENTS,
  trivyHint,
  VulnerabilitiesCheck,
  vulnTargets,
} from '../vulnerabilities/vulnerabilities.check';
import { TrivyIntegration } from './trivy';
import {
  acceptTrivy,
  KEEP,
  keepTop,
  parseImage,
  sameImage,
  TrivyCollector,
  TrivyFinding,
  trivyIssue,
  TrivyVulnerability,
  VulnerabilityReport,
  workloadFindings,
  workloadIndex,
  workloadOf,
} from './trivy-reports';

const NOW = new Date('2026-11-24T12:00:00Z');
const H = 3_600_000;

const deployment = (ns: string, name: string, image: string, labels?: Record<string, string>): Workload => ({
  metadata: { name, namespace: ns },
  spec: { template: { metadata: { labels: labels ?? { app: name } }, spec: { containers: [{ name: 'app', image }] } } },
});

function inventory(...deployments: Workload[]): Inventory {
  const inv = emptyInventory(NOW);
  inv.deployments = deployments;
  return inv;
}

function report(
  name: string,
  opts: {
    kind?: string;
    ns?: string;
    container?: string;
    repo?: string;
    tag?: string;
    digest?: string;
    hoursAgo?: number;
    vulns?: TrivyVulnerability[];
  } = {},
): VulnerabilityReport {
  const vulns = opts.vulns ?? [];
  const count = (s: string) => vulns.filter((v) => v.severity === s).length;
  return {
    metadata: {
      name: `report-${name}`,
      namespace: opts.ns ?? 'apps',
      labels: {
        'trivy-operator.resource.kind': opts.kind ?? 'ReplicaSet',
        'trivy-operator.resource.name': opts.kind && opts.kind !== 'ReplicaSet' ? name : `${name}-7d9f8b6c5`,
        'trivy-operator.resource.namespace': opts.ns ?? 'apps',
        'trivy-operator.container.name': opts.container ?? 'app',
      },
    },
    report: {
      updateTimestamp: new Date(NOW.getTime() - (opts.hoursAgo ?? 2) * H).toISOString(),
      artifact: {
        repository: opts.repo ?? `acme/${name}`,
        tag: opts.tag ?? '1.0.0',
        ...(opts.digest ? { digest: opts.digest } : {}),
      },
      summary: {
        criticalCount: count('CRITICAL'),
        highCount: count('HIGH'),
        mediumCount: count('MEDIUM'),
        lowCount: count('LOW'),
        unknownCount: count('UNKNOWN'),
      },
      vulnerabilities: vulns,
    },
  };
}

const vuln = (id: string, severity: string, fixedVersion = '', score?: number): TrivyVulnerability => ({
  vulnerabilityID: id,
  severity,
  fixedVersion,
  resource: 'openssl',
  installedVersion: '3.0.1',
  ...(score !== undefined ? { score } : {}),
});

/** The issues of one workload, after collecting its reports. */
function issuesFor(
  inv: Inventory,
  reports: VulnerabilityReport[],
  accepted: ReadonlyMap<string, Acceptance> = new Map(),
) {
  const collector = new TrivyCollector(workloadIndex(inv), NOW);
  collector.add(reports);
  const { items } = acceptTrivy(
    [...collector.collected().workloads.values()].map((w) => workloadFindings(inv, w)),
    accepted,
  );
  return items.map((w) => trivyIssue(w, NOW)).filter((i) => i !== null);
}

/** The plain facts of a module's sheet (`keyFigures` moves everything past the four severities there). */
function facts<R>(result: { details?: ({ kind: 'list'; rows: R[] } | { kind: 'table' })[] }): R[] {
  return (result.details ?? []).flatMap((d) => (d.kind === 'list' ? d.rows : []));
}

describe('Trivy Operator reports', () => {
  it('belong to the workload Trivy names, a Deployment through its ReplicaSet', () => {
    const index = workloadIndex(inventory(deployment('apps', 'web', 'ghcr.io/acme/web:1.0.0')));
    const labels = (kind: string, name: string) => ({
      'trivy-operator.resource.kind': kind,
      'trivy-operator.resource.name': name,
      'trivy-operator.resource.namespace': 'apps',
    });
    expect(workloadOf(labels('ReplicaSet', 'web-7d9f8b6c5'), index)?.key).toBe('apps/Deployment/web');
    expect(workloadOf(labels('Deployment', 'web'), index)?.key).toBe('apps/Deployment/web');
    expect(workloadOf(labels('Pod', 'web-7d9f8b6c5-abcde'), index)).toBeNull();
    expect(workloadOf(labels('ReplicaSet', 'gone-7d9f8b6c5'), index)).toBeNull();
    expect(workloadOf(undefined, index)).toBeNull();
  });

  it('match the running image by repository and tag, or by digest where both have one', () => {
    expect(parseImage('nginx:1.29')).toEqual({ registry: 'index.docker.io', repository: 'library/nginx', tag: '1.29' });
    expect(parseImage('localhost:5000/team/app@sha256:abc')).toEqual({
      registry: 'localhost:5000',
      repository: 'team/app',
      digest: 'sha256:abc',
    });
    expect(sameImage('nginx:1.29', { repository: 'library/nginx', tag: '1.29' })).toBe(true);
    expect(sameImage('docker.io/valkey/valkey:8.1-alpine', { repository: 'valkey/valkey', tag: '8.1-alpine' })).toBe(
      true,
    );
    expect(sameImage('ghcr.io/acme/web:1.0.1', { repository: 'acme/web', tag: '1.0.0' })).toBe(false);
    expect(
      sameImage('ghcr.io/acme/web:1.0.0@sha256:new', { repository: 'acme/web', tag: '1.0.0', digest: 'sha256:old' }),
    ).toBe(false);
    expect(
      sameImage('ghcr.io/acme/web:1.0.0@sha256:same', { repository: 'acme/web', tag: '1.0.0', digest: 'sha256:same' }),
    ).toBe(true);
    expect(sameImage('ghcr.io/acme/other:1.0.0', { repository: 'acme/web', tag: '1.0.0' })).toBe(false);
  });

  it('skip reports older than 14 days, of an image no longer running, and older duplicates', () => {
    const inv = inventory(
      deployment('apps', 'web', 'ghcr.io/acme/web:1.0.0'),
      deployment('apps', 'api', 'ghcr.io/acme/api:2.0.0'),
    );
    const collector = new TrivyCollector(workloadIndex(inv), NOW);
    collector.add([
      report('web', { hoursAgo: 15 * 24 }),
      report('api', { tag: '1.9.0' }),
      report('web', { hoursAgo: 1 }),
      report('web', { hoursAgo: 3 }),
      report('job', { kind: 'Job' }),
    ]);
    const { workloads, stale, unmatched } = collector.collected();
    expect([...workloads.keys()]).toEqual(['apps/Deployment/web']);
    expect(workloads.get('apps/Deployment/web')!.containers.get('app')!.scannedAt).toBe(NOW.getTime() - H);
    expect(stale).toBe(3);
    expect(unmatched).toBe(1);
  });

  it('keep only the counts and the worst advisories in memory, plus the worst fixable ones', () => {
    const many: TrivyFinding[] = Array.from({ length: 500 }, (_, i) => ({
      id: `CVE-2026-${1000 + i}`,
      level: i < 30 ? 'critical' : 'low',
      fixed: null,
      pkg: 'x',
    }));
    many.push({ id: 'CVE-2026-0001', level: 'high', fixed: '1.2.3', pkg: 'x' });
    const kept = keepTop(many);
    expect(kept.length).toBe(KEEP + 1);
    expect(kept.map((f) => f.id)).toContain('CVE-2026-0001');
    const inv = inventory(deployment('apps', 'web', 'ghcr.io/acme/web:1.0.0'));
    const collector = new TrivyCollector(workloadIndex(inv), NOW);
    collector.add([
      report('web', { vulns: Array.from({ length: 2000 }, (_, i) => vuln(`CVE-2025-${10000 + i}`, 'LOW')) }),
    ]);
    const scan = collector.collected().workloads.get('apps/Deployment/web')!.containers.get('app')!;
    expect(scan.counts.low).toBe(2000);
    expect(scan.findings.length).toBe(KEEP);
  });
});

describe('severity of a scanned workload, by the built-in lookup rules', () => {
  const exposedInv = () => {
    const inv = inventory(deployment('apps', 'web', 'ghcr.io/acme/web:1.0.0'));
    inv.services = [
      { metadata: { name: 'web', namespace: 'apps' }, spec: { selector: { app: 'web' }, ports: [{ port: 80 }] } },
    ] as Inventory['services'];
    inv.ingresses = [
      {
        metadata: { name: 'web', namespace: 'apps' },
        spec: {
          rules: [
            { host: 'web.example', http: { paths: [{ backend: { service: { name: 'web', port: { number: 80 } } } }] } },
          ],
        },
      },
    ] as Inventory['ingresses'];
    return inv;
  };

  it('is critical only for a fixable critical advisory on a workload behind an ingress', () => {
    const fixableCritical = [report('web', { vulns: [vuln('CVE-2024-0001', 'CRITICAL', '3.0.2', 9.8)] })];
    expect(issuesFor(exposedInv(), fixableCritical).map((i) => i.severity)).toEqual(['critical']);
    expect(
      issuesFor(inventory(deployment('apps', 'web', 'ghcr.io/acme/web:1.0.0')), fixableCritical).map((i) => i.severity),
    ).toEqual(['warning']);
    expect(
      issuesFor(exposedInv(), [report('web', { vulns: [vuln('CVE-2024-0001', 'CRITICAL', '', 9.8)] })]).map(
        (i) => i.severity,
      ),
    ).toEqual(['info']);
  });

  it('warns for a fixable high and only hints at unfixed, medium and low', () => {
    const inv = exposedInv();
    expect(issuesFor(inv, [report('web', { vulns: [vuln('CVE-2024-0002', 'HIGH', '3.0.2')] })])[0].severity).toBe(
      'warning',
    );
    expect(
      issuesFor(inv, [
        report('web', {
          vulns: [
            vuln('CVE-2024-0002', 'HIGH'),
            vuln('CVE-2024-0003', 'MEDIUM', '1.1'),
            vuln('CVE-2024-0004', 'LOW', '1.1'),
          ],
        }),
      ])[0].severity,
    ).toBe('info');
    expect(issuesFor(inv, [report('web')])).toEqual([]);
  });

  it('names the worst ids, the count, the fixed package versions and the scan, in both languages', () => {
    const [issue] = issuesFor(exposedInv(), [
      report('web', { vulns: [vuln('CVE-2024-0002', 'HIGH', '3.0.2', 7.5), vuln('GHSA-aaaa-bbbb-cccc', 'MEDIUM')] }),
    ]);
    expect(issue).toMatchObject({
      id: 'trivy/apps/Deployment/web',
      check: 'trivy',
      actions: [],
      advisories: ['CVE-2024-0002', 'GHSA-aaaa-bbbb-cccc'],
    });
    expect(en(issue.title)).toBe('web (apps): 2 known vulnerabilities');
    expect(en(issue.cause)).toBe(
      'Most severe: CVE-2024-0002 (high, CVSS 7.5), GHSA-aaaa-bbbb-cccc (medium). Partly fixed in newer package versions: openssl 3.0.2; the others have no update yet. Scanned by Trivy Operator 2 h ago: acme/web:1.0.0.',
    );
    expect(de(issue.title)).toBe('web (apps): 2 bekannte Schwachstellen');
  });

  it('lets an accepted advisory stop counting on that workload only', () => {
    const inv = inventory(
      deployment('apps', 'web', 'ghcr.io/acme/web:1.0.0'),
      deployment('apps', 'api', 'ghcr.io/acme/api:1.0.0'),
    );
    const reports = [
      report('web', { vulns: [vuln('CVE-2024-0002', 'HIGH', '3.0.2')] }),
      report('api', { vulns: [vuln('CVE-2024-0002', 'HIGH', '3.0.2')] }),
    ];
    const accepted = new Map([
      [
        acceptanceKey('trivy:apps:deployment:web', 'CVE-2024-0002'),
        { until: NOW.getTime() + 1e9, at: NOW.getTime(), by: 'Phone' },
      ],
    ]);
    expect(issuesFor(inv, reports, accepted).map((i) => i.id)).toEqual(['trivy/apps/Deployment/api']);
  });

  it('derives the acceptance component from the issue id, within the allowed pattern', () => {
    expect(acceptComponentOfIssue('trivy/apps/Deployment/web')).toBe('trivy:apps:deployment:web');
    expect(acceptComponentOfIssue('vulnerabilities/cnpg')).toBe('cnpg');
    expect(acceptComponentOfIssue('pods/apps/Deployment/web')).toBeNull();
    expect(COMPONENT.test(`trivy:${'n'.repeat(63)}:statefulset:${'x'.repeat(253)}`)).toBe(true);
  });
});

/** Answers lists in pages of two, like an API server with `limit`. */
class PagingKube extends KubeClient {
  readonly pages: string[] = [];
  constructor(private readonly reports: VulnerabilityReport[]) {
    super();
  }
  override async listPage<T>(path: string): Promise<{ items: T[]; continue?: string } | null> {
    this.pages.push(path);
    if (path.includes('clustervulnerabilityreports')) {
      return null;
    }
    const from = Number(new URL(`http://x${path}`).searchParams.get('continue') ?? 0);
    const items = this.reports.slice(from, from + 2) as T[];
    return { items, ...(from + 2 < this.reports.length ? { continue: String(from + 2) } : {}) };
  }
}

describe('Trivy integration', () => {
  const ctx = (kube: KubeClient, inv: Inventory): ModuleContext => ({
    inv,
    kube,
    config: {} as ModuleContext['config'],
    now: NOW,
    prom: null,
    data: {},
  });

  it('reads only the report lists, page by page, and marks the workloads it covers', async () => {
    const inv = inventory(...['a', 'b', 'c', 'd', 'e'].map((n) => deployment('apps', n, `ghcr.io/acme/${n}:1.0.0`)));
    const kube = new PagingKube(
      ['a', 'b', 'c', 'd', 'e'].map((n) =>
        report(n, { vulns: n === 'c' ? [vuln('CVE-2024-0002', 'HIGH', '3.0.2')] : [] }),
      ),
    );
    const integration = new TrivyIntegration();
    expect(integration.reads.map((r) => `${r.group}/${r.resource}`)).toEqual([
      'aquasecurity.github.io/vulnerabilityreports',
      'aquasecurity.github.io/clustervulnerabilityreports',
    ]);
    const c = ctx(kube, inv);
    const result = en(await integration.run(c, {} as Detected, () => true));
    expect(kube.pages.filter((p) => p.includes('/vulnerabilityreports'))).toEqual([
      '/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports?limit=100',
      '/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports?limit=100&continue=2',
      '/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports?limit=100&continue=4',
    ]);
    expect(result.issues.map((i) => [i.id, i.severity])).toEqual([['trivy/apps/Deployment/c', 'warning']]);
    expect(result.summary).toBe('1 workload with known vulnerabilities');
    expect(c.data.trivy?.covered.size).toBe(5);
  });

  it('is not checkable when the report resource is missing', async () => {
    await expect(
      new TrivyIntegration().run(ctx(new PagingKube([]) as KubeClient, inventory()), {} as Detected, () => true),
    ).resolves.toBeDefined();
    const missing = new (class extends KubeClient {
      override async listPage<T>(): Promise<{ items: T[] } | null> {
        return null;
      }
    })();
    await expect(new TrivyIntegration().run(ctx(missing, inventory()), {} as Detected, () => true)).rejects.toThrow();
  });
});

describe('the built-in lookup next to Trivy Operator', () => {
  const cnpg = (): Detected => ({
    entry: CATALOG.find((e) => e.id === 'cnpg')!,
    namespace: 'cnpg-system',
    version: '1.26.1',
    image: 'ghcr.io/cloudnative-pg/cloudnative-pg:1.26.1',
    workloads: [
      { kind: 'Deployment', namespace: 'cnpg-system', name: 'cnpg-controller-manager', ready: 1, desired: 1 },
    ],
    services: [],
    links: [],
  });
  const check = new VulnerabilitiesCheck();
  const ctx = (data: ModuleContext['data'], detected: Detected[]): ModuleContext => {
    const inv = emptyInventory(NOW);
    inv.version = { gitVersion: 'v1.33.4+rke2r1' } as Inventory['version'];
    return {
      inv,
      kube: {} as ModuleContext['kube'],
      config: {} as ModuleContext['config'],
      now: NOW,
      prom: null,
      data,
      detected,
      vulnDb: new DemoVulnDb(),
    };
  };

  it('steps back for a component whose every workload Trivy scanned, so the advisories do not show twice', async () => {
    const covered = new Set(['cnpg-system/Deployment/cnpg-controller-manager']);
    expect(vulnTargets('v1.33.4', [cnpg()], covered)).toMatchObject({ covered: 1, targets: [{ key: 'kubernetes' }] });
    const partly = {
      ...cnpg(),
      workloads: [
        ...cnpg().workloads,
        { kind: 'Deployment' as const, namespace: 'cnpg-system', name: 'other', ready: 1, desired: 1 },
      ],
    };
    expect(vulnTargets('v1.33.4', [partly], covered).covered).toBe(0);

    const without = en(await check.run(ctx({}, [cnpg()]), () => true));
    expect(without.issues.map((i) => i.id)).toEqual(['vulnerabilities/cnpg']);
    const withTrivy = en(await check.run(ctx({ trivy: { covered } }, [cnpg()]), () => true));
    expect(withTrivy.issues).toEqual([]);
    expect(facts(withTrivy).find((r) => r.name === 'Left to Trivy Operator')?.value).toBe('1');
    expect(withTrivy.summary).toBe('No known vulnerabilities in 1 version, Trivy Operator covers every image');
  });

  it('says what it cannot see, and how Trivy Operator fills the gap', async () => {
    expect(MAPPED_COMPONENTS).toBe(13); // the module descriptions name the number
    const result = en(await check.run(ctx({}, [cnpg()]), () => true));
    expect(facts(result).slice(0, 2)).toEqual([
      { name: 'Compares', value: 'Kubernetes and 13 recognised components, not your own images', tone: 'muted' },
      {
        name: 'Every image',
        value: 'For every image, including your own: install Trivy Operator; Kubernanny reads its reports',
        tone: 'muted',
      },
    ]);
    expect(de(trivyHint(true, true)).value).toBe('Trivy Operator gefunden: jedes Image wird geprüft');
    expect(en(trivyHint(false, true)).value).toBe('Trivy Operator found, its check is switched off');
    for (const text of [de(trivyHint(false, false)).value, en(check.description)]) {
      expect(text).not.toMatch(/[–—]/);
    }
  });
});

describe('the demo cluster', () => {
  it('has Trivy Operator reports in the broken scenario only', async () => {
    expect(
      (await new DemoKubeClient(undefined, 'broken').list('/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports'))
        ?.length,
    ).toBe(3);
    expect(
      await new DemoKubeClient(undefined, 'healthy').list('/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports'),
    ).toBeNull();
  });
});
