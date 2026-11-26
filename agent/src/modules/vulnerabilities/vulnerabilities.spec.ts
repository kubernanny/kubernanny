import { describe, expect, it } from 'vitest';

import { affects, DemoVulnDb } from '../../demo/demo-vulns';
import { CATALOG } from '../../discovery/catalog';
import { Detected } from '../../discovery/discovery';
import { emptyInventory } from '../../inventory/inventory';
import { de, en } from '../../testing/i18n';
import { ModuleContext } from '../types';
import { cvss3Score } from './cvss';
import { Finding, findingsFor, fixedVersion, issueSeverity, levelOf, vulnerabilityIssue } from './evaluate';
import { OSV_BACKOFF_MS, OSV_TTL_MS, OsvClient, OsvVuln, sanitize } from './osv-client';
import { compareVersions, isPseudoVersion, osvPackageFor, releaseVersion } from './versions';
import { VulnerabilitiesCheck, vulnTargets } from './vulnerabilities.check';

const NOW = new Date('2026-11-24T12:00:00Z');
const CNPG = { ecosystem: 'Go', name: 'github.com/cloudnative-pg/cloudnative-pg' };

describe('version normalisation', () => {
  it.each([
    ['v1.33.4+rke2r1', '1.33.4'],
    ['v1.31.2+k3s1', '1.31.2'],
    ['v1.30.4-eks-a737599', '1.30.4'],
    ['v1.12.0-build20250218', '1.12.0'],
    ['8.1-alpine', '8.1.0'],
    ['3.1.2', '3.1.2'],
    ['latest', null],
    ['2026-11-24-412', null],
    ['17-3.5', null],
    ['2024.10.15', null],
    ['2024.10', null],
    ['v2025.1.3-alpine', null],
    [undefined, null],
  ])('%s -> %s', (tag, expected) => {
    expect(releaseVersion(tag)).toBe(expected);
  });

  it('takes calendar tags as releases only for projects that use calendar versions', () => {
    expect(releaseVersion('2024.10.15', { calver: true })).toBe('2024.10.15');
    expect(releaseVersion('2024.10', { calver: true })).toBe('2024.10.0');
    expect(releaseVersion('1999.1', {})).toBeNull();
    expect(releaseVersion('100.2.3')).toBe('100.2.3');
  });

  it('orders releases and prereleases like semver', () => {
    expect(compareVersions('1.28.3', '1.28.10')).toBe(-1);
    expect(compareVersions('3.6.0-rc1', '3.6.0')).toBe(-1);
    expect(compareVersions('3.6.0-rc2', '3.6.0-rc10')).toBe(1); // string identifiers compare as strings, as in semver
    expect(compareVersions('1.33.0-alpha.0', '1.33.0-alpha.1')).toBe(-1);
    expect(compareVersions('0', '0.0.1')).toBe(-1);
    expect(compareVersions('v1.2.3+meta', '1.2.3')).toBe(0);
  });

  it('recognises Go pseudo-versions, which name commits rather than releases', () => {
    expect(isPseudoVersion('1.9.2-0.20260616075434-82ef13993059')).toBe(true);
    expect(isPseudoVersion('1.28.3')).toBe(false);
  });

  it('maps catalog entries to OSV packages, with the Go major version in the path', () => {
    const argo = CATALOG.find((e) => e.id === 'argocd')!.osv!;
    expect(osvPackageFor(argo, '3.1.2')).toEqual({ ecosystem: 'Go', name: 'github.com/argoproj/argo-cd/v3' });
    expect(osvPackageFor(argo, '2.11.3')).toEqual({ ecosystem: 'Go', name: 'github.com/argoproj/argo-cd/v2' });
    expect(osvPackageFor(argo, '1.8.7')).toEqual({ ecosystem: 'Go', name: 'github.com/argoproj/argo-cd' });
    const traefik = CATALOG.find((e) => e.id === 'traefik')!.osv!;
    expect(osvPackageFor(traefik, '1.7.34')).toBeNull();
    const gitea = CATALOG.find((e) => e.id === 'gitea')!.osv!;
    expect(osvPackageFor(gitea, '1.24.0', 'docker.io/gitea/gitea:1.24.0')).toEqual({
      ecosystem: 'Go',
      name: 'code.gitea.io/gitea',
    });
    // Forgejo is the same catalog entry, but its versions are not Gitea's.
    expect(osvPackageFor(gitea, '11.0.0', 'codeberg.org/forgejo/forgejo:11.0.0')).toBeNull();
  });
});

