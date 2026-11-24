import { ageText } from '../../checks/types';
import { TextError, t } from '../../i18n/text';
import type { Config } from '../../config';
import { Detected } from '../../discovery/discovery';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult, Stat } from '../types';
import { ComponentFindings, countByLevel, findingsFor, vulnerabilityIssue } from './evaluate';
import { OsvQuery } from './osv-client';
import { osvPackageFor, releaseVersion } from './versions';

interface Target {
  key: string;
  name: string;
  version: string;
  reachable: boolean;
  query: OsvQuery;
}

/**
 * What to look up: Kubernetes itself (its `/version`, as `k8s.io/kubernetes`
 * in OSV's Go ecosystem, which lists the control plane's advisories) and
 * every detected component whose catalog entry names an OSV package and
 * whose image tag is a release version. The rest is counted, not guessed.
 */
export function vulnTargets(gitVersion: string | undefined, detected: Detected[]): { targets: Target[]; unmatched: number } {
  const targets: Target[] = [];
  const k8s = releaseVersion(gitVersion);
  if (k8s) {
    targets.push({ key: 'kubernetes', name: 'Kubernetes', version: k8s, reachable: false, query: { ecosystem: 'Go', name: 'k8s.io/kubernetes', version: k8s } });
  }
  let unmatched = 0;
  for (const d of detected) {
    const version = releaseVersion(d.version, { calver: d.entry.osv?.calver });
    const pkg = d.entry.osv && version ? osvPackageFor(d.entry.osv, version, d.image) : null;
    if (!pkg || !version) {
      unmatched++;
      continue;
    }
    targets.push({ key: d.entry.id, name: d.entry.name, version, reachable: d.links.length > 0, query: { ...pkg, version } });
  }
  return { targets, unmatched };
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
    const { targets, unmatched } = vulnTargets(ctx.inv.version?.gitVersion, ctx.detected ?? []);
    const { results, staleSince } = await ctx.vulnDb.lookup(
      targets.map((t) => t.query),
      ctx.now,
    );
    const components: ComponentFindings[] = targets.map((t, i) => ({ key: t.key, name: t.name, version: t.version, reachable: t.reachable, findings: findingsFor(results[i], t.query, t.version) }));
    const issues = components.map(vulnerabilityIssue).filter((i) => i !== null);
    const counts = countByLevel(components);
    const stats: Stat[] = [
      { label: t('vulnerabilities.stat.checked'), value: t('vulnerabilities.stat.versions', { n: targets.length }) },
      { label: t('vulnerabilities.stat.critical'), value: String(counts.critical), tone: counts.critical ? 'critical' : 'ok' },
      { label: t('vulnerabilities.stat.high'), value: String(counts.high), tone: counts.high ? 'warning' : 'ok' },
      { label: t('vulnerabilities.stat.medium'), value: String(counts.medium), tone: 'muted' },
      { label: t('vulnerabilities.stat.lowOrUnrated'), value: String(counts.low + counts.unknown), tone: 'muted' },
      { label: t('vulnerabilities.stat.unmatched'), value: String(unmatched), tone: 'muted' },
      { label: t('stat.database'), value: ctx.vulnDb.host },
    ];
    const affected = issues.length;
    const base = affected === 0 ? t('vulnerabilities.summary.none', { n: targets.length }) : t('vulnerabilities.summary.affected', { n: affected });
    const summary = staleSince
      ? t('vulnerabilities.summary.stale', { summary: base, age: ageText(ctx.now.getTime() - staleSince.getTime()), host: ctx.vulnDb.host })
      : base;
    return { issues, stats, summary };
  }
}
