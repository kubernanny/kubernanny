/** The Network tab: Ingresses, HTTPRoutes and Traefik IngressRoutes with their certificates, and LoadBalancer services. */
import { condition } from '../checks/types';
import { allWorkloads, Detected, hostsInMatch, hostsOf } from '../discovery/discovery';
import { Inventory } from '../inventory/inventory';
import { RunData } from '../modules/types';

export interface IngressView {
  namespace: string;
  name: string;
  hosts: string[];
  className?: string;
  tls: boolean;
  certificate?: { name: string; notAfter?: string; daysLeft: number | null; ready: boolean };
  backends: string[];
  /** The workloads behind the backend services ("Deployment/web"), found by the services' selectors. */
  workloads: string[];
  component?: string;
}

export interface NetworkView {
  ingresses: IngressView[];
  loadBalancers: { namespace: string; name: string; addresses: string[]; ports: string[] }[];
}

/** "Kind/name" of every workload in the namespace whose pods the service selects. */
function workloadsBehind(inv: Inventory, namespace: string, services: string[]): string[] {
  const out = new Set<string>();
  for (const name of services) {
    const svc = inv.services.find((s) => s.metadata.namespace === namespace && s.metadata.name === name);
    const selector = svc?.spec?.selector;
    if (!selector || Object.keys(selector).length === 0) {
      continue;
    }
    for (const { kind, w } of allWorkloads(inv)) {
      const labels = w.spec?.template?.metadata?.labels;
      if (
        (w.metadata.namespace ?? 'default') === namespace &&
        labels &&
        Object.entries(selector).every(([k, v]) => labels[k] === v)
      ) {
        out.add(`${kind}/${w.metadata.name}`);
      }
    }
  }
  return [...out].sort();
}

export function buildNetwork(inv: Inventory, data: RunData, detected: Detected[]): NetworkView {
  const certBySecret = new Map(
    (data.certificates ?? []).map((c) => [`${c.metadata.namespace}/${c.spec?.secretName}`, c]),
  );
  const componentOfService = new Map<string, string>();
  for (const d of detected) {
    for (const s of d.services) {
      componentOfService.set(`${s.metadata.namespace}/${s.metadata.name}`, d.entry.name);
    }
  }
  const ingresses: IngressView[] = inv.ingresses.map((ing) => {
    const ns = ing.metadata.namespace ?? 'default';
    const secret = ing.spec?.tls?.[0]?.secretName;
    // cert-manager's ingress-shim names the Certificate after the secret.
    const cert = secret ? certBySecret.get(`${ns}/${secret}`) : undefined;
    const notAfter = Date.parse(cert?.status?.notAfter ?? '');
    const backends = [
      ...new Set(
        (ing.spec?.rules ?? []).flatMap((r) =>
          (r.http?.paths ?? []).map(
            (p) =>
              `${p.backend?.service?.name ?? '?'}:${p.backend?.service?.port?.number ?? p.backend?.service?.port?.name ?? ''}`,
          ),
        ),
      ),
    ];
    const component = (ing.spec?.rules ?? [])
      .flatMap((r) => r.http?.paths ?? [])
      .map((p) => componentOfService.get(`${ns}/${p.backend?.service?.name}`))
      .find(Boolean);
    return {
      namespace: ns,
      name: ing.metadata.name,
      hosts: hostsOf(ing),
      className: ing.spec?.ingressClassName ?? ing.metadata.annotations?.['kubernetes.io/ingress.class'],
      tls: (ing.spec?.tls?.length ?? 0) > 0,
      certificate: cert
        ? {
            name: cert.metadata.name,
            notAfter: cert.status?.notAfter,
            daysLeft: Number.isFinite(notAfter) ? Math.floor((notAfter - inv.at.getTime()) / 86_400_000) : null,
            ready: condition(cert.status?.conditions, 'Ready')?.status === 'True',
          }
        : undefined,
      backends,
      workloads: workloadsBehind(
        inv,
        ns,
        (ing.spec?.rules ?? []).flatMap((r) => (r.http?.paths ?? []).map((p) => p.backend?.service?.name ?? '')),
      ),
      component,
    };
  });
  // Gateway API HTTPRoutes and Traefik IngressRoutes: the same view, the kind in the class column.
  for (const route of inv.httpRoutes) {
    const ns = route.metadata.namespace ?? 'default';
    const backends = (route.spec?.rules ?? []).flatMap((r) => r.backendRefs ?? []);
    ingresses.push({
      namespace: ns,
      name: route.metadata.name,
      hosts: route.spec?.hostnames ?? [],
      className: 'HTTPRoute',
      tls: true,
      certificate: undefined,
      backends: [...new Set(backends.map((b) => `${b.name}:${b.port ?? ''}`))],
      workloads: workloadsBehind(
        inv,
        ns,
        backends.filter((b) => !b.namespace || b.namespace === ns).map((b) => b.name),
      ),
      component: backends.map((b) => componentOfService.get(`${b.namespace ?? ns}/${b.name}`)).find(Boolean),
    });
  }
  for (const route of inv.ingressRoutes) {
    const ns = route.metadata.namespace ?? 'default';
    const services = (route.spec?.routes ?? []).flatMap((r) => r.services ?? []);
    const secret = (route.spec?.tls as { secretName?: string } | undefined)?.secretName;
    const cert = secret ? certBySecret.get(`${ns}/${secret}`) : undefined;
    const notAfter = Date.parse(cert?.status?.notAfter ?? '');
    ingresses.push({
      namespace: ns,
      name: route.metadata.name,
      hosts: [...new Set((route.spec?.routes ?? []).flatMap((r) => hostsInMatch(r.match)))],
      className: 'IngressRoute',
      tls: Boolean(route.spec?.tls),
      certificate: cert
        ? {
            name: cert.metadata.name,
            notAfter: cert.status?.notAfter,
            daysLeft: Number.isFinite(notAfter) ? Math.floor((notAfter - inv.at.getTime()) / 86_400_000) : null,
            ready: condition(cert.status?.conditions, 'Ready')?.status === 'True',
          }
        : undefined,
      backends: [...new Set(services.map((s) => `${s.name}:${s.port ?? ''}`))],
      workloads: workloadsBehind(
        inv,
        ns,
        services.filter((s) => !s.namespace || s.namespace === ns).map((s) => s.name),
      ),
      component: services.map((s) => componentOfService.get(`${s.namespace ?? ns}/${s.name}`)).find(Boolean),
    });
  }
  ingresses.sort((a, b) => (a.hosts[0] ?? a.name).localeCompare(b.hosts[0] ?? b.name));
  const loadBalancers = inv.services
    .filter((s) => s.spec?.type === 'LoadBalancer')
    .map((s) => ({
      namespace: s.metadata.namespace ?? 'default',
      name: s.metadata.name,
      addresses: (s.status?.loadBalancer?.ingress ?? []).map((i) => i.ip ?? i.hostname ?? '').filter(Boolean),
      ports: (s.spec?.ports ?? []).map((p) => `${p.port}/${p.protocol ?? 'TCP'}`),
    }));
  return { ingresses, loadBalancers };
}
