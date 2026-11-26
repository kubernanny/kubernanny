import { t } from '../../i18n/text';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult } from '../types';
import { ACCEPT_ANNOTATION } from './accept-annotation';
import {
  cronJobTemplatePods,
  evaluateSecurityPosture,
  HOST_LEVEL_COMPONENTS,
  SecurityPod,
  SYSTEM_NAMESPACES,
} from './evaluate';

/** Security posture from the pod specs the run already read: no extra API calls, no extra RBAC. */
export class SecurityCheck extends CoreCheck {
  readonly id = 'security';
  readonly name = t('module.security.name');
  readonly icon = 'shield-half-outline';
  readonly description = t('module.security.description');
  readonly reads = [];

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    const cronOfJob = new Map<string, string>();
    for (const job of ctx.inv.jobs) {
      const cron = job.metadata.ownerReferences?.find((o) => o.kind === 'CronJob');
      if (cron) {
        cronOfJob.set(`${job.metadata.namespace}/${job.metadata.name}`, cron.name);
      }
    }
    const hostLevel = new Set(
      (ctx.detected ?? [])
        .filter((d) => HOST_LEVEL_COMPONENTS.has(d.entry.id))
        .flatMap((d) => d.workloads.map((w) => `${w.namespace}/${w.kind}/${w.name}`)),
    );
    const systemNamespaces = new Set([...SYSTEM_NAMESPACES, ...ctx.config.securitySystemNamespaces]);
    const pods = [...(ctx.inv.pods as SecurityPod[]), ...cronJobTemplatePods(ctx.inv.cronjobs)];
    // The workloads' own annotations; their pod templates' arrive on the pods.
    const workloadAccept = new Map<string, string>();
    for (const [kind, list] of [
      ['Deployment', ctx.inv.deployments],
      ['StatefulSet', ctx.inv.statefulsets],
      ['DaemonSet', ctx.inv.daemonsets],
      ['CronJob', ctx.inv.cronjobs],
    ] as const) {
      for (const w of list) {
        const value = w.metadata.annotations?.[ACCEPT_ANNOTATION];
        if (value) {
          workloadAccept.set(`${w.metadata.namespace ?? 'default'}/${kind}/${w.metadata.name}`, value);
        }
      }
    }
    const { issues, accepted } = evaluateSecurityPosture({
      pods,
      cronOfJob,
      systemNamespaces,
      hostLevel,
      workloadAccept,
    });
    const privileged = issues.filter((i) => i.severity === 'warning').length;
    const namespaces = new Set(issues.map((i) => i.id.split('/')[1])).size;
    return {
      issues,
      stats: [
        { label: t('security.stat.findings'), value: String(issues.length), tone: issues.length ? 'muted' : 'ok' },
        { label: t('security.stat.privileged'), value: String(privileged), tone: privileged ? 'warning' : 'ok' },
        { label: t('security.stat.namespaces'), value: String(namespaces) },
        { label: t('security.stat.exempt'), value: t('security.stat.exemptValue', { n: systemNamespaces.size }) },
      ],
      ...(accepted.length ? { acceptedFindings: accepted } : {}),
      summary:
        issues.length === 0
          ? accepted.length
            ? t('security.summary.okAccepted', { n: accepted.length })
            : t('security.summary.ok')
          : privileged > 0
            ? t('security.summary.privileged', { n: privileged })
            : t('security.summary.hints', { n: issues.length, namespaces }),
    };
  }
}
