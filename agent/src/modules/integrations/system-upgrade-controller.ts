import { Condition, condition, Issue } from '../../checks/types';
import { raw, t } from '../../i18n/text';
import { listSection, sections } from '../details';
import { Integration } from '../module';
import { DetailRow, ModuleContext, ModuleResult, Stat } from '../types';
import { Conditioned } from './util';

interface UpgradePlan extends Conditioned {
  spec?: { version?: string; channel?: string; concurrency?: number };
  status?: { conditions?: Condition[]; latestVersion?: string; applying?: string[] };
}

export class SystemUpgradeControllerIntegration extends Integration {
  readonly id = 'system-upgrade-controller';
  readonly reads = [
    {
      group: 'upgrade.cattle.io',
      resource: 'plans',
      why: 'plans that cannot resolve a version, and which nodes are upgrading',
    },
  ];
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const plans = (await ctx.kube.list<UpgradePlan>('/apis/upgrade.cattle.io/v1/plans')) ?? [];
    const issues: Issue[] = [];
    const stats: Stat[] = [];
    const rows: DetailRow[] = [];
    for (const plan of plans) {
      const resolved = condition(plan.status?.conditions, 'LatestResolved');
      if (resolved?.status === 'False') {
        issues.push({
          id: `upgrade/${plan.metadata.name}`,
          check: 'nodes',
          severity: 'warning',
          title: t('upgrade.unresolved.title', { plan: plan.metadata.name }),
          cause: raw(resolved.message ?? resolved.reason ?? ''),
          actions: [],
        });
      }
      const applying = plan.status?.applying ?? [];
      rows.push({
        name: plan.metadata.namespace ? `${plan.metadata.namespace}/${plan.metadata.name}` : plan.metadata.name,
        // The controller stores the version with "+" turned into "-" (a label value): v1.36.6-rke2r1 for v1.36.6+rke2r1.
        sub: raw(
          plan.spec?.version ??
            plan.status?.latestVersion?.replace(/-(rke2r\d+|k3s\d+)$/, '+$1') ??
            plan.spec?.channel ??
            '?',
        ),
        value: applying.length
          ? t('detail.upgrade.applying', { nodes: applying.join(', ') })
          : resolved?.status === 'False'
            ? t('detail.notReady')
            : t('detail.upgrade.done'),
        tone: resolved?.status === 'False' ? 'warning' : applying.length ? 'muted' : 'ok',
      });
    }
    const upgrading = new Set(plans.flatMap((p) => p.status?.applying ?? [])).size;
    stats.push(
      { label: t('stat.plans'), value: String(plans.length) },
      { label: t('stat.nodesUpgrading'), value: String(upgrading), tone: upgrading ? 'muted' : 'ok' },
    );
    return {
      issues,
      stats,
      details: sections(listSection(t('detail.upgrade.plans'), rows)),
      summary: plans.some((p) => p.status?.applying?.length)
        ? t('upgrade.summary.running')
        : t('upgrade.summary.ok', { n: plans.length }),
    };
  }
}
