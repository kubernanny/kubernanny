import { Detected } from '../../discovery/discovery';
import { Integration } from '../module';
import { Prometheus, ServiceHttp } from '../service-proxy';
import { ModuleContext } from '../types';
import { AlertmanagerIntegration } from './alertmanager';
import { ArgoCdIntegration } from './argocd';
import { CertManagerIntegration } from './cert-manager';
import { CnpgIntegration } from './cnpg';
import { ExternalSecretsIntegration } from './external-secrets';
import { FluxIntegration } from './flux';
import { GatusIntegration } from './gatus';
import { GrafanaIntegration } from './grafana';
import { InfisicalIntegration } from './infisical';
import { KuredIntegration } from './kured';
import { LokiIntegration } from './loki';
import { LonghornIntegration } from './longhorn';
import { MetricsServerIntegration } from './metrics-server';
import { PrometheusIntegration } from './prometheus';
import { SystemUpgradeControllerIntegration } from './system-upgrade-controller';
import { UptimeKumaIntegration } from './uptime-kuma';
import { VeleroIntegration } from './velero';
import { RookCephIntegration } from './rook-ceph';
import { TraefikIntegration } from './traefik';
import { IngressNginxIntegration } from './ingress-nginx';
import { TrivyIntegration } from './trivy';
import { KyvernoIntegration } from './kyverno';
import { GatekeeperIntegration } from './gatekeeper';

/**
 * Every deep check, one subclass of Integration per file. Adding one:
 * docs/DEVELOPMENT.md, "A new integration". Order matters little; the kured
 * integration fills the reboot lock the node check reads, and integrations
 * run before the core checks.
 */
export const INTEGRATIONS: readonly Integration[] = [
  new LonghornIntegration(),
  new CertManagerIntegration(),
  new ArgoCdIntegration(),
  new CnpgIntegration(),
  new PrometheusIntegration(),
  new AlertmanagerIntegration(),
  new GrafanaIntegration(),
  new LokiIntegration(),
  new KuredIntegration(),
  new SystemUpgradeControllerIntegration(),
  new VeleroIntegration(),
  new MetricsServerIntegration(),
  new FluxIntegration(),
  new ExternalSecretsIntegration(),
  new InfisicalIntegration(),
  new GatusIntegration(),
  new UptimeKumaIntegration(),
  new RookCephIntegration(),
  new TraefikIntegration(),
  new IngressNginxIntegration(),
  new KyvernoIntegration(),
  new GatekeeperIntegration(),
  new TrivyIntegration(),
];

export function findPrometheus(ctx: Omit<ModuleContext, 'prom'>, detected: Detected[]): Prometheus | null {
  if (ctx.config.prometheusUrl) {
    return new Prometheus(ServiceHttp.direct(ctx.kube, ctx.config.prometheusUrl));
  }
  const det = detected.find((d) => d.entry.id === 'prometheus');
  if (!det) {
    return null;
  }
  // prometheus-operated is headless and has no proxy port problem; prefer a
  // regular service on 9090 when there is one.
  const svc = [...det.services].sort((a, b) => Number(a.metadata.name.endsWith('-operated')) - Number(b.metadata.name.endsWith('-operated'))).find((s) => s.spec?.ports?.some((p) => p.port === 9090));
  const h = svc ? ServiceHttp.forService(ctx.kube, svc, [9090]) : null;
  return h ? new Prometheus(h) : null;
}