describe('CVSS', () => {
  it.each([
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 9.8],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H', 10],
    ['CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H', 9.9],
    ['CVSS:3.1/AV:N/AC:H/PR:H/UI:N/S:C/C:H/I:N/A:N', 5.8],
    ['CVSS:3.0/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', 5.5],
    ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N', 0],
  ])('%s = %s', (vector, score) => {
    expect(cvss3Score(vector)).toBe(score);
  });

  it('does not score v4 or broken vectors', () => {
    expect(cvss3Score('CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N')).toBeNull();
    expect(cvss3Score('CVSS:3.1/AV:X/AC:L')).toBeNull();
  });

  it('never reads inherited properties as metric values (null, not NaN)', () => {
    for (const value of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(cvss3Score(`CVSS:3.1/AV:${value}/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H`)).toBeNull();
      expect(cvss3Score(`CVSS:3.1/AV:N/AC:L/PR:${value}/UI:N/S:U/C:H/I:H/A:H`)).toBeNull();
      expect(cvss3Score(`CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:${value}/I:H/A:H`)).toBeNull();
    }
  });

  it('falls back to the database label without a v3 vector', () => {
    expect(
      levelOf({
        id: 'a',
        severity: [{ type: 'CVSS_V4', score: 'CVSS:4.0/…' }],
        database_specific: { severity: 'HIGH' },
      }),
    ).toEqual({ level: 'high' });
    expect(levelOf({ id: 'b', database_specific: { severity: 'MODERATE' } })).toEqual({ level: 'medium' });
    expect(levelOf({ id: 'c' })).toEqual({ level: 'unknown' });
  });
});

const ghsa: OsvVuln = {
  id: 'GHSA-423p-g724-fr39',
  aliases: ['CVE-2026-44477', 'GO-2026-5106'],
  severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H' }],
  affected: [
    { package: CNPG, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.28.3' }] }] },
    { package: CNPG, ranges: [{ type: 'SEMVER', events: [{ introduced: '1.29.0' }, { fixed: '1.29.1' }] }] },
  ],
};
const go: OsvVuln = {
  id: 'GO-2026-5106',
  aliases: ['CVE-2026-44477', 'GHSA-423p-g724-fr39'],
  affected: [
    {
      package: CNPG,
      ranges: [
        {
          type: 'SEMVER',
          events: [{ introduced: '0' }, { fixed: '1.28.3' }, { introduced: '1.29.0' }, { fixed: '1.29.1' }],
        },
      ],
    },
  ],
};

describe('findings', () => {
  it('finds the fix of the range the installed version is in', () => {
    expect(fixedVersion(ghsa, CNPG, '1.26.1')).toBe('1.28.3');
    expect(fixedVersion(ghsa, CNPG, '1.29.0')).toBe('1.29.1');
    expect(fixedVersion(go, CNPG, '1.29.0')).toBe('1.29.1');
  });

  it('knows no fix for an open range, a last_affected range or a pseudo-version', () => {
    const open: OsvVuln = {
      id: 'GO-1',
      affected: [{ package: CNPG, ranges: [{ type: 'SEMVER', events: [{ introduced: '1.3.0' }] }] }],
    };
    const last: OsvVuln = {
      id: 'GO-2',
      affected: [
        { package: CNPG, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { last_affected: '2.0.0' }] }] },
      ],
    };
    const pseudo: OsvVuln = {
      id: 'GO-3',
      affected: [
        {
          package: CNPG,
          ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.9.2-0.20260616075434-82ef13993059' }] }],
        },
      ],
    };
    expect([open, last, pseudo].map((v) => fixedVersion(v, CNPG, '1.26.1'))).toEqual([null, null, null]);
  });

  it('merges alias records into one finding and shows the GHSA id', () => {
    const f = findingsFor([go, ghsa], CNPG, '1.26.1');
    expect(f).toEqual([
      { id: 'GHSA-423p-g724-fr39', level: 'critical', score: 9.9, fixed: '1.28.3', summary: undefined },
    ]);
  });
});

