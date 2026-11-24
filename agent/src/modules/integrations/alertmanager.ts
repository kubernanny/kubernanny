import { Detected } from '../../discovery/discovery';
import { Integration } from '../module';
import { AmAlert, evaluateAlerts } from '../../checks/alertmanager.check';
import { ServiceHttp } from '../service-proxy';
import {ModuleContext, ModuleResult } from '../types';
import { t } from '../../i18n/text';

export class AlertmanagerIntegration extends Integration {
  readonly id = 'alertmanager';
  readonly reads = [];
  override readonly untrusted = true;
  protected async inspect(ctx: ModuleContext, det: Detected): Promise<ModuleResult> {
    const am = ctx.config.alertmanagerUrl ? ServiceHttp.direct(ctx.kube, ctx.config.alertmanagerUrl) : this.http(ctx, det, [9093, 'web', 'http-web']);
    if (!am) {
      return { issues: [], stats: [], summary: t('integration.noServiceOnPort', { port: 9093 }) };
    }
    const [alerts, silences] = await Promise.all([
      am.get<AmAlert[]>('/api/v2/alerts?active=true&silenced=false&inhibited=false'),
      am.get<{ status?: { state?: string } }[]>('/api/v2/silences').catch(() => []),
    ]);
    const issues = evaluateAlerts(alerts);
    const active = silences.filter((s) => s.status?.state === 'active').length;
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
