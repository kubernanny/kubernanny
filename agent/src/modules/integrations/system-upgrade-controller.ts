import { Integration } from '../module';
import { Condition, Issue, condition } from '../../checks/types';
import {ModuleContext, ModuleResult, Stat } from '../types';
import { raw, t } from '../../i18n/text';
import { Conditioned } from './util';

interface UpgradePlan extends Conditioned {
  spec?: { version?: string; channel?: string; concurrency?: number };
  status?: { conditions?: Condition[]; latestVersion?: string; applying?: string[] };
}

export class SystemUpgradeControllerIntegration extends Integration {
  readonly id = 'system-upgrade-controller';
  readonly reads = [{ group: 'upgrade.cattle.io', resource: 'plans', why: 'plans that cannot resolve a version, and which nodes are upgrading' }];
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const plans = (await ctx.kube.list<UpgradePlan>('/apis/upgrade.cattle.io/v1/plans')) ?? [];
    const issues: Issue[] = [];
    const stats: Stat[] = [];
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
      stats.push({
        label: t('upgrade.stat.plan', { plan: plan.metadata.name }),
        value: t('upgrade.stat.planValue', { version: plan.status?.latestVersion ?? plan.spec?.version ?? '?', nodes: applying.length ? applying.join(', ') : undefined }),
        tone: applying.length ? 'muted' : 'ok',
      });
    }
    return { issues, stats, summary: plans.some((p) => p.status?.applying?.length) ? t('upgrade.summary.running') : t('upgrade.summary.ok', { n: plans.length }) };
  }
}
