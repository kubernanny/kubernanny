import { Integration } from '../module';
import { Condition, Issue, ageText } from '../../checks/types';
import {ModuleContext, ModuleResult, Stat } from '../types';
import { raw, rawOr, t } from '../../i18n/text';
import { Conditioned } from './util';

export interface VeleroBackup extends Conditioned {
  spec?: { storageLocation?: string };
  status?: { conditions?: Condition[]; phase?: string; completionTimestamp?: string; startTimestamp?: string; errors?: number; warnings?: number; failureReason?: string };
}

/** The key of backups made by hand, without a schedule. Part of issue ids, so it never changes with the language. */
export const MANUAL = '(manuell)';

export class VeleroIntegration extends Integration {
  readonly id = 'velero';
  readonly reads = [{ group: 'velero.io', resource: 'backups' }];
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const backups = (await ctx.kube.list<VeleroBackup>('/apis/velero.io/v1/backups')) ?? [];
    ctx.data.veleroBackups = backups;
    const bySchedule = newestBySchedule(backups);
    const issues: Issue[] = [];
    const stats: Stat[] = [];
    for (const [schedule, b] of bySchedule) {
      const name = schedule === MANUAL ? t('velero.manual') : raw(schedule);
      const phase = b.status?.phase ?? '?';
      const at = Date.parse(b.status?.completionTimestamp ?? b.metadata.creationTimestamp ?? '');
      const age = ctx.now.getTime() - at;
      stats.push({ label: name, value: t('velero.stat.value', { phase, age: ageText(age) }), tone: phase === 'Completed' ? 'ok' : 'warning' });
      if (phase === 'Failed' || phase === 'PartiallyFailed') {
        issues.push({
          id: `velero/${schedule}`,
          check: 'cnpg',
          severity: phase === 'Failed' ? 'critical' : 'warning',
          title: t('velero.failed.title', { schedule: name, phase }),
          cause: rawOr(b.status?.failureReason, t('velero.failed.cause', { errors: b.status?.errors ?? 0, warnings: b.status?.warnings ?? 0, backup: b.metadata.name })),
          actions: [],
        });
      } else if (schedule !== MANUAL && Number.isFinite(at) && age > ctx.config.backupMaxAgeHours * 3_600_000) {
        issues.push({ id: `velero/${schedule}`, check: 'cnpg', severity: 'warning', title: t('velero.old.title', { schedule: name, age: ageText(age) }), cause: t('velero.old.cause'), actions: [] });
      }
    }
    return { issues, stats, summary: issues.length === 0 ? t('velero.summary.ok', { n: bySchedule.size }) : issues[0].title };
  }
}

/** The newest backup of every schedule (manual ones under MANUAL); the check and the backups view judge that one. */
export function newestBySchedule(backups: VeleroBackup[]): Map<string, VeleroBackup> {
  const bySchedule = new Map<string, VeleroBackup>();
  for (const b of backups) {
    const key = b.metadata.labels?.['velero.io/schedule-name'] ?? MANUAL;
    const prev = bySchedule.get(key);
    if (!prev || (b.metadata.creationTimestamp ?? '') > (prev.metadata.creationTimestamp ?? '')) {
      bySchedule.set(key, b);
    }
  }
  return bySchedule;
}
