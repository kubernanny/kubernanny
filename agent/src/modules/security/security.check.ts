import { t } from '../../i18n/text';
import { CoreCheck } from '../module';
import { ModuleContext, ModuleResult } from '../types';
import {
  cronJobTemplatePods,
  evaluateSecurity,
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
    const issues = evaluateSecurity({ pods, cronOfJob, systemNamespaces, hostLevel });
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
      summary:
        issues.length === 0
          ? t('security.summary.ok')
          : privileged > 0
            ? t('security.summary.privileged', { n: privileged })
            : t('security.summary.hints', { n: issues.length, namespaces }),
    };
  }
}
