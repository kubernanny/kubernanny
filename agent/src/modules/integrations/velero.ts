import { Integration } from '../module';
import { Condition, Issue, IssueAction, ageText } from '../../checks/types';
import { DetailMeta, DetailRow, ModuleContext, ModuleResult, Stat } from '../types';
import { listSection, sections } from '../details';
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
  override readonly actions = ['velero-backup'] as const;
  readonly reads = [{ group: 'velero.io', resource: 'backups', why: 'phase and age of the newest backup per schedule' }];
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const backups = (await ctx.kube.list<VeleroBackup>('/apis/velero.io/v1/backups')) ?? [];
    ctx.data.veleroBackups = backups;
    const bySchedule = newestBySchedule(backups);
    const issues: Issue[] = [];
    const stats: Stat[] = [];
    const rows: DetailRow[] = [];
    let newest = -Infinity;
    for (const [schedule, b] of bySchedule) {
      const name = schedule === MANUAL ? t('velero.manual') : raw(schedule);
      const phase = b.status?.phase ?? '?';
      const at = Date.parse(b.status?.completionTimestamp ?? b.metadata.creationTimestamp ?? '');
      const age = ctx.now.getTime() - at;
      // The newest run, and when it did not complete, the last one that did: "Lauf vor 4 h" and "letzter Erfolg vor 28 h" are both true.
      const meta: DetailMeta[] = [];
      if (Number.isFinite(at)) {
        meta.push({ text: phase === 'Completed' ? t('detail.backupAgo', { age: ageText(age) }) : t('detail.velero.ran', { age: ageText(age) }) });
      }
      if (phase !== 'Completed') {
        const ok = backups
          .filter((x) => (x.metadata.labels?.['velero.io/schedule-name'] ?? MANUAL) === schedule && x.status?.phase === 'Completed')
          .map((x) => Date.parse(x.status?.completionTimestamp ?? x.metadata.creationTimestamp ?? ''))
          .filter(Number.isFinite);
        meta.push(ok.length ? { text: t('detail.velero.lastSuccess', { age: ageText(ctx.now.getTime() - Math.max(...ok)) }) } : { text: t('detail.noBackup'), tone: 'warning' });
      }
      rows.push({ name, value: t('state.veleroPhase', { s: phase }), tone: phase === 'Completed' ? 'ok' : phase === 'Failed' ? 'critical' : 'warning', ...(meta.length ? { meta } : {}) });
      newest = Math.max(newest, Number.isFinite(at) ? at : -Infinity);
      // Like `velero backup create --from-schedule`: only for a schedule, in the namespace Velero keeps its backups in.
      const now: IssueAction[] = schedule === MANUAL ? [] : [{ type: 'velero-backup', namespace: b.metadata.namespace ?? 'velero', schedule }];
      if (phase === 'Failed' || phase === 'PartiallyFailed') {
        issues.push({
          id: `velero/${schedule}`,
          check: 'cnpg',
          severity: phase === 'Failed' ? 'critical' : 'warning',
          title: t('velero.failed.title', { schedule: name, phase: t('state.veleroPhase', { s: phase }) }),
          cause: rawOr(b.status?.failureReason, t('velero.failed.cause', { errors: b.status?.errors ?? 0, warnings: b.status?.warnings ?? 0, backup: b.metadata.name })),
          actions: now,
        });
      } else if (schedule !== MANUAL && Number.isFinite(at) && age > ctx.config.backupMaxAgeHours * 3_600_000) {
        issues.push({ id: `velero/${schedule}`, check: 'cnpg', severity: 'warning', title: t('velero.old.title', { schedule: name, age: ageText(age) }), cause: t('velero.old.cause'), actions: now });
      }
    }
    stats.push({ label: t('stat.schedules'), value: String([...bySchedule.keys()].filter((k) => k !== MANUAL).length) });
    if (Number.isFinite(newest)) {
      stats.push({ label: t('stat.lastBackup'), value: t('common.ago', { age: ageText(ctx.now.getTime() - newest) }) });
    }
    return { issues, stats, details: sections(listSection(t('detail.velero.schedules'), rows)), summary: issues.length === 0 ? t('velero.summary.ok', { n: bySchedule.size }) : issues[0].title };
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
