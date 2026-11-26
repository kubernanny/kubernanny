import { Detected } from '../../discovery/discovery';
import { raw, t } from '../../i18n/text';
import { bytes, decimal } from '../format';
import { Integration } from '../module';
import { ModuleContext, ModuleResult, Stat } from '../types';
import { str } from '../untrusted';

export class LokiIntegration extends Integration {
  readonly id = 'loki';
  readonly reads = [];
  override readonly untrusted = true;
  protected async inspect(ctx: ModuleContext, det: Detected): Promise<ModuleResult> {
    const l = this.http(ctx, det, [3100, 'http-metrics', 'http']);
    if (!l) {
      return { issues: [], stats: [], summary: t('integration.noServiceOnPort', { port: 3100 }) };
    }
    const ready = (str(await l.text('/ready').catch((e: Error) => e.message), 200) ?? '').trim();
    const ok = ready === 'ready';
    const stats: Stat[] = [
      { label: t('stat.ready'), value: ok ? t('common.yes') : ready.slice(0, 60), tone: ok ? 'ok' : 'warning' },
    ];
    if (ctx.prom) {
      const [rate, bytesRate, errors] = await Promise.all([
        ctx.prom.scalar('sum(rate(loki_distributor_lines_received_total[5m]))').catch(() => null),
        ctx.prom.scalar('sum(rate(loki_distributor_bytes_received_total[5m]))').catch(() => null),
        ctx.prom.scalar('sum(rate(loki_request_duration_seconds_count{status_code=~"5.."}[5m]))').catch(() => null),
      ]);
      if (rate !== null) {
        stats.push({ label: t('loki.stat.linesPerSecond'), value: decimal(rate) });
      }
      if (bytesRate !== null) {
        stats.push({ label: t('loki.stat.ingestion'), value: t('loki.perSecond', { size: bytes(bytesRate) }) });
      }
      if (errors !== null) {
        // Server errors per minute over the last 5 minutes: queries or pushes Loki failed.
        stats.push({ label: t('loki.stat.errors'), value: decimal(errors * 60), tone: errors > 0 ? 'warning' : 'ok' });
      }
    }
    return {
      issues: ok
        ? []
        : [
            {
              id: 'loki/ready',
              check: 'loki',
              severity: 'warning',
              title: t('loki.notReady.title'),
              cause: raw(ready),
              actions: [],
            },
          ],
      stats,
      summary: ok ? t('loki.summary.ok') : t('loki.summary.notReady'),
    };
  }
}
