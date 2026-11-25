import { describe, expect, it } from 'vitest';
import { de } from '../../testing/i18n';
import { Prometheus, PromSample } from '../service-proxy';
import { ModuleContext } from '../types';
import { evaluateErrorRates, routeTraffic } from './ingress-errors';
import { IngressNginxIntegration } from './ingress-nginx';
import { TraefikIntegration } from './traefik';
import type { Detected } from '../../discovery/discovery';

/** Answers `sum by (…)` queries from a table: [labels, requests, 5xx]. */
function fakeProm(metric: string, rows: [Record<string, string>, number, number][]): Prometheus & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query(expr: string): Promise<PromSample[]> {
      queries.push(expr);
      if (!expr.includes(metric)) {
        return [];
      }
      return rows.map(([metric, total, errors]) => ({ metric, value: expr.includes('5..') ? errors : total }));
    },
  } as unknown as Prometheus & { queries: string[] };
}

const ctx = (prom: Prometheus | null) => ({ prom }) as unknown as ModuleContext;
const det = {} as Detected;

describe('evaluateErrorRates', () => {
  it('ignores quiet routes, however high their share', () => {
    expect(evaluateErrorRates('traefik', [{ route: 'r', requests: 199, errors: 150 }])).toEqual([]);
    expect(evaluateErrorRates('traefik', [{ route: 'r', requests: 5000, errors: 9 }])).toEqual([]);
  });

  it('warns above 5 % and is critical above 25 %, worst first', () => {
    const issues = evaluateErrorRates('traefik', [
      { route: 'a', requests: 1000, errors: 50 },
      { route: 'b', requests: 1000, errors: 51 },
      { route: 'c', requests: 1000, errors: 260 },
    ]);
    expect(issues.map((i) => [i.id, i.severity])).toEqual([
      ['traefik/errors/c', 'critical'],
      ['traefik/errors/b', 'warning'],
    ]);
    expect(de(issues[1]!.title)).toBe('b: 5 % Serverfehler');
  });
});

describe('Traefik and ingress-nginx', () => {
  it('without Prometheus check only the workloads, and say so', async () => {
    const r = await new TraefikIntegration().run(ctx(null), det, () => true);
    expect(r.issues).toEqual([]);
    expect(de(r.summary)).toBe('Ohne Prometheus nur die Pods geprüft');
  });

  it('Traefik reads router metrics, without its internal routers', async () => {
    const prom = fakeProm('traefik_router_requests_total', [[{ router: 'web@kubernetes' }, 1000, 400]]);
    const r = await new TraefikIntegration().run(ctx(prom), det, () => true);
    expect(r.issues.map((i) => [i.id, i.severity])).toEqual([['traefik/errors/web@kubernetes', 'critical']]);
    expect(prom.queries[0]).toBe('sum by (router) (increase(traefik_router_requests_total{router!~".*@internal"}[15m]))');
    expect(prom.queries[1]).toContain('code=~"5.."');
  });

  it('Traefik falls back to service metrics when routers carry no labels', async () => {
    const prom = fakeProm('traefik_service_requests_total', [[{ service: 'shop-api@kubernetes' }, 800, 80]]);
    const r = await new TraefikIntegration().run(ctx(prom), det, () => true);
    expect(r.issues.map((i) => i.id)).toEqual(['traefik/errors/shop-api@kubernetes']);
  });

  it('ingress-nginx groups by namespace and Ingress', async () => {
    const prom = fakeProm('nginx_ingress_controller_requests', [
      [{ namespace: 'shop', ingress: 'api' }, 600, 60],
      [{ namespace: 'shop', ingress: 'web' }, 600, 1],
    ]);
    const r = await new IngressNginxIntegration().run(ctx(prom), det, () => true);
    expect(r.issues.map((i) => [i.id, i.severity])).toEqual([['ingress-nginx/errors/shop/api', 'warning']]);
    expect(prom.queries[1]).toBe('sum by (namespace, ingress) (increase(nginx_ingress_controller_requests{ingress!="",status=~"5.."}[15m]))');
  });

  it('joins requests and errors per route', async () => {
    const prom = fakeProm('m', [[{ router: 'x' }, 10, 2]]);
    expect(await routeTraffic(prom, 'm', ['router'], 'code')).toEqual([{ route: 'x', requests: 10, errors: 2 }]);
  });
});
