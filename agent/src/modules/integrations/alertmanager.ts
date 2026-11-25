import { Detected } from '../../discovery/discovery';
import { Integration } from '../module';
import { AmAlert, evaluateAlerts } from '../../checks/alertmanager.check';
import { ServiceHttp } from '../service-proxy';
import { DetailRow, DetailSection, ModuleContext, ModuleResult, Tone } from '../types';
import { listSection, sections } from '../details';
import { ageText } from '../../checks/types';
import { raw, t } from '../../i18n/text';
import { list, record, str, strings } from '../untrusted';
import { recordFiringAlerts } from '../core/standard-alerts/alertmanager-dedupe';

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
    // Alerts Kubernanny raises itself are merged into its own issue after the run (core/standard-alerts/alertmanager-dedupe.ts).
    recordFiringAlerts(ctx.data, alerts);
    const activeSilences = list(silences, MAX_ALERTS).map(record).filter((s) => record(s.status).state === 'active');
    const active = activeSilences.length;
    const firing = alerts.filter((a) => a.labels.alertname !== 'Watchdog' && a.labels.alertname !== 'InfoInhibitor');
    return {
      issues,
      details: alertmanagerDetails(firing, activeSilences, ctx.now),
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

const SEVERITY_TONE: Record<string, Tone> = { critical: 'critical', warning: 'warning' };

/** Firing alerts grouped by name (how many, which severity, where), and the active silences with who set them and until when. */
export function alertmanagerDetails(firing: AmAlert[], silences: Record<string, unknown>[], now: Date): DetailSection[] {
  const groups = new Map<string, AmAlert[]>();
  for (const a of firing) {
    const name = a.labels.alertname ?? '?';
    groups.set(name, [...(groups.get(name) ?? []), a]);
  }
  const alertRows: DetailRow[] = [...groups.entries()].map(([name, list]) => {
    const severity = list.some((a) => a.labels.severity === 'critical') ? 'critical' : list[0]?.labels.severity ?? '';
    const where = [...new Set(list.map((a) => a.labels.namespace ?? a.labels.instance ?? a.labels.node).filter(Boolean))].slice(0, 3);
    const summary = list[0]?.annotations?.summary ?? list[0]?.annotations?.description;
    return {
      name,
      ...(summary ? { sub: raw(summary) } : {}),
      value: raw(severity ? `${list.length} × ${severity}` : String(list.length)),
      tone: SEVERITY_TONE[severity] ?? 'muted',
      ...(where.length ? { meta: [{ text: raw(where.join(', ')) }] } : {}),
    };
  });
  const silenceRows: DetailRow[] = silences.map((s) => {
    const matchers = list(s.matchers, 10)
      .map((m) => record(m))
      .map((m) => `${str(m.name, 60) ?? '?'}${m.isEqual === false ? '!' : ''}${m.isRegex ? '=~' : '='}${str(m.value, 80) ?? ''}`)
      .join(', ');
    const ends = Date.parse(str(s.endsAt, 64) ?? '');
    const by = str(s.createdBy, 80);
    const comment = str(s.comment, 200);
    return {
      name: matchers || '?',
      ...(comment ? { sub: raw(comment) } : {}),
      ...(Number.isFinite(ends) ? { value: t('detail.alertmanager.until', { age: ageText(Math.max(60_000, ends - now.getTime())) }) } : {}),
      tone: 'muted',
      ...(by ? { meta: [{ text: t('detail.alertmanager.by', { by }) }] } : {}),
    };
  });
  return sections(listSection(t('detail.alertmanager.firing'), alertRows), listSection(t('detail.alertmanager.silences'), silenceRows));
}
