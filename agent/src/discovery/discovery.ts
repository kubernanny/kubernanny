import { WorkloadKind } from '../checks/types';
import type { CustomComponent } from '../config';
import { CronJob, Ingress, Inventory, Service, Workload } from '../inventory/inventory';
import { raw, t } from '../i18n/text';
import { CATALOG, CatalogEntry, Category } from './catalog';

export interface WorkloadRef {
  kind: WorkloadKind | 'CronJob';
  namespace: string;
  name: string;
  ready: number;
  desired: number;
}

export interface Link {
  label: string;
  url: string;
}

export interface Detected {
  entry: CatalogEntry;
  namespace: string;
  version?: string;
  /** The image the version was read from (the vulnerability check maps it to a package). */
  image?: string;
  workloads: WorkloadRef[];
  services: Service[];
  links: Link[];
}

export function readiness(kind: WorkloadKind, w: Workload): { ready: number; desired: number } {
  if (kind === 'DaemonSet') {
    return { ready: w.status?.numberReady ?? 0, desired: w.status?.desiredNumberScheduled ?? 0 };
  }
  return { ready: w.status?.readyReplicas ?? 0, desired: w.spec?.replicas ?? 1 };
}

export function allWorkloads(inv: Inventory): { kind: WorkloadKind; w: Workload }[] {
  return [
    ...inv.deployments.map((w) => ({ kind: 'Deployment' as const, w })),
    ...inv.statefulsets.map((w) => ({ kind: 'StatefulSet' as const, w })),
    ...inv.daemonsets.map((w) => ({ kind: 'DaemonSet' as const, w })),
  ];
}

export function imagesOf(w: Workload): string[] {
  const spec = w.spec?.template?.spec;
  return [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])].map((c) => c.image);
}

/** "ghcr.io/x/y:v1.2.3@sha256:…" -> "1.2.3" */
export function imageVersion(image: string): string | undefined {
  const noDigest = image.split('@')[0];
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  if (colon <= slash) {
    return undefined;
  }
  const tag = noDigest.slice(colon + 1);
  return tag === 'latest' ? tag : tag.replace(/^v(?=\d)/, '');
}

function selects(selector: Record<string, string> | undefined, labels: Record<string, string> | undefined): boolean {
  if (!selector || Object.keys(selector).length === 0 || !labels) {
    return false;
  }
  return Object.entries(selector).every(([k, v]) => labels[k] === v);
}

/** Services in the workload's namespace that route to its pods. */
export function servicesOf(inv: Inventory, namespace: string, podLabels: Record<string, string> | undefined): Service[] {
  return inv.services.filter((s) => s.metadata.namespace === namespace && selects(s.spec?.selector, podLabels));
}

/** Hosts in a Traefik match rule: Host(`a.example`) || Host(`b.example`, `c.example`). */
export function hostsInMatch(match: string | undefined): string[] {
  const hosts: string[] = [];
  for (const m of (match ?? '').matchAll(/Host\(([^)]*)\)/g)) {
    hosts.push(...[...m[1].matchAll(/`([^`]+)`/g)].map((h) => h[1]));
  }
  return hosts;
}

export function ingressUrls(inv: Inventory, services: Service[]): Link[] {
  const keys = new Set(services.map((s) => `${s.metadata.namespace}/${s.metadata.name}`));
  const links: Link[] = [];
  const seen = new Set<string>();
  const add = (url: string, host: string) => {
    if (!seen.has(url)) {
      seen.add(url);
      links.push({ label: host, url });
    }
  };
  // Gateway API: no TLS info on the route itself; the listener has it, so assume https.
  for (const route of inv.httpRoutes) {
    const ns = route.metadata.namespace;
    const backends = (route.spec?.rules ?? []).flatMap((r) => r.backendRefs ?? []).filter((b) => !b.kind || b.kind === 'Service');
    if (backends.some((b) => keys.has(`${b.namespace ?? ns}/${b.name}`))) {
      for (const host of route.spec?.hostnames ?? []) {
        add(`https://${host}`, host);
      }
    }
  }
  for (const route of inv.ingressRoutes) {
    const ns = route.metadata.namespace;
    for (const r of route.spec?.routes ?? []) {
      if ((r.services ?? []).some((s) => (!s.kind || s.kind === 'Service') && keys.has(`${s.namespace ?? ns}/${s.name}`))) {
        for (const host of hostsInMatch(r.match)) {
          add(`${route.spec?.tls ? 'https' : 'http'}://${host}`, host);
        }
      }
    }
  }
  for (const ing of inv.ingresses) {
    const tlsHosts = new Set((ing.spec?.tls ?? []).flatMap((t) => t.hosts ?? []));
    for (const rule of ing.spec?.rules ?? []) {
      if (!rule.host) {
        continue;
      }
      for (const path of rule.http?.paths ?? []) {
        const svc = path.backend?.service?.name;
        if (!svc || !keys.has(`${ing.metadata.namespace}/${svc}`)) {
          continue;
        }
        const scheme = tlsHosts.has(rule.host) ? 'https' : 'http';
        const p = path.path && path.path !== '/' ? path.path : '';
        const url = `${scheme}://${rule.host}${p}`;
        if (!seen.has(url)) {
          seen.add(url);
          links.push({ label: rule.host, url });
        }
      }
    }
  }
  return links;
}

