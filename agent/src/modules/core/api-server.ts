import { evaluateApiServerCertificate } from '../../checks/maintenance.check';
import { ageText } from '../../checks/types';
import { t } from '../../i18n/text';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult, Stat } from '../types';

export class ApiServerCheck extends CoreCheck {
  readonly id = 'apiserver';
  override readonly uses = [] as const;
  readonly name = t('module.apiserver.name');
  readonly icon = 'globe-outline';
  readonly description = t('module.apiserver.description');
  readonly reads = [];

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    const notAfter = await ctx.kube.apiServerCertificate();
    const issues = evaluateApiServerCertificate(notAfter, ctx.now);
    const stats: Stat[] = [{ label: t('stat.version'), value: ctx.inv.version?.gitVersion ?? '?' }];
    if (notAfter) {
      stats.push({
        label: t('apiserver.stat.certValidUntil'),
        value: notAfter.toISOString().slice(0, 10),
        tone: issues.length ? 'warning' : 'ok',
      });
    }
    return {
      issues,
      stats,
      summary: notAfter
        ? t('apiserver.summary.cert', { age: ageText(notAfter.getTime() - ctx.now.getTime()) })
        : t('apiserver.summary.reachable'),
    };
  }
}
