import { OsvQuery, OsvVuln, VulnDb, VulnLookup } from '../modules/vulnerabilities/osv-client';
import { compareVersions } from '../modules/vulnerabilities/versions';

/**
 * Real OSV records (fetched from api.osv.dev on 2026-11-24, trimmed to the
 * fields the check reads), so the demo shows what a real answer looks like
 * without ever calling the internet. The demo cluster runs the CloudNativePG
 * operator at 1.26.1 in the broken scenario and at the fixed 1.28.3 otherwise.
 */
const RECORDS: OsvVuln[] = [
  {
    id: 'GHSA-423p-g724-fr39',
    aliases: ['CVE-2026-44477', 'GO-2026-5106'],
    summary: "CloudNativePG's metrics exporter allows privilege escalation to PostgreSQL superuser and OS RCE",
    severity: [
      { type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:H/A:H' },
      { type: 'CVSS_V4', score: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:H/SC:H/SI:H/SA:H' },
    ],
    database_specific: { severity: 'CRITICAL' },
    affected: [
      {
        package: { ecosystem: 'Go', name: 'github.com/cloudnative-pg/cloudnative-pg' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '1.28.3' }] }],
      },
      {
        package: { ecosystem: 'Go', name: 'github.com/cloudnative-pg/cloudnative-pg' },
        ranges: [{ type: 'SEMVER', events: [{ introduced: '1.29.0' }, { fixed: '1.29.1' }] }],
      },
    ],
  },
  {
    id: 'GO-2026-5106',
    aliases: ['CVE-2026-44477', 'GHSA-423p-g724-fr39'],
    summary:
      "CloudNativePG's metrics exporter allows privilege escalation to PostgreSQL superuser and OS RCE in github.com/cloudnative-pg/cloudnative-pg",
    affected: [
      {
        package: { ecosystem: 'Go', name: 'github.com/cloudnative-pg/cloudnative-pg' },
        ranges: [
          {
            type: 'SEMVER',
            events: [{ introduced: '0' }, { fixed: '1.28.3' }, { introduced: '1.29.0' }, { fixed: '1.29.1' }],
          },
        ],
      },
    ],
  },
];

/** Does the record list `version` of the package as affected (introduced ≤ version < fixed)? */
export function affects(v: OsvVuln, q: OsvQuery): boolean {
  return (v.affected ?? []).some(
    (a) =>
      a.package?.ecosystem === q.ecosystem &&
      a.package?.name === q.name &&
      (a.ranges ?? []).some((r) => {
        let from: string | null = null;
        for (const e of r.events) {
          if (e.introduced !== undefined) {
            from = e.introduced;
          } else if (from !== null && e.fixed !== undefined) {
            if (compareVersions(q.version, from) >= 0 && compareVersions(q.version, e.fixed) < 0) {
              return true;
            }
            from = null;
          }
        }
        return from !== null && compareVersions(q.version, from) >= 0;
      }),
  );
}

/** The vulnerability database of the demo: answers like OSV, from the records above. */
export class DemoVulnDb implements VulnDb {
  readonly host = 'api.osv.dev';

  async lookup(queries: OsvQuery[]): Promise<VulnLookup> {
    return { results: queries.map((q) => RECORDS.filter((v) => affects(v, q))) };
  }
}
