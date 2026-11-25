import { Integration } from '../module';
import { ArgoApplication, evaluateArgoApps } from '../../checks/argocd.check';
import { t } from '../../i18n/text';
import { ModuleContext, ModuleResult } from '../types';

export class ArgoCdIntegration extends Integration {
  readonly id = 'argocd';
  override readonly actions = ['argocd-sync', 'argocd-refresh', 'restart'] as const;
  readonly reads = [{ group: 'argoproj.io', resource: 'applications', why: 'sync and health status of every app' }];
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const apps = (await ctx.kube.list<ArgoApplication>('/apis/argoproj.io/v1alpha1/applications')) ?? [];
    const issues = evaluateArgoApps(apps, ctx.inv);
    const synced = apps.filter((a) => a.status?.sync?.status === 'Synced').length;
    const healthy = apps.filter((a) => a.status?.health?.status === 'Healthy').length;
    const progressing = apps.filter((a) => a.status?.health?.status === 'Progressing').length;
    const auto = apps.filter((a) => a.spec?.syncPolicy?.automated !== undefined).length;
    return {
      issues,
      stats: [
        { label: t('argocd.stat.apps'), value: String(apps.length) },
        { label: t('argocd.stat.synced'), value: `${synced}/${apps.length}`, tone: synced === apps.length ? 'ok' : 'warning' },
        { label: t('argocd.stat.healthy'), value: `${healthy}/${apps.length}`, tone: healthy === apps.length ? 'ok' : progressing > 0 && healthy + progressing === apps.length ? 'muted' : 'critical' },
        { label: t('argocd.stat.automated'), value: `${auto}/${apps.length}` },
      ],
      summary: issues.length === 0 ? t('argocd.summary.ok', { n: apps.length }) : t('argocd.summary.problems', { outOfSync: apps.length - synced, unhealthy: apps.length - healthy }),
    };
  }
}
