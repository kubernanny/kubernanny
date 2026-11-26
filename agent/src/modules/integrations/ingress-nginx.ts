import { t } from '../../i18n/text';
import { routeDetails } from '../details';
import { Integration } from '../module';
import { ModuleContext, ModuleResult } from '../types';
import { evaluateErrorRates, failingRoutes, noPrometheus, routeTraffic, trafficStats } from './ingress-errors';

/** Server errors per Ingress, from the controller's `nginx_ingress_controller_requests` (its metrics endpoint scraped by Prometheus). */
export class IngressNginxIntegration extends Integration {
  readonly id = 'ingress-nginx';
  readonly reads = [];
  override readonly untrusted = true;

  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    if (!ctx.prom) {
      return { ...noPrometheus(), summary: t('ingress.summary.noPrometheus') };
    }
    // Requests no Ingress matched carry an empty ingress label; they have no route to blame.
    const routes = await routeTraffic(
      ctx.prom,
      'nginx_ingress_controller_requests',
      ['namespace', 'ingress'],
      'status',
      'ingress!=""',
    );
    const issues = evaluateErrorRates(
      this.id,
      routes.filter((r) => r.route.includes('/')),
    );
    return {
      issues,
      stats: trafficStats(routes, issues),
      details: routeDetails(routes, failingRoutes(this.id, issues)),
      summary: issues[0]?.title ?? t('ingress.summary.ok', { n: routes.length }),
    };
  }
}
