import { TextError, t } from '../../i18n/text';
import { Integration } from '../module';
import { ModuleContext, ModuleResult, Stat } from '../types';
import { TrivyCollector, VulnerabilityReport, acceptTrivy, total, trivyIssue, workloadFindings, workloadIndex } from './trivy-reports';

const REPORTS = '/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports';
const CLUSTER_REPORTS = '/apis/aquasecurity.github.io/v1alpha1/clustervulnerabilityreports';

/**
 * Trivy Operator's VulnerabilityReports: the scan of every image that runs,
 * your own included, which the built-in lookup cannot see (it only knows the
 * versions of Kubernetes and a few recognised components). Read only, in the
 * cluster: no outbound connection, no write.
 *
 * Judged exactly like the built-in lookup (`issueSeverity`), one issue per
 * workload. Its workloads are written to `RunData.trivy`, so the built-in
 * lookup steps back for components Trivy scanned (it runs after the
 * components, see StatusService).
 */
export class TrivyIntegration extends Integration {
  readonly id = 'trivy';
  readonly reads = [
    { group: 'aquasecurity.github.io', resource: 'vulnerabilityreports', why: "Trivy Operator's scan of each workload's images: counts and the worst advisories" },
    { group: 'aquasecurity.github.io', resource: 'clustervulnerabilityreports', why: 'the same for cluster-scoped resources, where Trivy Operator writes them' },
  ];

  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const collector = new TrivyCollector(workloadIndex(ctx.inv), ctx.now);
    const add = (items: VulnerabilityReport[]) => collector.add(items);
    if (!(await ctx.kube.listEach<VulnerabilityReport>(REPORTS, add))) {
      throw new TextError(t('trivy.noCrd'));
    }
    await ctx.kube.listEach<VulnerabilityReport>(CLUSTER_REPORTS, add).catch(() => false);
    const { workloads, stale, unmatched } = collector.collected();
    ctx.data.trivy = { covered: new Set(workloads.keys()) };

    const acceptance = ctx.vulnAcceptance ?? { allowed: false, accepted: new Map() };
    const { items, accepted } = acceptTrivy(
      [...workloads.values()].map((w) => workloadFindings(ctx.inv, w)),
      acceptance.accepted,
    );
    const issues = items.map((w) => trivyIssue(w, ctx.now)).filter((i) => i !== null);
    const sum = (level: 'critical' | 'high' | 'medium') => items.reduce((n, w) => n + w.counts[level], 0);
    const rest = items.reduce((n, w) => n + total(w.counts), 0) - sum('critical') - sum('high') - sum('medium');
    const stats: Stat[] = [
      { label: t('trivy.stat.workloads'), value: String(workloads.size) },
      { label: t('vulnerabilities.stat.critical'), value: String(sum('critical')), tone: sum('critical') ? 'critical' : 'ok' },
      { label: t('vulnerabilities.stat.high'), value: String(sum('high')), tone: sum('high') ? 'warning' : 'ok' },
      { label: t('vulnerabilities.stat.medium'), value: String(sum('medium')), tone: 'muted' },
      { label: t('vulnerabilities.stat.lowOrUnrated'), value: String(rest), tone: 'muted' },
      ...(stale ? [{ label: t('trivy.stat.stale'), value: String(stale), tone: 'muted' as const }] : []),
      ...(unmatched ? [{ label: t('trivy.stat.unmatched'), value: String(unmatched), tone: 'muted' as const }] : []),
      ...(accepted.length ? [{ label: t('vulnerabilities.stat.accepted'), value: String(accepted.length), tone: 'muted' as const }] : []),
    ];
    const summary = issues.length === 0 ? t('trivy.summary.none', { n: workloads.size }) : t('trivy.summary.affected', { n: issues.length });
    return { issues, stats, summary, accepted, canAccept: acceptance.allowed };
  }
}
