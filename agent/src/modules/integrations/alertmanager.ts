import { Detected } from '../../discovery/discovery';
import { Integration } from '../module';
import { AmAlert, evaluateAlerts } from '../../checks/alertmanager.check';
import { ServiceHttp } from '../service-proxy';
import {ModuleContext, ModuleResult } from '../types';
import { t } from '../../i18n/text';
import { list, record, strings } from '../untrusted';

export class AlertmanagerIntegration extends Integration {
  readonly id = 'alertmanager';
  readonly reads = [];
  override readonly untrusted = true;
  protected async inspect(ctx: ModuleContext, det: Detected): Promise<ModuleResult> {
    const am = ctx.config.alertmanagerUrl ? ServiceHttp.direct(ctx.kube, ctx.config.alertmanagerUrl) : this.http(ctx, det, [9093, 'web', 'http-web']);
    if (!am) {
      return { issues: [], stats: [], summary: t('integration.noServiceOnPort', { port: 9093 }) };
    }
    const [answer, silences] = await Promise.all([
      am.get<unknown>('/api/v2/alerts?active=true&silenced=false&inhibited=false'),
      am.get<unknown>('/api/v2/silences').catch(() => []),
    ]);
    const alerts = parseAlerts(answer);
    const issues = evaluateAlerts(alerts);
    const active = list(silences, MAX_ALERTS).filter((s) => record(record(s).status).state === 'active').length;
    const firing = alerts.filter((a) => a.labels.alertname !== 'Watchdog' && a.labels.alertname !== 'InfoInhibitor');
    return {
      issues,
      stats: [
        { label: t('alertmanager.stat.firing'), value: String(firing.length), tone: firing.length === 0 ? 'ok' : 'warning' },
        { label: t('alertmanager.stat.critical'), value: String(firing.filter((a) => a.labels.severity === 'critical').length) },
        { label: t('alertmanager.stat.silenced'), value: String(active), tone: 'muted' },
      ],
      summary: firing.length === 0 ? t('alertmanager.summary.none') : t('alertmanager.summary.firing', { n: firing.length }),
    };
  }
}

/** Alerts read: plenty for a homelab, and a forged answer of millions costs nothing past it. */
export const MAX_ALERTS = 2000;

/** Alertmanager's answer as alerts with string labels and annotations only. */
export function parseAlerts(answer: unknown): AmAlert[] {
  return list(answer, MAX_ALERTS).map((a) => {
    const alert = record(a);
    return { labels: strings(alert.labels), annotations: strings(alert.annotations) };
  });
}
