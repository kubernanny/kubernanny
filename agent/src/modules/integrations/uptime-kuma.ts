import { evaluateUptimeKuma } from '../../checks/uptime.check';
import { Detected } from '../../discovery/discovery';
import { t } from '../../i18n/text';
import { Integration } from '../module';
import { ModuleContext, ModuleResult } from '../types';
import { isAuthError } from './gatus';

/**
 * Uptime Kuma has no read API without credentials: its `/metrics` needs an
 * API key (and can be switched off), its Socket.IO API a login. What is open
 * is a published status page, so the module reads the one named in
 * UPTIME_KUMA_STATUS_PAGE (the same two calls the status page makes in a
 * browser). Without it, only the pods count.
 */
export class UptimeKumaIntegration extends Integration {
  readonly id = 'uptime-kuma';
  readonly reads = [];
  override readonly untrusted = true;

  protected async inspect(ctx: ModuleContext, det: Detected): Promise<ModuleResult> {
    const slug = ctx.config.uptimeKumaStatusPage;
    const ready = det.workloads.reduce((s, w) => s + Math.min(w.ready, w.desired), 0);
    const total = det.workloads.reduce((s, w) => s + w.desired, 0);
    if (!slug) {
      return {
        issues: [],
        stats: [{ label: t('uptimeKuma.stat.statusPage'), value: t('uptimeKuma.stat.notConfigured'), tone: 'muted' }],
        summary: ready === total ? t('workloadHealth.ready', { n: ready }) : t('workloadHealth.partial', { ready, total }),
      };
    }
    const k = this.http(ctx, det, [3001, 'http']);
    if (!k) {
      return { issues: [], stats: [], summary: t('integration.noServiceOnPort', { port: 3001 }) };
    }
    let page: unknown;
    let beats: unknown;
    try {
      [page, beats] = await Promise.all([k.get<unknown>(`/api/status-page/${slug}`), k.get<unknown>(`/api/status-page/heartbeat/${slug}`)]);
    } catch (err) {
      if (isAuthError(err)) {
        return { issues: [], stats: [{ label: t('uptimeKuma.stat.statusPage'), value: slug }, { label: t('uptime.stat.api'), value: t('gatus.protected'), tone: 'muted' }], summary: t('gatus.summary.protected') };
      }
      throw err;
    }
    const { issues, up, down, other } = evaluateUptimeKuma(page, beats);
    return {
      issues,
      stats: [
        { label: t('uptimeKuma.stat.statusPage'), value: slug },
        { label: t('uptime.stat.up'), value: String(up), tone: 'ok' },
        { label: t('uptime.stat.down'), value: String(down), tone: down ? 'warning' : 'ok' },
        ...(other ? [{ label: t('uptime.stat.other'), value: String(other), tone: 'muted' as const }] : []),
      ],
      summary: issues[0]?.title ?? t('uptimeKuma.summary.ok', { n: up }),
    };
  }
}
