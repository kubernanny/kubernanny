import { distribution } from '../../discovery/discovery';
import { t } from '../../i18n/text';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult, Stat } from '../types';
import { DEPRECATED_APIS_QUERY, deprecatedApisFrom, evaluateDeprecatedApis, pendingRemovals } from './deprecated-apis';
import { evaluateKubernetesSupport } from './evaluate';
import { KUBERNETES_EOL } from './releases';

/**
 * Whether the cluster's Kubernetes minor still gets security fixes, and
 * whether anything still asks for APIs a coming release removes (from
 * Prometheus, when there is one). Reads nothing beyond /version.
 */
export class KubernetesSupportCheck extends CoreCheck {
  readonly id = 'kubernetes-support';
  override readonly uses = ['nodes'] as const;
  readonly name = t('module.kubernetes-support.name');
  // Already registered in the app (time-outline is one of its own icons), so no app change is needed.
  readonly icon = 'calendar-outline';
  readonly description = t('module.kubernetes-support.description');
  readonly reads = [];

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    const state = evaluateKubernetesSupport(ctx.inv.version?.gitVersion, ctx.now, distribution(ctx.inv));
    const newest = Math.max(...Object.keys(KUBERNETES_EOL).map(Number));
    const stats: Stat[] = [{ label: t('stat.version'), value: state.minor ?? '?' }];
    if (state.eol) {
      stats.push({
        label: t('kubernetesSupport.stat.eol'),
        value: t('kubernetesSupport.date', { date: state.eol }),
        tone: state.issues.length === 0 ? 'ok' : state.ended ? 'warning' : 'muted',
      });
    }
    stats.push({ label: t('kubernetesSupport.stat.newest'), value: `1.${newest}` });
    // Without Prometheus, or if it fails, the deprecation part is left out rather than failing the module.
    const samples = ctx.prom ? await ctx.prom.query(DEPRECATED_APIS_QUERY).catch(() => null) : null;
    const apis = samples ? deprecatedApisFrom(samples) : [];
    const deprecated = evaluateDeprecatedApis(apis, state.minor);
    if (samples) {
      const inUse = new Set(pendingRemovals(apis, state.minor).map((a) => `${a.group}/${a.version}/${a.resource}`))
        .size;
      stats.push({
        label: t('kubernetesSupport.stat.deprecated'),
        value: String(inUse),
        tone: deprecated.some((i) => i.severity === 'warning') ? 'warning' : 'ok',
      });
    }
    const issues = [...state.issues, ...deprecated];
    const summary =
      issues[0]?.title ??
      (state.minor === null
        ? t('kubernetesSupport.summary.noVersion')
        : state.eol
          ? t('kubernetesSupport.summary.ok', { date: state.eol })
          : t('kubernetesSupport.summary.unknown', { version: state.minor }));
    return { issues, stats, summary };
  }
}
