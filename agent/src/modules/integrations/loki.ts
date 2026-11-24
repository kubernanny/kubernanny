import { Detected } from '../../discovery/discovery';
import { Integration } from '../module';
import { raw, t } from '../../i18n/text';
import { ModuleContext, ModuleResult, Stat } from '../types';

export class LokiIntegration extends Integration {
  readonly id = 'loki';
  readonly reads = [];
  override readonly untrusted = true;
  protected async inspect(ctx: ModuleContext, det: Detected): Promise<ModuleResult> {
    const l = this.http(ctx, det, [3100, 'http-metrics', 'http']);
    if (!l) {
      return { issues: [], stats: [], summary: t('integration.noServiceOnPort', { port: 3100 }) };
    }
    const ready = (await l.text('/ready').catch((e: Error) => e.message)).trim();
    const ok = ready === 'ready';
    const stats: Stat[] = [{ label: t('stat.ready'), value: ok ? t('common.yes') : ready.slice(0, 60), tone: ok ? 'ok' : 'warning' }];
    if (ctx.prom) {
      const rate = await ctx.prom.scalar('sum(rate(loki_distributor_lines_received_total[5m]))').catch(() => null);
      if (rate !== null) {
        stats.push({ label: t('loki.stat.linesPerSecond'), value: rate.toFixed(1) });
      }
    }
    return {
      issues: ok ? [] : [{ id: 'loki/ready', check: 'alertmanager', severity: 'warning', title: t('loki.notReady.title'), cause: raw(ready), actions: [] }],
      stats,
      summary: ok ? t('loki.summary.ok') : t('loki.summary.notReady'),
    };
  }
}
