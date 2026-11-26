import { Issue } from '../../checks/types';
import { Detected } from '../../discovery/discovery';
import { t } from '../../i18n/text';
import { Integration } from '../module';
import { ModuleContext, ModuleResult } from '../types';
import { record, str } from '../untrusted';

export class GrafanaIntegration extends Integration {
  readonly id = 'grafana';
  readonly reads = [];
  override readonly untrusted = true;
  protected async inspect(ctx: ModuleContext, det: Detected): Promise<ModuleResult> {
    const g = this.http(ctx, det, [80, 3000, 'http-web', 'service', 'http']);
    if (!g) {
      return { issues: [], stats: [], summary: t('integration.noService') };
    }
    const answer = record(await g.get<unknown>('/api/health'));
    const health = { database: str(answer.database, 60), version: str(answer.version, 60) };
    const issues: Issue[] =
      health.database === 'ok'
        ? []
        : [
            {
              id: 'grafana/database',
              check: 'grafana',
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
