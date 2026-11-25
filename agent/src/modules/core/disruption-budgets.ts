import { evaluatePdbs, Pdb } from '../../checks/maintenance.check';
import { t } from '../../i18n/text';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult } from '../types';

export class PdbCheck extends CoreCheck {
  readonly id = 'pdb';
  readonly name = t('module.pdb.name');
  readonly icon = 'shield-outline';
  readonly description = t('module.pdb.description');
  readonly reads = [{ group: 'policy', resource: 'poddisruptionbudgets', why: 'budgets that allow no disruption and block node drains' }];

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    const list = (await ctx.kube.list<Pdb>('/apis/policy/v1/poddisruptionbudgets')) ?? [];
    const issues = evaluatePdbs(list);
    return {
      issues,
      stats: [{ label: t('pdb.stat.count'), value: String(list.length) }, { label: t('pdb.stat.blocking'), value: String(issues.length), tone: issues.length ? 'warning' : 'ok' }],
      summary: issues.length ? t('pdb.summary.blocking', { n: issues.length }) : t('pdb.summary.ok', { n: list.length }),
    };
  }
}
