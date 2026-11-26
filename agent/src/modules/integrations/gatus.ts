import { evaluateGatus } from '../../checks/uptime.check';
import { Detected } from '../../discovery/discovery';
import { t } from '../../i18n/text';
import { KubeError } from '../../kube/kube-client';
import { Integration } from '../module';
import { ModuleContext, ModuleResult } from '../types';

/** A 401 or 403: Gatus was set up with authentication, which the agent never has. */
export function isAuthError(err: unknown): boolean {
  return (
    (err instanceof KubeError && (err.status === 401 || err.status === 403)) ||
    (err instanceof Error && /^40[13]\b/.test(err.message))
  );
}

/** Gatus' own verdict on the endpoints it watches (GET /api/v1/endpoints/statuses, read-only, no credentials). */
export class GatusIntegration extends Integration {
  readonly id = 'gatus';
  readonly reads = [];
  override readonly untrusted = true;

  protected async inspect(ctx: ModuleContext, det: Detected): Promise<ModuleResult> {
    const g = this.http(ctx, det, [8080, 'http', 'web']);
    if (!g) {
      return { issues: [], stats: [], summary: t('integration.noServiceOnPort', { port: 8080 }) };
    }
    let statuses: unknown;
    try {
      statuses = await g.get<unknown>('/api/v1/endpoints/statuses');
    } catch (err) {
      if (isAuthError(err)) {
        return {
          issues: [],
          stats: [{ label: t('uptime.stat.api'), value: t('gatus.protected'), tone: 'muted' }],
          summary: t('gatus.summary.protected'),
        };
      }
      throw err;
    }
    const { issues, up, down, other } = evaluateGatus(statuses);
    return {
      issues,
      stats: [
        { label: t('uptime.stat.up'), value: String(up), tone: 'ok' },
        { label: t('uptime.stat.down'), value: String(down), tone: down ? 'warning' : 'ok' },
        ...(other ? [{ label: t('uptime.stat.other'), value: String(other), tone: 'muted' as const }] : []),
      ],
      summary: issues[0]?.title ?? t('uptime.summary.ok', { n: up }),
    };
  }
}
