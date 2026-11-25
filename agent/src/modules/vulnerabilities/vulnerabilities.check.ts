import { ageText } from '../../checks/types';
import { TextError, t } from '../../i18n/text';
import type { Config } from '../../config';
import { CATALOG } from '../../discovery/catalog';
import { Detected } from '../../discovery/discovery';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult, Stat } from '../types';
import { ComponentFindings, applyAcceptance, countByLevel, findingsFor, vulnerabilityIssue } from './evaluate';
import { OsvQuery } from './osv-client';
import { osvPackageFor, releaseVersion } from './versions';

interface Target {
  key: string;
  name: string;
  version: string;
  reachable: boolean;
  query: OsvQuery;
}

/** How many catalog entries the built-in lookup can look up at all. */
export const MAPPED_COMPONENTS = CATALOG.filter((e) => e.osv).length;

/**
 * What to look up: Kubernetes itself (its `/version`, as `k8s.io/kubernetes`
 * in OSV's Go ecosystem, which lists the control plane's advisories) and
 * every detected component whose catalog entry names an OSV package and
 * whose image tag is a release version. The rest is counted, not guessed.
 *
 * A component whose every workload has a fresh Trivy Operator report is left
 * to Trivy (`covered`): Trivy scanned the image itself, packages and base
 * layer included, so its findings are the better ones, and the same
 * advisories would otherwise show twice. It is then not even sent to OSV.
 */
export function vulnTargets(gitVersion: string | undefined, detected: Detected[], covered?: ReadonlySet<string>): { targets: Target[]; unmatched: number; covered: number } {
  const targets: Target[] = [];
  const k8s = releaseVersion(gitVersion);
  if (k8s) {
    targets.push({ key: 'kubernetes', name: 'Kubernetes', version: k8s, reachable: false, query: { ecosystem: 'Go', name: 'k8s.io/kubernetes', version: k8s } });
  }
  let unmatched = 0;
  let byTrivy = 0;
  for (const d of detected) {
    const version = releaseVersion(d.version, { calver: d.entry.osv?.calver });
    const pkg = d.entry.osv && version ? osvPackageFor(d.entry.osv, version, d.image) : null;
    if (!pkg || !version) {
      unmatched++;
      continue;
    }
    if (covered && d.workloads.length > 0 && d.workloads.every((w) => covered.has(`${w.namespace}/${w.kind}/${w.name}`))) {
      byTrivy++;
      continue;
    }
    targets.push({ key: d.entry.id, name: d.entry.name, version, reachable: d.links.length > 0, query: { ...pkg, version } });
  }
  return { targets, unmatched, covered: byTrivy };
}

/** The line that says what the lookup cannot see, and whether Trivy Operator fills the gap. */
export function trivyHint(trivyRan: boolean, trivyDetected: boolean): Stat {
  if (trivyRan) {
    return { label: t('vulnerabilities.stat.everyImage'), value: t('vulnerabilities.trivy.found'), tone: 'ok' };
  }
  return { label: t('vulnerabilities.stat.everyImage'), value: t(trivyDetected ? 'vulnerabilities.trivy.off' : 'vulnerabilities.trivy.missing'), tone: 'muted' };
}

export class VulnerabilitiesCheck extends CoreCheck {
  readonly id = 'vulnerabilities';
  readonly name = t('module.vulnerabilities.name');
  readonly icon = 'bug-outline';
  readonly description = t('module.vulnerabilities.description');
  readonly reads = [];
  override readonly defaultOff = true;

  override privacy(config: Config) {
    const host = new URL(config.vulnDbUrl).host;
    return host === 'api.osv.dev' ? t('vulnerabilities.privacy.osv') : t('vulnerabilities.privacy.other', { host });
  }

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    if (!ctx.vulnDb) {
      throw new TextError(t('vulnerabilities.noDatabase'));
    }
    const trivy = ctx.data.trivy;
    const { targets, unmatched, covered } = vulnTargets(ctx.inv.version?.gitVersion, ctx.detected ?? [], trivy?.covered);
    const { results, staleSince } = await ctx.vulnDb.lookup(
      targets.map((t) => t.query),
      ctx.now,
    );
    const found: ComponentFindings[] = targets.map((t, i) => ({ key: t.key, name: t.name, version: t.version, reachable: t.reachable, findings: findingsFor(results[i], t.query, t.version) }));
    const acceptance = ctx.vulnAcceptance ?? { allowed: false, accepted: new Map() };
    const { components, accepted } = applyAcceptance(found, acceptance.accepted);
    const issues = components.map(vulnerabilityIssue).filter((i) => i !== null);
    const counts = countByLevel(components);
    const stats: Stat[] = [
      { label: t('vulnerabilities.stat.scope'), value: t('vulnerabilities.scope', { n: MAPPED_COMPONENTS }) },
      trivyHint(trivy !== undefined, (ctx.detected ?? []).some((d) => d.entry.id === 'trivy')),
      { label: t('vulnerabilities.stat.checked'), value: t('vulnerabilities.stat.versions', { n: targets.length }) },
      ...(covered ? [{ label: t('vulnerabilities.stat.byTrivy'), value: String(covered), tone: 'muted' as const }] : []),
      { label: t('vulnerabilities.stat.critical'), value: String(counts.critical), tone: counts.critical ? 'critical' : 'ok' },
      { label: t('vulnerabilities.stat.high'), value: String(counts.high), tone: counts.high ? 'warning' : 'ok' },
      { label: t('vulnerabilities.stat.medium'), value: String(counts.medium), tone: 'muted' },
      { label: t('vulnerabilities.stat.lowOrUnrated'), value: String(counts.low + counts.unknown), tone: 'muted' },
      { label: t('vulnerabilities.stat.unmatched'), value: String(unmatched), tone: 'muted' },
      ...(accepted.length ? [{ label: t('vulnerabilities.stat.accepted'), value: String(accepted.length), tone: 'muted' as const }] : []),
      { label: t('stat.database'), value: ctx.vulnDb.host },
    ];
    const affected = issues.length;
    const none = trivy ? 'vulnerabilities.summary.noneTrivy' : 'vulnerabilities.summary.none';
    const base = affected === 0 ? t(none, { n: targets.length }) : t('vulnerabilities.summary.affected', { n: affected });
    const summary = staleSince
      ? t('vulnerabilities.summary.stale', { summary: base, age: ageText(ctx.now.getTime() - staleSince.getTime()), host: ctx.vulnDb.host })
      : base;
    return { issues, stats, summary, accepted, canAccept: acceptance.allowed };
  }
}