export function hostsOf(ing: Ingress): string[] {
  return (ing.spec?.rules ?? []).map((r) => r.host).filter((h): h is string => Boolean(h));
}

/** Every catalog component that runs in the cluster, with its workloads, services and URLs. */
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Your own components as catalog entries, matched by image prefix (any tag or digest). */
export function customEntries(custom: CustomComponent[]): CatalogEntry[] {
  return custom.map((c) => ({
    id: c.id,
    name: c.name,
    category: c.category as Category,
    icon: c.icon,
    // The owner's own words when given, the same in every language.
    description: c.description ? raw(c.description) : t('component.custom'),
    custom: true,
    // The prefix must end at a boundary: "…/shop-api" matches "…/shop-api:1.2" and "…/shop-api@sha256:…",
    // never "…/shop-api-evil". A prefix ending in "/" matches a whole registry path.
    images: c.images.map((prefix) => new RegExp(prefix.endsWith('/') ? `^${escapeRe(prefix)}` : `^${escapeRe(prefix)}(?=[:@]|$)`)),
  }));
}

function cronImages(c: CronJob): string[] {
  const spec = c.spec?.jobTemplate?.spec?.template?.spec;
  return [...(spec?.containers ?? []), ...(spec?.initContainers ?? [])].map((x) => x.image);
}

/** Every catalog component that runs in the cluster, with its workloads, services and URLs. Your own components come first. */
export function discover(inv: Inventory, custom: CustomComponent[] = []): Detected[] {
  const catalog = [...customEntries(custom), ...CATALOG];
  const found = new Map<string, Detected>();
  const match = (images: string[]) => catalog.find((e) => images.some((i) => e.images.some((re) => re.test(i))));
  const record = (entry: CatalogEntry, namespace: string, images: string[], ref: WorkloadRef, podLabels: Record<string, string> | undefined) => {
    const det = found.get(entry.id) ?? ({ entry, namespace, workloads: [], services: [], links: [] } satisfies Detected);
    const image = images.find((i) => entry.images.some((re) => re.test(i)));
    if (det.version === undefined && image) {
      det.version = imageVersion(image);
      det.image = image;
    }
    det.workloads.push(ref);
    det.services.push(...servicesOf(inv, namespace, podLabels));
    found.set(entry.id, det);
  };
  for (const { kind, w } of allWorkloads(inv)) {
    const images = imagesOf(w);
    const entry = match(images);
    if (entry) {
      const namespace = w.metadata.namespace ?? 'default';
      record(entry, namespace, images, { kind, namespace, name: w.metadata.name, ...readiness(kind, w) }, w.spec?.template?.metadata?.labels);
    }
  }
  // Components that only run on a schedule (Descheduler, backup jobs, reports).
  for (const c of inv.cronjobs) {
    const images = cronImages(c);
    const entry = match(images);
    if (entry) {
      const namespace = c.metadata.namespace ?? 'default';
      record(entry, namespace, images, { kind: 'CronJob', namespace, name: c.metadata.name, ready: 0, desired: 0 }, undefined);
    }
  }
  for (const det of found.values()) {
    det.links = ingressUrls(inv, det.services);
  }
  const order = new Map(catalog.map((e, i) => [e.id, i]));
  return [...found.values()].sort((a, b) => order.get(a.entry.id)! - order.get(b.entry.id)!);
}

/** The cluster's distribution from the kubelet version string. */
export function distribution(inv: Inventory): string {
  const v = inv.nodes[0]?.status?.nodeInfo?.kubeletVersion ?? inv.version?.gitVersion ?? '';
  if (v.includes('+rke2')) {
    return 'RKE2';
  }
  if (v.includes('+k3s')) {
    return 'k3s';
  }
  if (v.includes('-eks')) {
    return 'EKS';
  }
  if (v.includes('-gke')) {
    return 'GKE';
  }
  if (inv.nodes.some((n) => n.metadata.labels?.['node.kubernetes.io/instance-type']?.startsWith('Standard_'))) {
    return 'AKS';
  }
  if (inv.nodes.some((n) => n.metadata.labels?.['node-role.kubernetes.io/control-plane'] !== undefined && n.metadata.name.startsWith('talos'))) {
    return 'Talos';
  }
  return 'Kubernetes';
}

/** Port of a service by name or number, falling back to its first one. */
export function servicePort(svc: Service, prefer: (number | string)[]): number | undefined {
  const ports = svc.spec?.ports ?? [];
  for (const p of prefer) {
    const hit = ports.find((x) => x.port === p || x.name === p);
    if (hit) {
      return hit.port;
    }
  }
  return ports[0]?.port;
}
