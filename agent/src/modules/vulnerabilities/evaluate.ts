import { Issue, IssueSeverity } from '../../checks/types';
import { t, Text } from '../../i18n/text';
import type { AcceptedAdvisory } from '../types';
import { Acceptance, acceptanceKey } from './acceptance';
import { cvss3Score } from './cvss';
import { OsvVuln } from './osv-client';
import { compareVersions, isPseudoVersion } from './versions';

export type Level = 'critical' | 'high' | 'medium' | 'low' | 'unknown';

export const LEVEL_RANK: Record<Level, number> = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };
const LEVEL_LABEL: Record<Level, Text> = {
  critical: t('vulnerabilities.level.critical'),
  high: t('vulnerabilities.level.high'),
  medium: t('vulnerabilities.level.medium'),
  low: t('vulnerabilities.level.low'),
  unknown: t('vulnerabilities.level.unknown'),
};

/** One advisory, after merging the records that are aliases of each other (GO-… and GHSA-… for the same CVE). */
export interface Finding {
  /** The id shown and linked: GHSA when there is one (it carries the severity), else the first. */
  id: string;
  level: Level;
  score?: number;
  /** The first release that fixes it for the installed version; null when no release is known to. */
  fixed: string | null;
  summary?: string;
}

/** The OSV/CVSS bands: critical from 9.0, high from 7.0, medium from 4.0. */
export function levelOfScore(score: number): Level {
  return score >= 9 ? 'critical' : score >= 7 ? 'high' : score >= 4 ? 'medium' : score > 0 ? 'low' : 'unknown';
}

/** A CVSS v3 vector when there is one, else the label of the database (GitHub's advisories carry one). */
export function levelOf(v: OsvVuln): { level: Level; score?: number } {
  const scores = (v.severity ?? [])
    .map((s) => (s.type === 'CVSS_V3' ? cvss3Score(s.score) : null))
    .filter((s): s is number => s !== null);
  if (scores.length > 0) {
    const score = Math.max(...scores);
    return { level: levelOfScore(score), score };
  }
  const label = v.database_specific?.severity?.toUpperCase();
  const level: Level =
    label === 'CRITICAL'
      ? 'critical'
      : label === 'HIGH'
        ? 'high'
        : label === 'MODERATE' || label === 'MEDIUM'
          ? 'medium'
          : label === 'LOW'
            ? 'low'
            : 'unknown';
  return { level };
}

/**
 * The release that fixes `version` according to the advisory's ranges for
 * the package: the `fixed` event closing the range the version falls in.
 * null when that range has no fix (or only a Go pseudo-version, which names
 * a commit rather than a release).
 */
export function fixedVersion(v: OsvVuln, pkg: { ecosystem: string; name: string }, version: string): string | null {
  const fixes: string[] = [];
  for (const a of v.affected ?? []) {
    if (a.package?.name !== pkg.name || (a.package.ecosystem && a.package.ecosystem !== pkg.ecosystem)) {
      continue;
    }
    for (const range of a.ranges ?? []) {
      if (range.type === 'GIT') {
        continue;
      }
      let introduced: string | null = null;
      for (const e of range.events) {
        if (e.introduced !== undefined) {
          introduced = e.introduced;
        } else if (introduced !== null && (e.fixed !== undefined || e.last_affected !== undefined)) {
          const end = (e.fixed ?? e.last_affected)!;
          const inside =
            compareVersions(version, introduced) >= 0 &&
            (e.fixed !== undefined ? compareVersions(version, end) < 0 : compareVersions(version, end) <= 0);
          if (inside && e.fixed !== undefined && !isPseudoVersion(e.fixed)) {
            fixes.push(e.fixed);
          }
          introduced = null;
        }
      }
    }
  }
  return fixes.sort(compareVersions)[0] ?? null;
}

/** Merges alias records into one finding each, worst first. */
export function findingsFor(vulns: OsvVuln[], pkg: { ecosystem: string; name: string }, version: string): Finding[] {
  const groups: OsvVuln[][] = [];
  for (const v of vulns) {
    const names = new Set([v.id, ...(v.aliases ?? [])]);
    const group = groups.find((g) => g.some((o) => names.has(o.id) || (o.aliases ?? []).some((a) => names.has(a))));
    if (group) {
      group.push(v);
    } else {
      groups.push([v]);
    }
  }
  const findings = groups.map((g): Finding => {
    const shown = g.find((v) => v.id.startsWith('GHSA-')) ?? [...g].sort((a, b) => a.id.localeCompare(b.id))[0];
    const rated = g
      .map(levelOf)
      .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || (b.score ?? 0) - (a.score ?? 0))[0];
    const fixes = g.map((v) => fixedVersion(v, pkg, version)).filter((f): f is string => f !== null);
    return {
      id: shown.id,
      level: rated.level,
      score: rated.score,
      fixed: fixes.sort(compareVersions).at(-1) ?? null,
      summary: shown.summary ?? g.find((v) => v.summary)?.summary,
    };
  });
  return findings.sort(
    (a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id),
  );
}

