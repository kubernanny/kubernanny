import { DeviceView } from '../core/agent-client.service';
import { relativeTime } from '../core/format';
import { Translator } from '../i18n/translator';

export interface DeviceRow extends DeviceView {
  /** When it was paired and last seen, as one line. */
  meta: string;
}

/** The paired devices as the settings list shows them. */
export function deviceRows(devices: readonly DeviceView[], now: Date, tr: Translator): DeviceRow[] {
  return devices.map((d) => {
    const paired = relativeTime(d.createdAt, now, tr.lang);
    return {
      ...d,
      meta: d.lastSeenAt
        ? tr.t('form.deviceSeen', { paired, seen: relativeTime(d.lastSeenAt, now, tr.lang) })
        : tr.t('form.deviceUnseen', { paired }),
    };
  });
}