const finding = (level: Finding['level'], fixed: string | null, id = `GHSA-${level}`): Finding => ({
  id,
  level,
  fixed,
});

describe('severity of a component', () => {
  it('is critical only for a fixable critical advisory on a component behind an ingress', () => {
    expect(issueSeverity([finding('critical', '1.2.3')], true)).toBe('critical');
    expect(issueSeverity([finding('critical', '1.2.3')], false)).toBe('warning');
    expect(issueSeverity([finding('critical', null)], true)).toBe('info');
  });

  it('warns for fixable high advisories and only hints at the rest', () => {
    expect(issueSeverity([finding('high', '1.2.3')], false)).toBe('warning');
    expect(issueSeverity([finding('high', null), finding('medium', '1.2.3')], true)).toBe('info');
    expect(issueSeverity([finding('low', '1.2.3'), finding('unknown', '1.2.4')], true)).toBe('info');
  });

  it('names the worst ids and the release that fixes them all', () => {
    const raw = vulnerabilityIssue({
      key: 'argocd',
      name: 'Argo CD',
      version: '2.11.3',
      reachable: true,
      findings: [
        { id: 'GHSA-a', level: 'critical', score: 9.1, fixed: '2.11.7' },
        finding('high', '2.11.5', 'GHSA-b'),
        finding('medium', null, 'GO-c'),
        finding('low', '2.11.4', 'GHSA-d'),
      ],
    })!;
    const issue = de(raw);
    expect(issue).toMatchObject({
      id: 'vulnerabilities/argocd',
      severity: 'critical',
      title: 'Argo CD 2.11.3: 4 bekannte Schwachstellen',
      cause:
        'Am schwersten: GHSA-a (kritisch, CVSS 9,1), GHSA-b (hoch), GO-c (mittel). Behoben in 2.11.7, für 1 gibt es noch kein Update. Über einen Ingress von außen erreichbar.',
      actions: [],
      advisories: ['GHSA-a', 'GHSA-b', 'GO-c', 'GHSA-d'],
    });
    // English writes the score with a point and words the open ones its own way.
    expect(en(raw)).toMatchObject({
      title: 'Argo CD 2.11.3: 4 known vulnerabilities',
      cause:
        'Most severe: GHSA-a (critical, CVSS 9.1), GHSA-b (high), GO-c (medium). Fixed in 2.11.7; 1 has no update yet. Reachable from outside through an ingress.',
    });
    expect(vulnerabilityIssue({ key: 'k', name: 'K', version: '1.0.0', reachable: false, findings: [] })).toBeNull();
    expect(
      de(
        vulnerabilityIssue({
          key: 'k',
          name: 'Kubernetes',
          version: '1.33.4',
          reachable: false,
          findings: [finding('low', null, 'GO-x')],
        })!,
      ).cause,
    ).toBe('GO-x (niedrig). Noch ist kein Update bekannt, das sie behebt.');
  });
});

describe('targets', () => {
  const det = (id: string, version: string | undefined, image?: string, links = 0): Detected => ({
    entry: CATALOG.find((e) => e.id === id)!,
    namespace: id,
    version,
    image,
    workloads: [],
    services: [],
    links: Array.from({ length: links }, (_, i) => ({ label: `h${i}`, url: `https://h${i}` })),
  });

  it('looks up Kubernetes and mapped components with a release version, and counts the rest', () => {
    const { targets, unmatched } = vulnTargets('v1.33.4+rke2r1', [
      det('argocd', '3.1.2', 'quay.io/argoproj/argocd:v3.1.2', 1),
      det('grafana', '12.1.0'),
      det('cnpg', 'latest'),
      det('gitea', '11.0', 'codeberg.org/forgejo/forgejo:11.0'),
    ]);
    expect(targets.map((t) => [t.key, t.query.name, t.query.version, t.reachable])).toEqual([
      ['kubernetes', 'k8s.io/kubernetes', '1.33.4', false],
      ['argocd', 'github.com/argoproj/argo-cd/v3', '3.1.2', true],
    ]);
    expect(unmatched).toBe(3);
  });
});

