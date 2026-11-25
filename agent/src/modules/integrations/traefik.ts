import { t } from '../../i18n/text';
import { Integration } from '../module';
import { ModuleContext, ModuleResult } from '../types';
import { evaluateErrorRates, failingRoutes, noPrometheus, routeTraffic, trafficStats } from './ingress-errors';
import { routeDetails } from '../details';

/**
 * Server errors per Traefik router, from Traefik's own Prometheus metrics.
 * Router metrics need `metrics.prometheus.addRoutersLabels` (off by
 * default); without them the service metrics (on by default) are used.
 * Traefik's own routers (`…@internal`: dashboard, ping, metrics) are left out.
 */
export class TraefikIntegration extends Integration {
  readonly id = 'traefik';
  readonly reads = [];
  // Prometheus is plain HTTP inside the cluster: no actions, and none are offered anyway.
  override readonly untrusted = true;

  protected async inspect(ctx: ModuleContext): Promise<ModuleResult> {
    if (!ctx.prom) {
      return { ...noPrometheus(), summary: t('ingress.summary.noPrometheus') };
    }
    const internal = 'router!~".*@internal"';
    let routes = await routeTraffic(ctx.prom, 'traefik_router_requests_total', ['router'], 'code', internal);
    if (routes.length === 0) {
      routes = await routeTraffic(ctx.prom, 'traefik_service_requests_total', ['service'], 'code', 'service!~".*@internal"');
    }
    const issues = evaluateErrorRates(this.id, routes);
    return { issues, stats: trafficStats(routes, issues), details: routeDetails(routes, failingRoutes(this.id, issues)), summary: issues[0]?.title ?? t('ingress.summary.ok', { n: routes.length }) };
  }
}
