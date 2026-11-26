import { condition, Issue, IssueSeverity } from '../../checks/types';
import { raw, rawOr, t } from '../../i18n/text';
import { Integration } from '../module';
import { ModuleContext, ModuleResult } from '../types';

/** A PolicyReport or ClusterPolicyReport (wgpolicyk8s.io/v1alpha2), the format Kyverno writes its results in. */
export interface PolicyReport {
  metadata: { name: string; namespace?: string };
  results?: { policy?: string; rule?: string; result?: string; message?: string }[];
}

/** A Kyverno Policy or ClusterPolicy (kyverno.io/v1). */
export interface KyvernoPolicy {
  metadata: { name: string; namespace?: string };
  spec?: { validationFailureAction?: string; rules?: { validate?: { failureAction?: string } }[] };
  status?: { conditions?: { type: string; status: string; message?: string }[] };
}

interface Tally {
  fail: number;
  error: number;
  message?: string;
}

/** Enforce blocks requests that break the policy; set for the whole policy (before Kyverno 1.13) or per rule. */
export function enforces(p: KyvernoPolicy): boolean {
  const modes = [p.spec?.validationFailureAction, ...(p.spec?.rules ?? []).map((r) => r.validate?.failureAction)];
  return modes.some((m) => m?.toLowerCase() === 'enforce');
}

/** How reports name a policy: its name, for a namespaced Policy also "<namespace>/<name>". */
const policyKeys = (p: KyvernoPolicy) => [
  p.metadata.name,
  ...(p.metadata.namespace ? [`${p.metadata.namespace}/${p.metadata.name}`] : []),
];

/**
 * Violations are the security posture, not an outage: one hint per policy
 * with failing resources. A warning only where Kyverno itself cannot do its
 * job on a policy that is meant to block (Enforce): results of `error` (the
 * engine could not evaluate the rule) or the policy not Ready.
 */
export function evaluateKyverno(reports: PolicyReport[], policies: KyvernoPolicy[]): Issue[] {
  const tallies = new Map<string, Tally>();
  for (const report of reports) {
    for (const r of report.results ?? []) {
      if (!r.policy || (r.result !== 'fail' && r.result !== 'error')) {
        continue;
      }
      const tally = tallies.get(r.policy) ?? { fail: 0, error: 0 };
      tally[r.result]++;
      tally.message ??= r.message;
      tallies.set(r.policy, tally);
    }
  }
  const byKey = new Map(policies.flatMap((p) => policyKeys(p).map((k) => [k, p] as const)));
  const issues: Issue[] = [];
  for (const [policy, tally] of [...tallies].sort(([a], [b]) => a.localeCompare(b))) {
    const enforced = byKey.has(policy) && enforces(byKey.get(policy)!);
    const severity: IssueSeverity = enforced && tally.error > 0 ? 'warning' : 'info';
    issues.push({
      id: `kyverno/policy/${policy}`,
      check: 'kyverno',
      severity,
      title:
        severity === 'warning'
          ? t('policy.errors.title', { policy, n: tally.error })
          : t('policy.violations.title', { policy, n: tally.fail + tally.error }),
      cause: t('common.sentences', {
        parts: [
          ...(tally.fail ? [t('policy.violations.fail', { n: tally.fail })] : []),
          ...(tally.error
            ? [t(enforced ? 'kyverno.errors.enforced' : 'policy.violations.error', { n: tally.error })]
            : []),
          ...(tally.message ? [raw(tally.message.slice(0, 300))] : []),
        ],
      }),
      actions: [],
    });
  }
  for (const p of policies) {
    const ready = condition(p.status?.conditions, 'Ready');
    if (enforces(p) && ready?.status === 'False') {
      const name = policyKeys(p).at(-1)!;
      issues.push({
        id: `kyverno/policy/${name}/not-ready`,
        check: 'kyverno',
        severity: 'warning',
        title: t('kyverno.notReady.title', { policy: name }),
        cause: rawOr(ready.message, t('kyverno.notReady.cause')),
        actions: [],
      });
    }
  }
  return issues;
}

export class KyvernoIntegration extends Integration {
  readonly id = 'kyverno';
  readonly reads = [
    { group: 'wgpolicyk8s.io', resource: 'policyreports', why: 'failing and erroring results per Kyverno policy' },
    { group: 'wgpolicyk8s.io', resource: 'clusterpolicyreports', why: 'the same for cluster-scoped resources' },
    { group: 'kyverno.io', resource: 'clusterpolicies', why: 'whether a policy enforces (Enforce) and is Ready' },
    { group: 'kyverno.io', resource: 'policies', why: 'the same for namespaced policies' },
  ];

  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const [reports, clusterReports, clusterPolicies, policies] = await Promise.all([
      ctx.kube.list<PolicyReport>('/apis/wgpolicyk8s.io/v1alpha2/policyreports').catch(() => null),
      ctx.kube.list<PolicyReport>('/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports').catch(() => null),
      ctx.kube.list<KyvernoPolicy>('/apis/kyverno.io/v1/clusterpolicies'),
      ctx.kube.list<KyvernoPolicy>('/apis/kyverno.io/v1/policies').catch(() => null),
    ]);
    const allPolicies = [...(clusterPolicies ?? []), ...(policies ?? [])];
    const issues = evaluateKyverno([...(reports ?? []), ...(clusterReports ?? [])], allPolicies);
    const violating = issues.filter((i) => !i.id.endsWith('/not-ready')).length;
    return {
      issues,
      stats: [
        { label: t('policy.stat.policies'), value: String(allPolicies.length) },
        { label: t('policy.stat.enforced'), value: String(allPolicies.filter(enforces).length) },
        { label: t('policy.stat.violating'), value: String(violating), tone: violating ? 'muted' : 'ok' },
      ],
      summary:
        issues.find((i) => i.severity !== 'info')?.title ??
        (violating
          ? t('policy.summary.violations', { n: violating })
          : t('policy.summary.ok', { n: allPolicies.length })),
    };
  }
}