/** A fake OSV: answers querybatch and vulns from a table, and counts the calls. */
function fakeOsv(records: OsvVuln[]) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let down = false;
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push(`${init?.method} ${url}`);
    if (down) {
      throw new Error('getaddrinfo ENOTFOUND api.osv.dev');
    }
    if (url.endsWith('/v1/querybatch')) {
      bodies.push(JSON.parse(String(init?.body)));
      const { queries } = JSON.parse(String(init?.body)) as {
        queries: { package: { ecosystem: string; name: string }; version: string }[];
      };
      const results = queries.map((q) => ({
        vulns: records
          .filter((v) => affects(v, { ...q.package, version: q.version }))
          .map((v) => ({ id: v.id, modified: '2026-11-01T00:00:00Z' })),
      }));
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    const id = decodeURIComponent(url.split('/v1/vulns/')[1]);
    const rec = records.find((v) => v.id === id);
    return rec ? new Response(JSON.stringify(rec), { status: 200 }) : new Response('{}', { status: 404 });
  };
  return { fetchFn, calls, bodies, setDown: (v: boolean) => (down = v) };
}

describe('OSV client', () => {
  const q = { ...CNPG, version: '1.26.1' };

  it('asks querybatch, then the details of each id, and caches both for 12 h', async () => {
    const osv = fakeOsv([ghsa, go]);
    const client = new OsvClient('https://api.osv.dev', osv.fetchFn);
    const first = await client.lookup([q, { ...CNPG, version: '1.28.3' }], NOW);
    expect(first.results.map((r) => r.map((v) => v.id).sort())).toEqual([['GHSA-423p-g724-fr39', 'GO-2026-5106'], []]);
    expect(first.staleSince).toBeUndefined();
    expect(osv.calls).toEqual([
      'POST https://api.osv.dev/v1/querybatch',
      'GET https://api.osv.dev/v1/vulns/GHSA-423p-g724-fr39',
      'GET https://api.osv.dev/v1/vulns/GO-2026-5106',
    ]);
    // Package and version, nothing about the cluster.
    expect(osv.bodies).toEqual([
      {
        queries: [
          { package: CNPG, version: '1.26.1' },
          { package: CNPG, version: '1.28.3' },
        ],
      },
    ]);
    await client.lookup([q], new Date(NOW.getTime() + OSV_TTL_MS - 1));
    expect(osv.calls).toHaveLength(3);
    await client.lookup([q], new Date(NOW.getTime() + OSV_TTL_MS));
    expect(osv.calls).toHaveLength(6);
  });

  it('serves older answers marked stale when the database is down, and fails honestly without any', async () => {
    const osv = fakeOsv([ghsa]);
    const client = new OsvClient('https://osv.example.org', osv.fetchFn);
    osv.setDown(true);
    await expect(client.lookup([q], NOW)).rejects.toThrow(
      'osv.example.org unreachable: getaddrinfo ENOTFOUND api.osv.dev',
    );
    osv.setDown(false);
    const back = new Date(NOW.getTime() + OSV_BACKOFF_MS);
    await client.lookup([q], back);
    osv.setDown(true);
    const later = new Date(back.getTime() + 13 * 3_600_000);
    const stale = await client.lookup([q], later);
    expect(stale.staleSince).toEqual(back);
    expect(stale.results[0].map((v) => v.id)).toEqual(['GHSA-423p-g724-fr39']);
    await expect(client.lookup([q], new Date(NOW.getTime() + 8 * 86_400_000))).rejects.toThrow('unreachable');
  });

  it('leaves a database that is down alone for a while instead of waiting on it every run', async () => {
    const osv = fakeOsv([ghsa]);
    const client = new OsvClient('https://osv.example.org', osv.fetchFn);
    osv.setDown(true);
    await expect(client.lookup([q], NOW)).rejects.toThrow('unreachable');
    const asked = osv.calls.length;
    osv.setDown(false);
    await expect(client.lookup([q], new Date(NOW.getTime() + OSV_BACKOFF_MS - 1))).rejects.toThrow('unreachable');
    expect(osv.calls).toHaveLength(asked);
    const res = await client.lookup([q], new Date(NOW.getTime() + OSV_BACKOFF_MS));
    expect(res.results[0].map((v) => v.id)).toEqual(['GHSA-423p-g724-fr39']);
  });

  it('keeps only well-formed fields of a record from outside the cluster', () => {
    const v = sanitize(
      {
        id: 'x',
        aliases: ['CVE-1', '<script>', 3],
        summary: 'a'.repeat(500),
        severity: [{ type: 'CVSS_V3', score: 1 }],
        affected: 'nope',
      },
      'GHSA-1',
    );
    expect(v).toEqual({
      id: 'GHSA-1',
      aliases: ['CVE-1'],
      summary: 'a'.repeat(200),
      severity: [],
      database_specific: undefined,
      affected: [],
    });
  });

  it('drops malformed ids from querybatch', async () => {
    const fetchFn = async (url: string) =>
      new Response(
        url.endsWith('querybatch')
          ? JSON.stringify({ results: [{ vulns: [{ id: '../../etc' }, { id: 'GHSA-ok12-ok12-ok12' }] }] })
          : JSON.stringify({ id: 'GHSA-ok12-ok12-ok12' }),
        { status: 200 },
      );
    const res = await new OsvClient('https://api.osv.dev', fetchFn).lookup([q], NOW);
    expect(res.results[0].map((v) => v.id)).toEqual(['GHSA-ok12-ok12-ok12']);
  });
});

