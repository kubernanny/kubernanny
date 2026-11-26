import { endTime } from '../core/format';
import { Translator } from '../i18n/translator';

/** The hours the agent accepts for a maintenance window (MAINTENANCE_HOURS in agent/src/silence/silence.service.ts). */
export const MAINTENANCE_HOURS = [1, 2, 4, 8, 24] as const;

export interface MaintenanceVM {
  active: boolean;
  /** "Aktiv bis 14:30" / "Active until 2:30 PM"; empty while none is active. */
  status: string;
  /** "Wartung bis 14:30: keine Benachrichtigungen" for the overview; empty while none is active. */
  banner: string;
  /** The end as a time alone ("14:30", "Fr., 08:00"), for toasts. */
  time: string;
}

/** Whether a maintenance window holds back notifications, and until when; one that has ended reads as none. */
export function maintenanceView(
  until: string | null | undefined,
  now: Date,
  tr: Translator,
): MaintenanceVM {
  if (!until || Date.parse(until) <= now.getTime()) {
    return { active: false, status: '', banner: '', time: '' };
  }
  const time = endTime(until, now, tr.lang);
  return {
    active: true,
    status: tr.t('maintenance.active', { time }),
    banner: tr.t('maintenance.banner', { time }),
    time,
  };
}

/** The choices of the action sheet: "1 Stunde" … "24 Stunden". */
export function maintenanceChoices(tr: Translator): { hours: number; label: string }[] {
  return MAINTENANCE_HOURS.map((hours) => ({ hours, label: tr.n('maintenance.hours', hours) }));
}
