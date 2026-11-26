import { t } from '../../i18n/text';
import { Integration } from '../module';
import { ModuleContext, ModuleResult } from '../types';

export class MetricsServerIntegration extends Integration {
  readonly id = 'metrics-server';
  readonly reads = [];
  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    const ok = ctx.inv.nodeUsage !== null && ctx.inv.nodeUsage.size > 0;
    return {
      issues: ok
        ? []
        : [
            {
              id: 'metrics-server/api',
              check: 'nodes',
              severity: 'warning',
              title: t('metricsServer.noValues.title'),
              cause: t('metricsServer.noValues.cause'),
              actions: [],
            },
          ],
      stats: [
        {
          label: t('metricsServer.stat.nodes'),
          value: `${ctx.inv.nodeUsage?.size ?? 0}/${ctx.inv.nodes.length}`,
          tone: ok ? 'ok' : 'warning',
        },
      ],
      summary: ok ? t('metricsServer.summary.ok') : t('metricsServer.summary.none'),
    };
  }
}