describe('vulnerabilities check', () => {
  const check = new VulnerabilitiesCheck();
  const ctx = (vulnDb: ModuleContext['vulnDb'], detected: Detected[]): ModuleContext => {
    const inv = emptyInventory(NOW);
    inv.version = { gitVersion: 'v1.33.4+rke2r1' } as typeof inv.version;
    return {
      inv,
      kube: {} as ModuleContext['kube'],
      config: { vulnDbUrl: 'https://api.osv.dev' } as ModuleContext['config'],
      now: NOW,
      prom: null,
      data: {},
      detected,
      vulnDb,
    };
  };
  const cnpg: Detected = {
    entry: CATALOG.find((e) => e.id === 'cnpg')!,
    namespace: 'cnpg-system',
    version: '1.26.1',
    image: 'ghcr.io/cloudnative-pg/cloudnative-pg:1.26.1',
    workloads: [],
    services: [],
    links: [],
  };

  it('is off by default and says what leaves the cluster', () => {
    expect(check.defaultOff).toBe(true);
    expect(check.reads).toEqual([]);
    expect(de(check.privacy({ vulnDbUrl: 'https://api.osv.dev' } as ModuleContext['config']))).toBe(
      'Schickt Namen und Versionen der Komponenten an api.osv.dev (Google). Keine Clusterdaten, keine Namen von Workloads.',
    );
    expect(de(check.privacy({ vulnDbUrl: 'https://osv.mirror.svc' } as ModuleContext['config']))).toContain(
      'an osv.mirror.svc.',
    );
  });

  it('reports the demo database answer as a warning on the component', async () => {
    const result = de(await check.run(ctx(new DemoVulnDb(), [cnpg]), () => true));
    expect(result.issues.map((i) => [i.id, i.severity, i.title])).toEqual([
      ['vulnerabilities/cnpg', 'warning', 'CloudNativePG 1.26.1: 1 bekannte Schwachstelle'],
    ]);
    expect(result.summary).toBe('1 Komponente mit bekannten Schwachstellen');
    expect(result.stats.find((s) => s.label === 'Kritisch')).toEqual({
      label: 'Kritisch',
      value: '1',
      tone: 'critical',
    });
  });

  it('fails (module error, not a red light) when the database is unreachable', async () => {
    const down = {
      host: 'api.osv.dev',
      lookup: async () => Promise.reject(new Error('api.osv.dev unreachable: timeout')),
    };
    await expect(check.run(ctx(down, [cnpg]), () => true)).rejects.toThrow('api.osv.dev unreachable');
  });

  it('says so when it shows older answers', async () => {
    const stale = {
      host: 'api.osv.dev',
      lookup: async () => ({ results: [[], []], staleSince: new Date(NOW.getTime() - 3 * 3_600_000) }),
    };
    const result = de(await check.run(ctx(stale, [cnpg]), () => true));
    expect(result.summary).toBe(
      'Keine bekannten Schwachstellen in 2 Versionen, nur Kubernetes und erkannte Komponenten (Stand vor 3 h, api.osv.dev gerade nicht erreichbar)',
    );
  });
});
