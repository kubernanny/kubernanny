import { Detected } from '../../discovery/discovery';
import { Integration } from '../module';
import { Issue } from '../../checks/types';
import { t } from '../../i18n/text';
import { ModuleContext, ModuleResult } from '../types';

export class GrafanaIntegration extends Integration {
  readonly id = 'grafana';
  readonly reads = [];
  override readonly untrusted = true;
  protected async inspect(ctx: ModuleContext, det: Detected): Promise<ModuleResult> {
    const g = this.http(ctx, det, [80, 3000, 'http-web', 'service', 'http']);
    if (!g) {
      return { issues: [], stats: [], summary: t('integration.noService') };
    }
    const health = await g.get<{ database?: string; version?: string }>('/api/health');
    const issues: Issue[] =
      health.database === 'ok'
        ? []
        : [
            {
              id: 'grafana/database',
              check: 'alertmanager',
              severity: 'warning',
              title: t('grafana.database.title'),
              cause: t('grafana.database.cause', { state: health.database }),
              actions: [],
            },
          ];
    return {
      issues,
      stats: [
        { label: t('stat.version'), value: health.version ?? det.version ?? '?' },
        { label: t('stat.database'), value: health.database ?? '?', tone: health.database === 'ok' ? 'ok' : 'warning' },
      ],
      summary: health.database === 'ok' ? t('grafana.summary.ok') : t('grafana.summary.noDatabase'),
    };
  }
}
