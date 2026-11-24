import { raw, rawOr, t } from '../i18n/text';
import { Issue, Severity } from './types';

export interface AmAlert {
  labels: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
}

/** Alerts that always fire on purpose (kube-prometheus-stack). */
const IGNORED = new Set(['Watchdog', 'InfoInhibitor']);

/**
 * The cluster's own Prometheus rules, read from Alertmanager's v2 API
 * (active, not silenced, not inhibited). One issue per alert name, so a
 * silence in Alertmanager also quiets the app.
 */
export function evaluateAlerts(alerts: AmAlert[]): Issue[] {
  const groups = new Map<string, { severity: Severity; alerts: AmAlert[] }>();
  for (const alert of alerts) {
    const name = alert.labels.alertname;
    const sev = alert.labels.severity;
    if (!name || IGNORED.has(name) || (sev !== 'critical' && sev !== 'warning')) {
      continue;
    }
    const g = groups.get(name) ?? { severity: 'warning' as Severity, alerts: [] };
    if (sev === 'critical') {
      g.severity = 'critical';
    }
    g.alerts.push(alert);
    groups.set(name, g);
  }
  return [...groups.entries()].map(([name, g]) => {
    const first = g.alerts[0];
    const where = first.labels.namespace ?? first.labels.instance ?? first.labels.node;
    const text = first.annotations?.summary ?? first.annotations?.description ?? first.annotations?.message ?? '';
    return {
      id: `alertmanager/${name}`,
      check: 'alertmanager' as const,
      severity: g.severity,
      // Alert names and annotations are the rule author's words, the same in every language.
      title: raw(g.alerts.length > 1 ? `${name} (${g.alerts.length}×)` : `${name}${where ? ` (${where})` : ''}`),
      cause: rawOr(text, t('alerts.cause')),
      actions: [],
    };
  });
}
