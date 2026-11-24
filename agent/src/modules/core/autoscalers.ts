import { evaluateHpas, Hpa } from '../../checks/maintenance.check';
import { t } from '../../i18n/text';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult } from '../types';

export class HpaCheck extends CoreCheck {
  readonly id = 'hpa';
  readonly name = t('module.hpa.name');
  readonly icon = 'swap-vertical-outline';
  readonly description = t('module.hpa.description');
  readonly reads = [{ group: 'autoscaling', resource: 'horizontalpodautoscalers' }];

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    const list = (await ctx.kube.list<Hpa>('/apis/autoscaling/v2/horizontalpodautoscalers')) ?? [];
    const issues = evaluateHpas(list);
    const atMax = list.filter((h) => (h.status?.currentReplicas ?? 0) >= (h.spec?.maxReplicas ?? Infinity)).length;
    return {
      issues,
      stats: [{ label: t('hpa.stat.count'), value: String(list.length) }, { label: t('hpa.stat.atMax'), value: String(atMax), tone: atMax ? 'muted' : 'ok' }],
      summary: issues.length ? t('hpa.summary.problems', { n: issues.length }) : t('hpa.summary.ok', { n: list.length }),
    };
  }
}
