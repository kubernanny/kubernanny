import { Issue } from '../../checks/types';
import { t } from '../../i18n/text';
import { Prometheus } from '../service-proxy';
import { Stat } from '../types';

/**
 * 5xx share per route of an ingress controller over the last 15 minutes,
 * shared by the Traefik and ingress-nginx integrations.
 *
 * Only routes with real traffic count: at least MIN_REQUESTS requests and
 * MIN_ERRORS server errors in the window. On a quiet homelab a single bot
 * asking a stopped app would otherwise read as "50 % errors".
 *
 * - warning above 5 %: one request in twenty fails, far more than the 0.1 to
 *   1 % error budget a service usually has, and more than the few 502/503 a
 *   rolling update causes.
 * - critical above 25 %: one in four fails, which people notice; typically a
 *   backend down behind the route, or one of few replicas broken.
 */
const ERROR_WINDOW = '15m';
const MIN_REQUESTS = 200;
const MIN_ERRORS = 10;
const ERROR_WARNING = 0.05;
const ERROR_CRITICAL = 0.25;

export interface RouteTraffic {
  route: string;
  requests: number;
  errors: number;
}

/** One issue per route above the thresholds, worst first. `module` is the integration id, `kind` names a route in the title. */
export function evaluateErrorRates(module: string, routes: RouteTraffic[]): Issue[] {
  return routes
    .filter((r) => r.requests >= MIN_REQUESTS && r.errors >= MIN_ERRORS && r.errors / r.requests > ERROR_WARNING)
    .sort((a, b) => b.errors / b.requests - a.errors / a.requests)
    .map((r) => {
      const share = r.errors / r.requests;
      return {
        id: `${module}/errors/${r.route}`,
        check: module,
        severity: share > ERROR_CRITICAL ? 'critical' : 'warning',
        title: t('ingress.errors.title', { route: r.route, pct: Math.round(share * 100) }),
        cause: t('ingress.errors.cause', { errors: Math.round(r.errors), requests: Math.round(r.requests) }),
        actions: [],
      };
    });
}

/** The routes `evaluateErrorRates` reported, with their severity, for the sheet's route list. */
export function failingRoutes(module: string, issues: Issue[]): Map<string, 'critical' | 'warning'> {
  const prefix = `${module}/errors/`;
  return new Map(issues.filter((i) => i.id.startsWith(prefix) && i.severity !== 'info').map((i) => [i.id.slice(prefix.length), i.severity as 'critical' | 'warning']));
}

/** Requests and 5xx per route from two `sum by (label) (increase(...))` queries. */
export async function routeTraffic(prom: Prometheus, metric: string, by: string[], codeLabel: string, filter = ''): Promise<RouteTraffic[]> {
  const group = by.join(', ');
  const sel = (extra: string) => `{${[filter, extra].filter(Boolean).join(',')}}`;
  const [total, failed] = await Promise.all([
    prom.query(`sum by (${group}) (increase(${metric}${sel('')}[${ERROR_WINDOW}]))`),
    prom.query(`sum by (${group}) (increase(${metric}${sel(`${codeLabel}=~"5.."`)}[${ERROR_WINDOW}]))`),
  ]);
  const key = (m: Record<string, string>) => by.map((l) => m[l] ?? '').filter(Boolean).join('/');
  const errors = new Map(failed.map((s) => [key(s.metric), s.value]));
  return total.filter((s) => key(s.metric) !== '').map((s) => ({ route: key(s.metric), requests: s.value, errors: errors.get(key(s.metric)) ?? 0 }));
}

export function trafficStats(routes: RouteTraffic[], issues: Issue[]): Stat[] {
  const active = routes.filter((r) => r.requests >= MIN_REQUESTS);
  return [
    { label: t('ingress.stat.routes'), value: String(routes.length) },
    { label: t('ingress.stat.busy'), value: String(active.length), tone: 'muted' },
    { label: t('ingress.stat.failing'), value: String(issues.length), tone: issues.some((i) => i.severity === 'critical') ? 'critical' : issues.length ? 'warning' : 'ok' },
  ];
}

export function noPrometheus(): { issues: Issue[]; stats: Stat[] } {
  return { issues: [], stats: [{ label: t('ingress.stat.errorRates'), value: t('ingress.noPrometheus'), tone: 'muted' }] };
}
