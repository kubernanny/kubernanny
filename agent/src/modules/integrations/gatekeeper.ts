import { Issue } from '../../checks/types';
import { raw, t } from '../../i18n/text';
import { Integration } from '../module';
import { ModuleContext, ModuleResult } from '../types';

interface ByPod {
  id?: string;
  errors?: { code?: string; message?: string }[];
}

/** A ConstraintTemplate (templates.gatekeeper.sh/v1): it defines one constraint kind. */
export interface ConstraintTemplate {
  metadata: { name: string };
  spec?: { crd?: { spec?: { names?: { kind?: string } } } };
  status?: { created?: boolean; byPod?: ByPod[] };
}

/** A constraint (constraints.gatekeeper.sh/v1beta1, one kind per template) with the audit's findings. */
export interface Constraint {
  kind?: string;
  metadata: { name: string };
  spec?: { enforcementAction?: string };
  status?: { totalViolations?: number; violations?: { message?: string }[]; byPod?: ByPod[] };
}

/** `deny` is Gatekeeper's default: the constraint blocks requests; `dryrun` and `warn` only report. */
const denies = (c: Constraint) => (c.spec?.enforcementAction ?? 'deny').toLowerCase() === 'deny';

const firstError = (byPod: ByPod[] | undefined) =>
  byPod?.flatMap((p) => p.errors ?? []).find((e) => e.message || e.code);

/**
 * One hint per constraint with violations (the audit's `totalViolations`):
 * posture, not an outage. A warning when a constraint that denies requests
 * cannot work, because Gatekeeper reports errors for it or its template.
 */
export function evaluateGatekeeper(templates: ConstraintTemplate[], constraints: Constraint[]): Issue[] {
  const templateErrors = new Map(
    templates.map((tpl) => [(tpl.spec?.crd?.spec?.names?.kind ?? '').toLowerCase(), firstError(tpl.status?.byPod)]),
  );
  const issues: Issue[] = [];
  for (const c of constraints) {
    const kind = c.kind ?? '?';
    const id = `gatekeeper/${kind}/${c.metadata.name}`;
    const label = `${kind}/${c.metadata.name}`;
    const error = firstError(c.status?.byPod) ?? templateErrors.get(kind.toLowerCase());
    if (denies(c) && error) {
      issues.push({
        id: `${id}/errors`,
        check: 'gatekeeper',
        severity: 'warning',
        title: t('gatekeeper.errors.title', { constraint: label }),
        cause: t('gatekeeper.errors.cause', { message: raw(error.message || error.code || '') }),
        actions: [],
      });
    }
    const n = c.status?.totalViolations ?? 0;
    if (n > 0) {
      const messages = (c.status?.violations ?? [])
        .map((v) => v.message)
        .filter((m): m is string => !!m)
        .slice(0, 2);
      issues.push({
        id,
        check: 'gatekeeper',
        severity: 'info',
        title: t('policy.violations.title', { policy: label, n }),
        cause: t('common.sentences', {
          parts: [
            t(denies(c) ? 'gatekeeper.violations.deny' : 'gatekeeper.violations.audit'),
            ...messages.map((m) => raw(m.slice(0, 300))),
          ],
        }),
        actions: [],
      });
    }
  }
  return issues;
}

export class GatekeeperIntegration extends Integration {
  readonly id = 'gatekeeper';
  readonly reads = [
    {
      group: 'templates.gatekeeper.sh',
      resource: 'constrainttemplates',
      why: 'which constraint kinds exist and whether they compiled',
    },
    // One CRD per template, named after its kind: they can only be granted as a whole group.
    {
      group: 'constraints.gatekeeper.sh',
      resource: '*',
      why: 'violations the audit found per constraint, and its enforcement action',
    },
  ];

  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const templates =
      (await ctx.kube.list<ConstraintTemplate>('/apis/templates.gatekeeper.sh/v1/constrainttemplates')) ?? [];
    // Gatekeeper names each constraint CRD's plural after the kind in lower case.
    const kinds = [
      ...new Set(
        templates
          .map((tpl) => (tpl.spec?.crd?.spec?.names?.kind ?? '').toLowerCase())
          .filter((k) => /^[a-z0-9]{1,63}$/.test(k)),
      ),
    ];
    const lists = await Promise.all(
      kinds.map((plural) =>
        ctx.kube.list<Constraint>(`/apis/constraints.gatekeeper.sh/v1beta1/${plural}`).catch(() => null),
      ),
    );
    const constraints = lists.flatMap((l, i) =>
      (l ?? []).map((c) => ({
        ...c,
        kind:
          c.kind ??
          templates.find((tpl) => tpl.spec?.crd?.spec?.names?.kind?.toLowerCase() === kinds[i])?.spec?.crd?.spec?.names
            ?.kind,
      })),
    );
    const issues = evaluateGatekeeper(templates, constraints);
    const violations = constraints.reduce((s, c) => s + (c.status?.totalViolations ?? 0), 0);
    const violating = issues.filter((i) => i.severity === 'info').length;
    return {
      issues,
      stats: [
        { label: t('gatekeeper.stat.templates'), value: String(templates.length) },
        { label: t('gatekeeper.stat.constraints'), value: String(constraints.length) },
        { label: t('policy.stat.enforced'), value: String(constraints.filter(denies).length) },
        { label: t('gatekeeper.stat.violations'), value: String(violations), tone: violations ? 'muted' : 'ok' },
      ],
      summary:
        issues.find((i) => i.severity !== 'info')?.title ??
        (violating
          ? t('policy.summary.violations', { n: violating })
          : t('policy.summary.ok', { n: constraints.length })),
    };
  }
}