/**
 * How loud one component's advisories are:
 *
 * - critical only for a critical advisory (CVSS ≥ 9.0) with a released fix on
 *   a component reachable through an ingress: exposed and fixable now;
 * - warning for a critical one that is not exposed, or a high one (≥ 7.0),
 *   with a released fix;
 * - a hint for everything else: medium and low, and advisories no release
 *   fixes yet. A warning nobody can act on would only teach people to
 *   ignore the light.
 */
export function issueSeverity(findings: Finding[], reachable: boolean): IssueSeverity {
  const fixable = findings.filter((f) => f.fixed !== null);
  if (fixable.some((f) => f.level === 'critical')) {
    return reachable ? 'critical' : 'warning';
  }
  return fixable.some((f) => f.level === 'high') ? 'warning' : 'info';
}

export interface ComponentFindings {
  /** Catalog id, or "kubernetes". */
  key: string;
  name: string;
  version: string;
  /** Has an ingress, HTTPRoute or IngressRoute: reachable from outside the cluster network. */
  reachable: boolean;
  findings: Finding[];
  /** Advisories of this component someone marked as not applicable; they no longer count. */
  accepted?: number;
}

/**
 * Takes the accepted advisories out of each component's findings. They stop
 * counting for the issue, the light and the stats, and come back as a list
 * for the module sheet. Expired acceptances are not in `accepted` any more.
 */
export function applyAcceptance(
  components: ComponentFindings[],
  accepted: ReadonlyMap<string, Acceptance>,
): { components: ComponentFindings[]; accepted: AcceptedAdvisory[] } {
  const list: AcceptedAdvisory[] = [];
  const kept = components.map((c) => {
    const remaining: Finding[] = [];
    for (const f of c.findings) {
      const a = accepted.get(acceptanceKey(c.key, f.id));
      if (a) {
        list.push({
          component: c.key,
          name: c.name,
          advisory: f.id,
          until: new Date(a.until).toISOString(),
          by: a.by,
          ...(a.reason ? { reason: a.reason } : {}),
        });
      } else {
        remaining.push(f);
      }
    }
    const n = c.findings.length - remaining.length;
    return n > 0 ? { ...c, findings: remaining, accepted: n } : c;
  });
  return { components: kept, accepted: list };
}

export const scoreText = (f: Finding): Text =>
  f.score !== undefined
    ? t('vulnerabilities.rated', { level: LEVEL_LABEL[f.level], score: f.score })
    : LEVEL_LABEL[f.level];

/** One issue per component with advisories. */
export function vulnerabilityIssue(c: ComponentFindings): Issue | null {
  if (c.findings.length === 0) {
    return null;
  }
  const n = c.findings.length;
  const worst = c.findings.slice(0, 3).map((f) => t('vulnerabilities.advisory', { id: f.id, rating: scoreText(f) }));
  const fixable = c.findings.filter((f) => f.fixed !== null);
  const fixedIn = fixable
    .map((f) => f.fixed!)
    .sort(compareVersions)
    .at(-1);
  const open = n - fixable.length;
  const severity = issueSeverity(c.findings, c.reachable);
  const parts: Text[] = [
    n === 1
      ? t('vulnerabilities.worst.one', { advisories: worst })
      : t('vulnerabilities.worst.many', { advisories: worst }),
  ];
  if (fixedIn) {
    parts.push(
      open === 0
        ? t('vulnerabilities.fixed', { version: fixedIn })
        : t('vulnerabilities.fixedSome', { version: fixedIn, open }),
    );
  } else {
    parts.push(t('vulnerabilities.noFix'));
  }
  if (severity === 'critical') {
    parts.push(t('vulnerabilities.exposed'));
  }
  if (c.accepted) {
    parts.push(t('vulnerabilities.acceptedNote', { n: c.accepted }));
  }
  return {
    id: `vulnerabilities/${c.key}`,
    check: 'vulnerabilities',
    severity,
    title: t('vulnerabilities.title', { name: c.name, version: c.version, n }),
    cause: t('common.sentences', { parts }),
    actions: [],
    advisories: c.findings.slice(0, 20).map((f) => f.id),
  };
}

/** Advisories per level across all components, for the module's stats. */
export function countByLevel(components: ComponentFindings[]): Record<Level, number> {
  const counts: Record<Level, number> = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const c of components) {
    for (const f of c.findings) {
      counts[f.level]++;
    }
  }
  return counts;
}
