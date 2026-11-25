import { Integration } from '../module';
import { ArgoApplication, evaluateArgoApps, isAutomated } from '../../checks/argocd.check';
import { rollbackApps } from '../../checks/argocd-rollback';
import { t } from '../../i18n/text';
import { argoDetails } from '../details';
import { ModuleContext, ModuleResult } from '../types';

export class ArgoCdIntegration extends Integration {
  readonly id = 'argocd';
  // argocd-rollback is no issue action: it is offered on the sheet (`rollbacks`), for apps without a problem too.
  override readonly actions = ['argocd-sync', 'argocd-refresh', 'argocd-rollback', 'restart'] as const;
  readonly reads = [{ group: 'argoproj.io', resource: 'applications', why: 'sync and health status of every app' }];
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const apps = (await ctx.kube.list<ArgoApplication>('/apis/argoproj.io/v1alpha1/applications')) ?? [];
    const issues = evaluateArgoApps(apps, ctx.inv);
    const synced = apps.filter((a) => a.status?.sync?.status === 'Synced').length;
    const healthy = apps.filter((a) => a.status?.health?.status === 'Healthy').length;
    const progressing = apps.filter((a) => a.status?.health?.status === 'Progressing').length;
    const auto = apps.filter(isAutomated).length;
    // An OutOfSync manual app is the normal state of a manual app (a hint), not a warning.
    const drifting = apps.filter((a) => a.status?.sync?.status === 'OutOfSync' && isAutomated(a)).length;
    return {
      issues,
      stats: [
        { label: t('argocd.stat.apps'), value: String(apps.length) },
        { label: t('argocd.stat.synced'), value: `${synced}/${apps.length}`, tone: synced === apps.length ? 'ok' : drifting > 0 ? 'warning' : 'muted' },
        { label: t('argocd.stat.healthy'), value: `${healthy}/${apps.length}`, tone: healthy === apps.length ? 'ok' : progressing > 0 && healthy + progressing === apps.length ? 'muted' : 'critical' },
        { label: t('argocd.stat.automated'), value: `${auto}/${apps.length}` },
      ],
      details: argoDetails(apps, ctx.now),
      // Only while the action is on: a locked install shows no history at all.
      ...(ctx.rollbackOn ? { rollbacks: rollbackApps(apps) } : {}),
      // Hints (a manual app with a change waiting) are no problem: the line says they wait, in the same words as the list.
      summary: issues.some((i) => i.severity !== 'info')
        ? t('argocd.summary.problems', { outOfSync: drifting, unhealthy: apps.length - healthy - progressing })
        : synced < apps.length
          ? t('argocd.summary.waiting', { n: apps.length - synced })
          : t('argocd.summary.ok', { n: apps.length }),
    };
  }
}
