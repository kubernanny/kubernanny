import { KubeClient, KubeError } from '../kube/kube-client';
import { HINT_DAYS } from '../modules/kubernetes-support/evaluate';
import { KUBERNETES_EOL } from '../modules/kubernetes-support/releases';

/**
 * A made-up homelab cluster (three RKE2 servers, Longhorn, Argo CD, CNPG,
 * kube-prometheus-stack, Loki, kured …) with a handful of realistic problems.
 * `DEMO=1` runs the agent against it, so the app can be tried, screenshotted
 * and reviewed without a cluster. The tests use it too.
 */

type Obj = Record<string, unknown>;

/**
 * broken: three outages and a dozen warnings (the default for DEMO=1).
 * warning: runs, but a certificate, a sync and a backup want attention.
 * healthy: everything green.
 */
export type DemoScenario = 'broken' | 'warning' | 'healthy';

export function demoScenario(value: string | undefined): DemoScenario {
  return value === 'warning' || value === 'healthy' ? value : 'broken';
}

const NODES = [
  { name: 'rke2-node-1', ip: '10.0.0.1', cpu: '4', mem: '15Gi', usedCpu: 1730, usedMem: 11.2 },
  { name: 'rke2-node-4', ip: '10.0.0.4', cpu: '8', mem: '31Gi', usedCpu: 2410, usedMem: 18.9 },
  { name: 'rke2-node-5', ip: '10.0.0.5', cpu: '4', mem: '15Gi', usedCpu: 1260, usedMem: 13.9 },
];

interface WorkloadSpec {
  kind: 'Deployment' | 'StatefulSet' | 'DaemonSet';
  ns: string;
  name: string;
  image: string;
  replicas?: number;
  ready?: number;
  ports?: { port: number; name?: string }[];
  host?: string;
  cpu?: string;
  mem?: string;
  crash?: { reason: string; restarts: number; message?: string };
  pvc?: { size: string; class: string };
  /** Broken scenario only: no securityContext and no memory limit, for the security posture check. */
  loose?: boolean;
  /** Runs in the broken scenario only (Gatus, Uptime Kuma), so the others keep their reviewed shape. */
  brokenOnly?: boolean;
}

const W: WorkloadSpec[] = [
  // kube-system
  { kind: 'DaemonSet', ns: 'kube-system', name: 'rke2-canal', image: 'rancher/hardened-calico:v3.29.1-build20250218' },
  { kind: 'Deployment', ns: 'kube-system', name: 'rke2-coredns-rke2-coredns', image: 'rancher/hardened-coredns:v1.12.0-build20250218', replicas: 2, ports: [{ port: 53, name: 'udp-53' }] },
  { kind: 'Deployment', ns: 'kube-system', name: 'rke2-metrics-server', image: 'rancher/hardened-k8s-metrics-server:v0.7.2-build20250218', ports: [{ port: 443 }] },
  { kind: 'DaemonSet', ns: 'kube-system', name: 'rke2-traefik', image: 'rancher/mirrored-library-traefik:3.3.6', ports: [{ port: 80, name: 'web' }, { port: 443, name: 'websecure' }] },
  { kind: 'DaemonSet', ns: 'kube-system', name: 'kured', image: 'ghcr.io/kubereboot/kured:1.17.1' },
  { kind: 'Deployment', ns: 'system-upgrade', name: 'system-upgrade-controller', image: 'rancher/system-upgrade-controller:v0.15.2' },
  // storage
  { kind: 'DaemonSet', ns: 'longhorn-system', name: 'longhorn-manager', image: 'longhornio/longhorn-manager:v1.9.0', ports: [{ port: 9500, name: 'manager' }] },
  { kind: 'Deployment', ns: 'longhorn-system', name: 'longhorn-ui', image: 'longhornio/longhorn-ui:v1.9.0', replicas: 2, ports: [{ port: 80, name: 'http' }], host: 'longhorn.home.example' },
  { kind: 'Deployment', ns: 'local-path-storage', name: 'local-path-provisioner', image: 'rancher/local-path-provisioner:v0.0.31' },
  // gitops
  { kind: 'StatefulSet', ns: 'argocd', name: 'argocd-application-controller', image: 'quay.io/argoproj/argocd:v3.1.2' },
  { kind: 'Deployment', ns: 'argocd', name: 'argocd-server', image: 'quay.io/argoproj/argocd:v3.1.2', ports: [{ port: 80, name: 'http' }], host: 'argo.home.example' },
  { kind: 'Deployment', ns: 'argocd', name: 'argocd-repo-server', image: 'quay.io/argoproj/argocd:v3.1.2' },
  { kind: 'Deployment', ns: 'argocd', name: 'argocd-image-updater', image: 'quay.io/argoprojlabs/argocd-image-updater:v0.17.0' },
  // certificates & secrets
  { kind: 'Deployment', ns: 'cert-manager', name: 'cert-manager', image: 'quay.io/jetstack/cert-manager-controller:v1.18.2' },
  { kind: 'Deployment', ns: 'infisical', name: 'infisical', image: 'infisical/infisical:v0.130.0', ports: [{ port: 8080 }], host: 'secrets.home.example' },
  { kind: 'Deployment', ns: 'infisical', name: 'infisical-operator', image: 'infisical/kubernetes-operator:v0.9.4' },
  // databases
  // 1.26.1 has a known critical advisory (fixed in 1.28.3): the broken scenario runs it, the others the fix.
  { kind: 'Deployment', ns: 'cnpg-system', name: 'cnpg-controller-manager', image: 'ghcr.io/cloudnative-pg/cloudnative-pg:1.26.1' },
  { kind: 'StatefulSet', ns: 'default', name: 'shop-api-valkey', image: 'valkey/valkey:8.1-alpine', ports: [{ port: 6379 }], pvc: { size: '2Gi', class: 'longhorn' } },
  // monitoring
  { kind: 'StatefulSet', ns: 'monitoring', name: 'prometheus-monitoring-chart-kube-prom-prometheus', image: 'quay.io/prometheus/prometheus:v3.5.0', ports: [{ port: 9090, name: 'http-web' }], cpu: '200m', mem: '1Gi', pvc: { size: '50Gi', class: 'longhorn' } },
  { kind: 'StatefulSet', ns: 'monitoring', name: 'alertmanager-monitoring-chart-kube-prom-alertmanager', image: 'quay.io/prometheus/alertmanager:v0.28.1', ports: [{ port: 9093, name: 'http-web' }], host: 'alertmanager.home.example' },
  { kind: 'Deployment', ns: 'monitoring', name: 'monitoring-chart-grafana', image: 'docker.io/grafana/grafana:12.1.0', ports: [{ port: 80, name: 'http-web' }], host: 'monitoring.home.example', pvc: { size: '10Gi', class: 'longhorn' } },
  { kind: 'Deployment', ns: 'monitoring', name: 'monitoring-chart-kube-state-metrics', image: 'registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.16.0' },
  { kind: 'DaemonSet', ns: 'monitoring', name: 'monitoring-chart-prometheus-node-exporter', image: 'quay.io/prometheus/node-exporter:v1.9.1' },
  { kind: 'Deployment', ns: 'monitoring', name: 'monitoring-chart-prometheus-blackbox-exporter', image: 'quay.io/prometheus/blackbox-exporter:v0.27.0' },
  { kind: 'Deployment', ns: 'monitoring', name: 'gatus', image: 'twinproduction/gatus:v5.17.0', ports: [{ port: 8080, name: 'http' }], brokenOnly: true },
  { kind: 'StatefulSet', ns: 'monitoring', name: 'uptime-kuma', image: 'louislam/uptime-kuma:1.23.16', ports: [{ port: 3001, name: 'http' }], brokenOnly: true },
  { kind: 'StatefulSet', ns: 'monitoring', name: 'loki', image: 'docker.io/grafana/loki:3.5.3', ports: [{ port: 3100, name: 'http-metrics' }], pvc: { size: '30Gi', class: 'longhorn' } },
  { kind: 'DaemonSet', ns: 'monitoring', name: 'promtail', image: 'docker.io/grafana/promtail:3.5.3' },
  // apps
  { kind: 'Deployment', ns: 'default', name: 'shop-api-chart', image: 'ghcr.io/acme/shop-api:2026-11-24-412', replicas: 3, ports: [{ port: 3000 }], host: 'api.shop.example', cpu: '250m', mem: '512Mi' },
  { kind: 'Deployment', ns: 'default', name: 'shop-web-app-chart', image: 'ghcr.io/acme/shop-web-app:2026-11-24-118', replicas: 2, ports: [{ port: 4000 }], host: 'shop.example' },
  { kind: 'Deployment', ns: 'default', name: 'shop-mcp-chart', image: 'ghcr.io/acme/shop-mcp:2026-06-02-0', replicas: 2, ports: [{ port: 8787 }], host: 'mcp.shop.example' },
  { kind: 'Deployment', ns: 'default', name: 'social-importer', image: 'ghcr.io/acme/social-importer:2026-11-20-3', crash: { reason: 'CrashLoopBackOff', restarts: 14, message: 'back-off 5m0s restarting failed container' } },
  { kind: 'StatefulSet', ns: 'weblate', name: 'weblate', image: 'weblate/weblate:5.13.0', ports: [{ port: 8080 }], host: 'translate.shop.example', pvc: { size: '20Gi', class: 'longhorn' } },
  { kind: 'Deployment', ns: 'discourse', name: 'discourse', image: 'docker.io/bitnami/discourse:3.4.6', replicas: 2, ready: 1, ports: [{ port: 3000 }], host: 'community.shop.example' },
  { kind: 'Deployment', ns: 'pgadmin', name: 'pgadmin', image: 'dpage/pgadmin4:9.6', ports: [{ port: 80 }], host: 'pgadmin.home.example', loose: true },
  { kind: 'Deployment', ns: 'velero', name: 'velero', image: 'velero/velero:v1.16.2' },
  { kind: 'Deployment', ns: 'kubernanny', name: 'kubernanny', image: 'ghcr.io/kubernanny/agent:0.2.0', ports: [{ port: 80, name: 'http' }], host: 'kubernanny.home.example' },
];

const CNPG = [
  { ns: 'default', name: 'shop-api-pg', instances: 2, ready: 2, backupHoursAgo: 31, archiving: true },
  { ns: 'infisical', name: 'infisical-pg', instances: 2, ready: 2, backupHoursAgo: 9, archiving: true },
  { ns: 'discourse', name: 'discourse-pg', instances: 2, ready: 1, backupHoursAgo: 10, archiving: true },
];

const ARGO_APPS: [string, string, string, boolean][] = [
  ['argocd-chart', 'Synced', 'Healthy', true],
  ['cert-manager-chart', 'Synced', 'Healthy', false],
  ['cloudnativepg-chart', 'Synced', 'Healthy', false],
  ['longhorn-chart', 'Synced', 'Healthy', false],
  ['monitoring-chart', 'Synced', 'Healthy', true],
  ['loki-chart', 'Synced', 'Healthy', false],
  ['shop-api-chart', 'Synced', 'Healthy', true],
  ['shop-web-app-chart', 'Synced', 'Healthy', false],
  ['shop-mcp-chart', 'Synced', 'Healthy', true],
  ['social-importer-chart', 'Synced', 'Degraded', true],
  ['weblate-chart', 'OutOfSync', 'Healthy', false],
  ['discourse-new', 'Synced', 'Progressing', false],
  ['kured-chart', 'Synced', 'Healthy', true],
  ['kubernanny-chart', 'Synced', 'Healthy', false],
];

const CERTS: [string, string, string, number][] = [
  ['default', 'shop-app-tls', 'shop.example', 61],
  ['default', 'shop-api-chart-tls', 'api.shop.example', 44],
  ['default', 'shop-mcp-chart-tls', 'mcp.shop.example', 52],
  ['weblate', 'weblate-tls', 'translate.shop.example', 9],
  ['discourse', 'discourse-tls', 'community.shop.example', 70],
  ['monitoring', 'monitoring.home.example-tls', 'monitoring.home.example', 33],
  ['monitoring', 'alertmanager.home.example-tls', 'alertmanager.home.example', 33],
  ['argocd', 'argo.home.example-tls', 'argo.home.example', 58],
  ['longhorn-system', 'longhorn.home.example-tls', 'longhorn.home.example', 47],
  ['infisical', 'secrets.home.example-tls', 'secrets.home.example', 40],
  ['pgadmin', 'pgadmin.home.example-tls', 'pgadmin.home.example', 29],
  ['kubernanny', 'kubernanny.home.example-tls', 'kubernanny.home.example', 88],
];

/** What a carefully installed chart sets; the security posture check finds nothing to say about it. */
const HARDENED = { runAsNonRoot: true, runAsUser: 1000 };

/**
 * The Kubernetes minor of the healthy and warning clusters: one the
 * end-of-life table calls maintained for a while yet, whatever today is, so
 * the kubernetes-support check stays quiet there. Broken runs 1.33, which
 * ended in June 2026.
 */
export function maintainedMinor(now: Date): number {
  const known = Object.entries(KUBERNETES_EOL)
    .map(([minor, eol]) => [Number(minor), Date.parse(`${eol}T00:00:00Z`)] as const)
    .sort((a, b) => a[0] - b[0]);
  return known.find(([, eol]) => eol - now.getTime() > (HINT_DAYS + 30) * 86_400_000)?.[0] ?? known[known.length - 1]![0] + 1;
}

const hash = (s: string) => {
  let h = 0;
  for (const c of s) {
    h = (h * 31 + c.charCodeAt(0)) >>> 0;
  }
  return h;
};

export function buildDemoCluster(now: Date, scenario: DemoScenario = 'broken'): Map<string, unknown> {
  const broken = scenario === 'broken';
  const warn = scenario !== 'healthy';
  const iso = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString();
  const H = 3_600_000;
  const D = 24 * H;
  const paths = new Map<string, unknown>();
  const list = (path: string, items: unknown[]) => paths.set(path, { items });
  const workloadSpecs = broken ? W : W.filter((w) => !w.brokenOnly);
  const k8sVersion = broken ? 'v1.33.4+rke2r1' : `v1.${maintainedMinor(now)}.4+rke2r1`;

  paths.set('/apis', {
    groups: ['apps', 'batch', 'networking.k8s.io', 'storage.k8s.io', 'metrics.k8s.io', 'longhorn.io', 'cert-manager.io', 'argoproj.io', 'postgresql.cnpg.io', 'monitoring.coreos.com', 'upgrade.cattle.io', 'secrets.infisical.com', 'policy', 'autoscaling', 'k3s.cattle.io', 'velero.io'].map((name) => ({ name })),
  });
  paths.set('/version', { gitVersion: k8sVersion, platform: 'linux/amd64' });

  const ready = (s = 'True') => [{ type: 'Ready', status: s }];
  list(
    '/api/v1/nodes',
    NODES.map((n, i) => ({
      metadata: {
        name: n.name,
        creationTimestamp: iso((210 - i * 60) * D),
        labels: { 'node-role.kubernetes.io/control-plane': 'true', 'node-role.kubernetes.io/etcd': 'true', 'node-role.kubernetes.io/master': 'true' },
      },
      spec: {},
      status: {
        conditions: [...ready(), { type: 'MemoryPressure', status: 'False' }, { type: 'DiskPressure', status: 'False' }, { type: 'PIDPressure', status: 'False' }],
        capacity: { cpu: n.cpu, memory: n.mem, pods: '110' },
        allocatable: { cpu: n.cpu, memory: n.mem, pods: '110' },
        addresses: [{ type: 'InternalIP', address: n.ip }, { type: 'Hostname', address: n.name }],
        nodeInfo: {
          kubeletVersion: k8sVersion,
          osImage: i === 1 ? 'AlmaLinux 10.0 (Purple Lion)' : 'Rocky Linux 10.0 (Red Quartz)',
          kernelVersion: i === 1 ? '6.12.0-55.20.1.el10_0.x86_64' : '6.12.0-55.22.1.el10_0.x86_64',
          containerRuntimeVersion: 'containerd://2.0.5-k3s1',
          architecture: 'amd64',
        },
      },
    })),
  );
  list(
    '/apis/metrics.k8s.io/v1beta1/nodes',
    NODES.map((n) => ({ metadata: { name: n.name }, usage: { cpu: `${n.usedCpu}m`, memory: `${Math.round((broken ? n.usedMem : Math.min(n.usedMem, 10.4)) * 1024)}Mi` } })),
  );

  const deployments: Obj[] = [];
  const statefulsets: Obj[] = [];
  const daemonsets: Obj[] = [];
  const pods: Obj[] = [];
  const podMetrics: Obj[] = [];
  const services: Obj[] = [];
  const ingresses: Obj[] = [];
  const pvcs: Obj[] = [];
  const longhornVolumes: Obj[] = [];

  for (const w of workloadSpecs) {
    const labels = { 'app.kubernetes.io/name': w.name, 'app.kubernetes.io/instance': w.name };
    const desired = w.kind === 'DaemonSet' ? NODES.length : (w.replicas ?? 1);
    const crash = broken ? w.crash : undefined;
    const readyCount = crash ? 0 : broken ? (w.ready ?? desired) : desired;
    const age = (20 + (hash(w.name) % 120)) * D;
    const loose = broken && w.loose;
    const image = w.name === 'cnpg-controller-manager' && !broken ? w.image.replace(/:1\.26\.1$/, ':1.28.3') : w.image;
    const memLimit = `${parseInt(w.mem ?? '128Mi', 10) * 2}${(w.mem ?? '128Mi').replace(/^\d+/, '')}`;
    const template = {
      metadata: { labels },
      spec: {
        ...(loose ? {} : { securityContext: HARDENED }),
        containers: [{ name: w.name.split('-')[0], image, resources: { requests: { cpu: w.cpu ?? '50m', memory: w.mem ?? '128Mi' }, ...(loose ? {} : { limits: { memory: memLimit } }) } }],
        volumes: w.pvc ? [{ name: 'data', persistentVolumeClaim: { claimName: `data-${w.name}-0` } }] : [],
      },
    };
    const meta = { name: w.name, namespace: w.ns, creationTimestamp: iso(age), annotations: {} as Record<string, string> };
    if (w.name === 'kured' && broken) {
      meta.annotations['weave.works/kured-node-lock'] = JSON.stringify({ nodeID: 'rke2-node-5', created: iso(3 * H), TTL: 0 });
    }
    const status =
      w.kind === 'DaemonSet'
        ? { desiredNumberScheduled: desired, numberReady: readyCount }
        : { replicas: desired, readyReplicas: readyCount, availableReplicas: readyCount, updatedReplicas: desired };
    const obj = { metadata: meta, spec: { replicas: desired, selector: { matchLabels: labels }, template }, status };
    ({ Deployment: deployments, StatefulSet: statefulsets, DaemonSet: daemonsets })[w.kind].push(obj);

    const hashPart = (hash(w.name) % 0xfffff).toString(16).padStart(5, '0').slice(0, 5);
    for (let i = 0; i < desired; i++) {
      const node = NODES[(hash(w.name) + i) % NODES.length].name;
      const podName =
        w.kind === 'Deployment' ? `${w.name}-${hashPart}-${(hash(w.name + i) % 99999).toString(36)}` : w.kind === 'StatefulSet' ? `${w.name}-${i}` : `${w.name}-${(hash(w.name + node) % 99999).toString(36)}`;
      const isReady = i < readyCount;
      const owner = w.kind === 'Deployment' ? { kind: 'ReplicaSet', name: `${w.name}-${hashPart}` } : { kind: w.kind, name: w.name };
      const restarts = crash ? crash.restarts : hash(podName) % 7 === 0 ? 1 + (hash(podName) % 3) : 0;
      pods.push({
        metadata: {
          name: podName,
          namespace: w.ns,
          labels: { ...labels, ...(w.kind === 'Deployment' ? { 'pod-template-hash': hashPart } : {}) },
          ownerReferences: [owner],
          creationTimestamp: iso(crash ? 2 * H : isReady ? age / 3 : 40 * 60_000),
        },
        spec: { ...template.spec, nodeName: node },
        status: {
          phase: isReady || crash ? 'Running' : 'Pending',
          conditions: [{ type: 'Ready', status: isReady ? 'True' : 'False' }, { type: 'PodScheduled', status: isReady || crash ? 'True' : 'False', message: isReady ? undefined : '0/3 nodes are available: 3 Insufficient memory.' }],
          containerStatuses: [
            {
              name: template.spec.containers[0].name,
              ready: isReady,
              restartCount: restarts,
              state: crash ? { waiting: { reason: crash.reason, message: crash.message } } : { running: {} },
              lastState: crash ? { terminated: { reason: 'Error', exitCode: 1 } } : {},
            },
          ],
        },
      });
      podMetrics.push({
        metadata: { name: podName, namespace: w.ns },
        containers: [{ usage: { cpu: `${5 + (hash(podName) % 180)}m`, memory: `${40 + (hash(podName) % 600)}Mi` } }],
      });
    }

    if (w.ports) {
      services.push({
        metadata: { name: w.name, namespace: w.ns },
        spec: { type: w.name === 'rke2-traefik' ? 'LoadBalancer' : 'ClusterIP', selector: labels, ports: w.ports.map((p) => ({ ...p, protocol: 'TCP' })) },
        status: w.name === 'rke2-traefik' ? { loadBalancer: { ingress: NODES.map((n) => ({ ip: n.ip })) } } : {},
      });
    }
    if (w.host) {
      const cert = CERTS.find((c) => c[2] === w.host);
      ingresses.push({
        metadata: { name: w.name, namespace: w.ns, annotations: { 'cert-manager.io/cluster-issuer': 'letsencrypt-prod' } },
        spec: {
          ingressClassName: 'traefik',
          tls: [{ hosts: [w.host], secretName: cert ? cert[1] : `${w.host}-tls` }],
          rules: [{ host: w.host, http: { paths: [{ path: '/', backend: { service: { name: w.name, port: { number: w.ports?.[0].port } } } }] } }],
        },
      });
    }
    if (w.pvc) {
      const pv = `pvc-${hash(w.name).toString(16)}-${hashPart}`;
      pvcs.push({
        metadata: { name: `data-${w.name}-0`, namespace: w.ns, creationTimestamp: iso(age) },
        spec: { storageClassName: w.pvc.class, accessModes: ['ReadWriteOnce'], volumeName: pv, resources: { requests: { storage: w.pvc.size } } },
        status: { phase: 'Bound', capacity: { storage: w.pvc.size } },
      });
      longhornVolumes.push({
        metadata: { name: pv },
        spec: { numberOfReplicas: 3 },
        status: {
          state: 'attached',
          robustness: w.name === 'weblate' && broken ? 'degraded' : 'healthy',
          kubernetesStatus: { namespace: w.ns, pvcName: `data-${w.name}-0`, workloadsStatus: [{ podName: `${w.name}-0` }] },
        },
      });
    }
  }

  // CNPG instance pods and volumes (owned by the Cluster, not a StatefulSet).
  const cnpg = CNPG.map((c) => ({
    ...c,
    ready: broken ? c.ready : c.instances,
    backupHoursAgo: c.name === 'shop-api-pg' && warn ? c.backupHoursAgo : Math.min(c.backupHoursAgo, 9),
  }));
  for (const c of cnpg) {
    for (let i = 1; i <= c.instances; i++) {
      const name = `${c.name}-${i}`;
      pods.push({
        metadata: { name, namespace: c.ns, labels: { 'cnpg.io/cluster': c.name }, ownerReferences: [{ kind: 'Cluster', name: c.name }], creationTimestamp: iso(40 * D) },
        spec: { nodeName: NODES[i % 3].name, securityContext: HARDENED, containers: [{ name: 'postgres', image: 'ghcr.io/cloudnative-pg/postgis:17-3.5', resources: { requests: { cpu: '100m', memory: '512Mi' }, limits: { memory: '1Gi' } } }], volumes: [{ name: 'pgdata', persistentVolumeClaim: { claimName: name } }] },
        status: {
          phase: 'Running',
          conditions: ready(i <= c.ready ? 'True' : 'False'),
          containerStatuses: [{ name: 'postgres', ready: i <= c.ready, restartCount: 0, state: { running: {} } }],
        },
      });
      podMetrics.push({ metadata: { name, namespace: c.ns }, containers: [{ usage: { cpu: `${30 + i * 20}m`, memory: `${300 + i * 90}Mi` } }] });
      pvcs.push({
        metadata: { name, namespace: c.ns, creationTimestamp: iso(40 * D) },
        spec: { storageClassName: 'local-path', accessModes: ['ReadWriteOnce'], volumeName: `pvc-local-${name}`, resources: { requests: { storage: c.ns === 'default' ? '50Gi' : '10Gi' } } },
        status: { phase: 'Bound', capacity: { storage: c.ns === 'default' ? '50Gi' : '10Gi' } },
      });
    }
  }
  if (broken) pvcs.push({
    metadata: { name: 'uploads', namespace: 'discourse', creationTimestamp: iso(25 * 60_000) },
    spec: { storageClassName: 'longhorn', accessModes: ['ReadWriteMany'], resources: { requests: { storage: '20Gi' } } },
    status: { phase: 'Pending' },
  });

  // etcd static pods
  for (const n of NODES) {
    pods.push({
      metadata: { name: `etcd-${n.name}`, namespace: 'kube-system', labels: { component: 'etcd', tier: 'control-plane' }, ownerReferences: [{ kind: 'Node', name: n.name }], creationTimestamp: iso(3 * D) },
      spec: { nodeName: n.name, containers: [{ name: 'etcd', image: 'rancher/hardened-etcd:v3.5.21-k3s1', resources: { requests: { cpu: '200m', memory: '512Mi' } } }] },
      status: { phase: 'Running', conditions: ready(), containerStatuses: [{ name: 'etcd', ready: true, restartCount: 0, state: { running: {} } }] },
    });
  }

  // Jobs: a nightly CronJob whose last run failed.
  const cron = { metadata: { name: 'appstore-metrics-reviews', namespace: 'default', creationTimestamp: iso(90 * D) }, spec: { schedule: '0 6 * * *' }, status: { lastScheduleTime: iso(6 * H) } };
  const allJobs = [
    {
      metadata: { name: 'appstore-metrics-reviews-29401200', namespace: 'default', ownerReferences: [{ kind: 'CronJob', name: 'appstore-metrics-reviews' }], creationTimestamp: iso(30 * H) },
      status: { succeeded: 1, completionTime: iso(30 * H - 60_000), conditions: [{ type: 'Complete', status: 'True' }] },
    },
    {
      metadata: { name: 'appstore-metrics-reviews-29402640', namespace: 'default', ownerReferences: [{ kind: 'CronJob', name: 'appstore-metrics-reviews' }], creationTimestamp: iso(6 * H) },
      status: { failed: 3, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit', lastTransitionTime: iso(5.8 * H) }] },
    },
  ];
  const jobs = broken ? allJobs : allJobs.slice(0, 1);
  if (broken) pods.push({
    metadata: { name: 'appstore-metrics-reviews-29402640-x7k2p', namespace: 'default', ownerReferences: [{ kind: 'Job', name: 'appstore-metrics-reviews-29402640' }], creationTimestamp: iso(5.9 * H) },
    spec: { nodeName: 'rke2-node-4', securityContext: HARDENED, containers: [{ name: 'reviews', image: 'ghcr.io/acme/appstore-metrics:2026-10-02-7', resources: { limits: { memory: '256Mi' } } }] },
    status: { phase: 'Failed', conditions: ready('False'), containerStatuses: [{ name: 'reviews', ready: false, restartCount: 0, state: { terminated: { reason: 'Error' } } }] },
  });

  list('/api/v1/pods', pods);
  list('/api/v1/namespaces/kube-system/pods', pods.filter((p) => (p.metadata as Obj).namespace === 'kube-system'));
  list('/apis/metrics.k8s.io/v1beta1/pods', podMetrics);
  list('/api/v1/namespaces', [...new Set(workloadSpecs.map((w) => w.ns).concat(CNPG.map((c) => c.ns), ['kube-public', 'kube-node-lease']))].map((name) => ({ metadata: { name } })));
  list('/apis/apps/v1/deployments', deployments);
  list('/apis/apps/v1/statefulsets', statefulsets);
  list('/apis/apps/v1/daemonsets', daemonsets);
  list('/apis/batch/v1/jobs', jobs);
  // The descheduler runs as a CronJob, as it does in many homelabs.
  const descheduler = {
    metadata: { name: 'descheduler', namespace: 'kube-system', creationTimestamp: iso(60 * D) },
    spec: { schedule: '*/15 4-7 * * *', jobTemplate: { spec: { template: { spec: { containers: [{ name: 'descheduler', image: 'registry.k8s.io/descheduler/descheduler:v0.33.0' }] } } } } },
    status: { lastScheduleTime: iso(8 * H), lastSuccessfulTime: iso(8 * H) },
  };
  list('/apis/batch/v1/cronjobs', [cron, descheduler]);
  list('/api/v1/services', services);
  list('/apis/networking.k8s.io/v1/ingresses', ingresses);
  list('/api/v1/persistentvolumeclaims', pvcs);
  list('/apis/storage.k8s.io/v1/storageclasses', [
    { metadata: { name: 'longhorn', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } }, provisioner: 'driver.longhorn.io', reclaimPolicy: 'Delete', allowVolumeExpansion: true },
    { metadata: { name: 'local-path' }, provisioner: 'rancher.io/local-path', reclaimPolicy: 'Delete', allowVolumeExpansion: false },
  ]);
  list('/api/v1/events?fieldSelector=type%3DWarning', !broken ? [] : [
    { metadata: { name: 'e1', namespace: 'default' }, type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container importer in pod social-importer', count: 14, lastTimestamp: iso(2 * 60_000), involvedObject: { kind: 'Pod', name: 'social-importer', namespace: 'default' } },
    { metadata: { name: 'e2', namespace: 'discourse' }, type: 'Warning', reason: 'FailedScheduling', message: '0/3 nodes are available: 3 Insufficient memory. preemption: 0/3 nodes are available.', count: 31, lastTimestamp: iso(4 * 60_000), involvedObject: { kind: 'Pod', name: 'discourse', namespace: 'discourse' } },
    // Kubernetes writes a new Event when the message changes; the view groups it with e2.
    { metadata: { name: 'e2b', namespace: 'discourse' }, type: 'Warning', reason: 'FailedScheduling', message: '0/3 nodes are available: 1 node(s) were unschedulable, 2 Insufficient memory.', count: 4, firstTimestamp: iso(39 * 60_000), lastTimestamp: iso(31 * 60_000), involvedObject: { kind: 'Pod', name: 'discourse', namespace: 'discourse' } },
    { metadata: { name: 'e3', namespace: 'discourse' }, type: 'Warning', reason: 'ProvisioningFailed', message: 'failed to provision volume with StorageClass "longhorn": ReadWriteMany needs the share manager, which is disabled', count: 6, lastTimestamp: iso(9 * 60_000), involvedObject: { kind: 'PersistentVolumeClaim', name: 'uploads', namespace: 'discourse' } },
    { metadata: { name: 'e4', namespace: 'longhorn-system' }, type: 'Warning', reason: 'Degraded', message: 'volume is degraded: replica on rke2-node-5 is rebuilding', count: 1, lastTimestamp: iso(41 * 60_000), involvedObject: { kind: 'Volume', name: 'pvc-weblate', namespace: 'longhorn-system' } },
    { metadata: { name: 'e5', namespace: 'default' }, type: 'Warning', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit', count: 1, lastTimestamp: iso(5.8 * H), involvedObject: { kind: 'Job', name: 'appstore-metrics-reviews-29402640', namespace: 'default' } },
    { metadata: { name: 'e6', namespace: 'kube-system' }, type: 'Warning', reason: 'NodeNotReady', message: 'Node rke2-node-5 status is now: NodeNotReady', count: 1, lastTimestamp: iso(3 * H), involvedObject: { kind: 'Node', name: 'rke2-node-5' } },
  ]);

  // CRDs
  list('/apis/longhorn.io/v1beta2/volumes', longhornVolumes);
  list(
    '/apis/longhorn.io/v1beta2/nodes',
    NODES.map((n, i) => ({
      metadata: { name: n.name },
      spec: { allowScheduling: true },
      status: { conditions: ready(), diskStatus: { default: { storageMaximum: [160, 320, 160][i] * 2 ** 30, storageAvailable: [61, 188, 22][i] * 2 ** 30, storageScheduled: [80, 120, 110][i] * 2 ** 30 } } },
    })),
  );
  list(
    '/apis/cert-manager.io/v1/certificates',
    CERTS.map(([ns, secret, host, d]) => [ns, secret, host, warn ? d : Math.max(d, 49)] as const).map(([ns, secret, host, days]) => ({
      metadata: { name: secret, namespace: ns },
      spec: { secretName: secret, dnsNames: [host] },
      status: { notAfter: new Date(now.getTime() + days * D).toISOString(), renewalTime: new Date(now.getTime() + (days - 30) * D).toISOString(), conditions: ready() },
    })),
  );
  list('/apis/cert-manager.io/v1/clusterissuers', [
    { metadata: { name: 'letsencrypt-prod' }, status: { conditions: ready() } },
    { metadata: { name: 'letsencrypt-staging' }, status: { conditions: ready() } },
  ]);
  list(
    '/apis/argoproj.io/v1alpha1/applications',
    ARGO_APPS.map(([name, s0, h0, auto]) => [name, broken ? s0 : name === 'weblate-chart' && warn ? 'OutOfSync' : 'Synced', broken ? h0 : 'Healthy', auto] as const).map(([name, sync, health, auto]) => ({
      metadata: { name, namespace: 'argocd' },
      spec: { syncPolicy: auto ? { automated: { prune: true, selfHeal: true } } : {} },
      status: {
        sync: { status: sync },
        health: { status: health },
        resources:
          health === 'Degraded'
            ? [{ kind: 'Deployment', name: 'social-importer', namespace: 'default', health: { status: 'Degraded', message: 'Deployment "social-importer" exceeded its progress deadline' } }]
            : [],
      },
    })),
  );
  list(
    '/apis/postgresql.cnpg.io/v1/clusters',
    cnpg.map((c) => ({
      metadata: { name: c.name, namespace: c.ns },
      spec: { instances: c.instances, backup: { barmanObjectStore: { destinationPath: `s3://shop-backups/cnpg/${c.name}` } } },
      status: {
        phase: c.ready === c.instances ? 'Cluster in healthy state' : 'Waiting for the instances to become active',
        instances: c.instances,
        readyInstances: c.ready,
        currentPrimary: `${c.name}-1`,
        lastSuccessfulBackup: iso(c.backupHoursAgo * H),
        conditions: [{ type: 'ContinuousArchiving', status: c.archiving ? 'True' : 'False' }],
      },
    })),
  );
  list('/apis/upgrade.cattle.io/v1/plans', [
    { metadata: { name: 'server-plan', namespace: 'system-upgrade' }, spec: { channel: 'https://update.rke2.io/v1-release/channels/stable' }, status: { latestVersion: k8sVersion, applying: [], conditions: [{ type: 'LatestResolved', status: 'True' }] } },
  ]);
  list('/apis/secrets.infisical.com/v1beta1/infisicalsecrets', []);
  list(
    '/apis/secrets.infisical.com/v1beta1/infisicalstaticsecrets',
    ['shop-api-secret', 'cloudflare-api-token', 'alertmanager-smtp'].map((name) => ({ metadata: { name, namespace: 'default' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } })),
  );

  // PodDisruptionBudgets: one with a single pod and minAvailable 1 blocks every drain.
  const pdb = (ns: string, name: string, expected: number, min: number) => ({
    metadata: { name, namespace: ns },
    spec: { minAvailable: min },
    status: { expectedPods: expected, currentHealthy: expected, desiredHealthy: min, disruptionsAllowed: Math.max(0, expected - min) },
  });
  list('/apis/policy/v1/poddisruptionbudgets', [
    pdb('default', 'shop-api-chart', 3, 2),
    pdb('default', 'shop-web-app-chart', 2, 1),
    pdb('default', 'shop-mcp-chart', 2, 1),
    ...(broken ? [pdb('pgadmin', 'pgadmin', 1, 1)] : []),
  ]);

  // Autoscalers: the web app runs into its limit when broken.
  const hpa = (name: string, min: number, max: number, current: number, limited: boolean) => ({
    metadata: { name, namespace: 'default' },
    spec: { minReplicas: min, maxReplicas: max, scaleTargetRef: { kind: 'Deployment', name } },
    status: {
      currentReplicas: current,
      desiredReplicas: limited ? max + 2 : current,
      conditions: [
        { type: 'AbleToScale', status: 'True' },
        { type: 'ScalingActive', status: 'True' },
        { type: 'ScalingLimited', status: limited ? 'True' : 'False', reason: limited ? 'TooManyReplicas' : 'DesiredWithinRange' },
      ],
    },
  });
  list('/apis/autoscaling/v2/horizontalpodautoscalers', [
    hpa('shop-api-chart', 3, 6, 3, false),
    hpa('shop-mcp-chart', 2, 5, 2, false),
    hpa('shop-web-app-chart', 1, 2, 2, broken),
  ]);

  // RKE2 etcd snapshots every 12 h, to S3.
  list('/apis/k3s.cattle.io/v1/etcdsnapshotfiles', [
    ...[3, 15, 27, 39].map((h, i) => ({
      metadata: { name: `s3-etcd-snapshot-rke2-node-1-${i}`, creationTimestamp: iso(h * H) },
      spec: { snapshotName: `etcd-snapshot-rke2-node-1-${i}`, nodeName: 's3', location: 's3://shop-backups/etcd', s3: {} },
      status: { creationTime: iso(h * H), readyToUse: true, size: '48Mi' },
    })),
    // RKE2 also keeps each snapshot on the node that took it.
    ...NODES.map((n, i) => ({
      metadata: { name: `local-etcd-snapshot-${n.name}-0`, creationTimestamp: iso(3 * H) },
      spec: { snapshotName: `etcd-snapshot-${n.name}-0`, nodeName: n.name, location: `file:///var/lib/rancher/rke2/server/db/snapshots/etcd-snapshot-${n.name}-${i}` },
      status: { creationTime: iso(3 * H), readyToUse: true, size: '48Mi' },
    })),
  ]);

  // Longhorn backups to S3, nightly at 02:00; one failed when broken.
  list('/apis/longhorn.io/v1beta2/backuptargets', [{ metadata: { name: 'default' }, spec: { backupTargetURL: 's3://shop-backups@eu-central-2/longhorn-backups' }, status: { available: true } }]);
  list(
    '/apis/longhorn.io/v1beta2/backups',
    longhornVolumes
      .filter((v) => !/prometheus|loki/.test(((v.status as Obj).kubernetesStatus as { pvcName: string }).pvcName))
      .flatMap((v) => {
      const volume = (v.metadata as { name: string }).name;
      const failed = broken && volume.startsWith(`pvc-${hash('weblate').toString(16)}-`);
      return [
        { metadata: { name: `backup-${volume}-a` }, status: { state: 'Completed', volumeName: volume, backupCreatedAt: iso(34 * H) } },
        { metadata: { name: `backup-${volume}-b` }, status: failed ? { state: 'Error', volumeName: volume, backupCreatedAt: iso(10 * H), error: 'failed to upload block: context deadline exceeded (S3 eu-central-2)' } : { state: 'Completed', volumeName: volume, backupCreatedAt: iso(10 * H) } },
      ];
    }),
  );

  // Velero: a nightly schedule for the apps and a weekly one for everything, to S3. The nightly one partly failed when broken.
  const velero = (schedule: string, n: number, hoursAgo: number, phase = 'Completed', extra: Obj = {}) => ({
    metadata: { name: `${schedule}-${n}`, namespace: 'velero', labels: { 'velero.io/schedule-name': schedule }, creationTimestamp: iso(hoursAgo * H) },
    spec: { storageLocation: 'default' },
    status: { phase, startTimestamp: iso(hoursAgo * H), completionTimestamp: iso(hoursAgo * H - 9 * 60_000), errors: 0, warnings: 0, ...extra },
  });
  list('/apis/velero.io/v1/backups', [
    velero('daily-apps', 1, 52),
    velero('daily-apps', 2, 28),
    broken ? velero('daily-apps', 3, 4, 'PartiallyFailed', { errors: 2, warnings: 1 }) : velero('daily-apps', 3, 4),
    velero('weekly-full', 1, 7 * 24 + 20),
    velero('weekly-full', 2, 20),
  ]);
  return paths;
}

/** Prometheus answers good enough to fill every chart and stat in the app. */
function prometheusAnswer(path: string, now: Date, scenario: DemoScenario): unknown {
  const broken = scenario === 'broken';
  const url = new URL(path, 'http://x');
  const query = url.searchParams.get('query') ?? '';
  const vector = (result: { metric: Record<string, string>; value: number }[]) => ({
    status: 'success',
    data: { resultType: 'vector', result: result.map((r) => ({ metric: r.metric, value: [now.getTime() / 1000, String(r.value)] })) },
  });
  if (url.pathname.endsWith('/query_range')) {
    const start = Number(url.searchParams.get('start'));
    const end = Number(url.searchParams.get('end'));
    const step = Number(url.searchParams.get('step'));
    const wave = (seed: number, base: number, amp: number) => {
      const values: [number, string][] = [];
      for (let t = start; t <= end; t += step) {
        const v = base + amp * Math.sin(t / 2400 + seed) + (amp / 3) * Math.sin(t / 530 + seed * 3) + (seed % 2 ? 0 : (amp / 4) * Math.max(0, Math.sin(t / 7000)));
        values.push([t, String(Math.max(0, v))]);
      }
      return values;
    };
    const matrix = (series: { metric: Record<string, string>; seed: number; base: number; amp: number }[]) => ({
      status: 'success',
      data: { resultType: 'matrix', result: series.map((s) => ({ metric: s.metric, values: wave(s.seed, s.base, s.amp) })) },
    });
    if (query.includes('by (instance)')) {
      const memory = query.includes('Mem');
      return matrix(NODES.map((n, i) => ({ metric: { instance: `${n.ip}:9100` }, seed: i + (memory ? 7 : 0), base: memory ? n.usedMem / Number.parseInt(n.mem) : n.usedCpu / (Number(n.cpu) * 1000), amp: memory ? 0.04 : 0.12 })));
    }
    const table: [string, number, number, number][] = [
      ['node_cpu_seconds_total', 1, 0.33, 0.1],
      ['MemAvailable', 2, 0.72, 0.03],
      ['receive_bytes', 3, 2.4e6, 1.1e6],
      ['transmit_bytes', 4, 1.6e6, 0.9e6],
      ['restarts', 5, 1.5, 1.5],
      ['etcd_disk_wal', 6, 0.0042, 0.0025],
      ['apiserver_request', 7, 0.18, 0.06],
    ];
    const hit = table.find(([needle]) => query.includes(needle));
    return matrix(hit ? [{ metric: {}, seed: hit[1], base: hit[2], amp: hit[3] }] : []);
  }
  if (query.includes('count by (job) (up)')) {
    return vector(['apiserver', 'kubelet', 'node-exporter', 'kube-state-metrics', 'etcd', 'coredns', 'longhorn', 'shop-api', 'loki', 'traefik', 'blackbox'].map((job, i) => ({ metric: { job }, value: [3, 3, 3, 1, 3, 2, 3, 3, 1, 3, 12][i] })));
  }
  if (query === 'up == 0') {
    return vector(!broken ? [] : [{ metric: { job: 'blackbox', instance: 'https://community.shop.example' }, value: 0 }]);
  }
  if (query.includes('prometheus_tsdb_head_series')) {
    return vector([{ metric: {}, value: 412_337 }]);
  }
  if (query.includes('node_filesystem_avail_bytes')) {
    return vector(NODES.map((n, i) => ({ metric: { instance: `${n.ip}:9100` }, value: [0.61, 0.44, broken ? 0.88 : 0.52][i] })));
  }
  if (query.includes('kubelet_volume_stats_used_bytes')) {
    return vector([
      { metric: { namespace: 'monitoring', persistentvolumeclaim: 'data-prometheus-monitoring-chart-kube-prom-prometheus-0' }, value: 41.3 * 2 ** 30 },
      { metric: { namespace: 'monitoring', persistentvolumeclaim: 'data-loki-0' }, value: 12.1 * 2 ** 30 },
      { metric: { namespace: 'default', persistentvolumeclaim: 'shop-api-pg-1' }, value: 21.7 * 2 ** 30 },
      { metric: { namespace: 'weblate', persistentvolumeclaim: 'data-weblate-0' }, value: 6.4 * 2 ** 30 },
    ]);
  }
  if (query.includes('kubelet_volume_stats_capacity_bytes')) {
    return vector([
      { metric: { namespace: 'monitoring', persistentvolumeclaim: 'data-prometheus-monitoring-chart-kube-prom-prometheus-0' }, value: 50 * 2 ** 30 },
      { metric: { namespace: 'monitoring', persistentvolumeclaim: 'data-loki-0' }, value: 30 * 2 ** 30 },
      { metric: { namespace: 'default', persistentvolumeclaim: 'shop-api-pg-1' }, value: 50 * 2 ** 30 },
      { metric: { namespace: 'weblate', persistentvolumeclaim: 'data-weblate-0' }, value: 20 * 2 ** 30 },
    ]);
  }
  if (query.includes('etcd_disk_wal_fsync')) {
    return vector([{ metric: {}, value: 0.0061 }]);
  }
  if (query.includes('leader_changes')) {
    return vector([{ metric: {}, value: 1 }]);
  }
  if (query.includes('apiserver_requested_deprecated_apis')) {
    // The warning cluster still runs something on a beta API that goes two releases from now: a hint, not a warning.
    const removed = `1.${maintainedMinor(now) + 2}`;
    return vector(scenario !== 'warning' ? [] : [{ metric: { group: 'resource.k8s.io', version: 'v1beta1', resource: 'deviceclasses', removed_release: removed }, value: 1 }]);
  }
  if (query.includes('kured_reboot_required')) {
    return vector(!broken ? [] : [{ metric: { node: 'rke2-node-5' }, value: 1 }]);
  }
  if (query.includes('loki_distributor_lines_received_total')) {
    return vector([{ metric: {}, value: 84.2 }]);
  }
  return vector([]);
}

/** Gatus' /api/v1/endpoints/statuses: results oldest first, as Gatus sends them; the forum is down when broken. */
function gatusAnswer(now: Date, scenario: DemoScenario): unknown {
  const endpoints: [string, string, string][] = [
    ['shop', 'api', 'api.shop.example'],
    ['shop', 'web-app', 'shop.example'],
    ['shop', 'community', 'community.shop.example'],
    ['homelab', 'argo-cd', 'argocd-server.argocd.svc'],
    ['homelab', 'grafana', 'monitoring-chart-grafana.monitoring.svc'],
  ];
  return endpoints.map(([group, name, host]) => {
    const down = scenario === 'broken' && name === 'community';
    return {
      name,
      group,
      key: `${group}_${name}`,
      results: [3, 2, 1, 0].map((i) => {
        const failed = down && i < 3;
        return {
          status: failed ? 503 : 200,
          hostname: host,
          duration: 41_000_000 + i * 3_000_000,
          conditionResults: [{ condition: '[STATUS] == 200', success: !failed }],
          success: !failed,
          timestamp: new Date(now.getTime() - i * 5 * 60_000).toISOString(),
        };
      }),
    };
  });
}

/** Uptime Kuma's public status page "homelab" and its heartbeats (oldest first). Everything is up; Weblate is still pending. */
function uptimeKumaAnswer(path: string, now: Date): unknown {
  const monitors: [number, string, number][] = [
    [1, 'Shop API', 1],
    [2, 'Shop Web', 1],
    [3, 'Shop MCP', 1],
    [4, 'Argo CD', 1],
    [5, 'Grafana', 1],
    [6, 'Weblate', 2],
  ];
  if (path.includes('/api/status-page/heartbeat/')) {
    const time = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString().replace('T', ' ').replace('Z', '');
    return {
      heartbeatList: Object.fromEntries(monitors.map(([id, , status]) => [String(id), [2, 1, 0].map((m) => ({ status: m === 0 ? status : 1, time: time(m), msg: '', ping: 40 + id }))])),
      uptimeList: Object.fromEntries(monitors.map(([id]) => [`${id}_24`, 1])),
    };
  }
  return {
    config: { slug: 'homelab', title: 'Homelab', published: true },
    incident: null,
    publicGroupList: [
      { id: 1, name: 'Shop', weight: 1, monitorList: monitors.slice(0, 3).map(([id, name]) => ({ id, name })) },
      { id: 2, name: 'Homelab', weight: 2, monitorList: monitors.slice(3).map(([id, name]) => ({ id, name })) },
    ],
    maintenanceList: [],
  };
}

const LOG = `2026-11-24T04:02:11.093Z INFO  importer starting, feeds=3
2026-11-24T04:02:11.412Z INFO  refreshing instagram feed @shop.example
2026-11-24T04:02:12.006Z ERROR Instagram API answered 400: Error validating access token: Session has expired on Sunday, 23-Nov-26 09:00:00 PST. (code 190, subcode 463)
    at refreshFeed (/app/dist/feeds/instagram.js:42:11)
    at async Promise.all (index 0)
    at async main (/app/dist/main.js:18:3)
2026-11-24T04:02:12.007Z FATAL giving up, exit 1
`;

/** KubeClient answering from the demo cluster. Writes are recorded, not applied. */
export class DemoKubeClient extends KubeClient {
  private paths: Map<string, unknown>;
  readonly writes: { method: string; path: string; body: unknown }[] = [];
  /** Every list path asked for, so tests can see what a switched-off module no longer reads. */
  readonly lists: string[] = [];
  private readonly secrets = new Map<string, unknown>();
  private readonly configMaps = new Map<string, { data: Record<string, string> }>();

  constructor(
    private readonly now: () => Date = () => new Date(),
    readonly scenario: DemoScenario = 'broken',
  ) {
    super();
    this.paths = buildDemoCluster(now(), scenario);
  }

  override async apiServerCertificate(): Promise<Date | null> {
    return new Date(this.now().getTime() + 287 * 86_400_000);
  }

  // The demo answers proxy paths, so it never takes the direct route.
  override get inCluster(): boolean {
    return false;
  }

  override async list<T>(path: string): Promise<T[] | null> {
    this.lists.push(path);
    this.paths = buildDemoCluster(this.now(), this.scenario);
    const hit = this.paths.get(path) as { items?: T[] } | undefined;
    return hit ? (hit.items ?? []) : null;
  }

  override async get<T>(path: string): Promise<T> {
    if (path.includes('/proxy/')) {
      if (path.includes(':9090/proxy')) {
        return prometheusAnswer(path.slice(path.indexOf('/proxy') + 6), this.now(), this.scenario) as T;
      }
      if (path.includes(':9093/proxy/api/v2/alerts')) {
        const watchdog = { labels: { alertname: 'Watchdog', severity: 'none' } };
        if (this.scenario !== 'broken') {
          return [watchdog] as T;
        }
        return [
          { labels: { alertname: 'BlackboxProbeFailed', severity: 'critical', instance: 'https://community.shop.example' }, annotations: { summary: 'community.shop.example has not answered for 12 minutes.' } },
          { labels: { alertname: 'KubePersistentVolumeFillingUp', severity: 'warning', namespace: 'monitoring' }, annotations: { summary: 'The Prometheus volume will be full in about 4 days.' } },
          { labels: { alertname: 'Watchdog', severity: 'none' } },
        ] as T;
      }
      if (path.includes(':9093/proxy/api/v2/silences')) {
        return [{ status: { state: 'active' } }] as T;
      }
      if (path.includes(':8080/proxy/api/v1/endpoints/statuses')) {
        return gatusAnswer(this.now(), this.scenario) as T;
      }
      if (path.includes(':3001/proxy/api/status-page/')) {
        return uptimeKumaAnswer(path, this.now()) as T;
      }
      if (path.includes('/api/health')) {
        return { database: 'ok', version: '12.1.0' } as T;
      }
      throw new KubeError(404, `not found: ${path}`);
    }
    if (path.includes('/configmaps/')) {
      const c = this.configMaps.get(path);
      if (!c) {
        throw new KubeError(404, 'configmap not found');
      }
      return c as T;
    }
    if (path.includes('/secrets/')) {
      const s = this.secrets.get(path);
      if (!s) {
        throw new KubeError(404, 'secret not found');
      }
      return s as T;
    }
    const hit = this.paths.get(path);
    if (hit === undefined) {
      throw new KubeError(404, `not found: ${path}`);
    }
    return hit as T;
  }

  override async text(path: string): Promise<string> {
    if (path.endsWith('/proxy/ready')) {
      return 'ready\n';
    }
    if (path.includes('/log')) {
      return LOG;
    }
    throw new KubeError(404, 'not found');
  }

  override async mergePatch(path: string, body: unknown): Promise<void> {
    this.writes.push({ method: 'PATCH', path, body });
    if (path.includes('/configmaps/')) {
      const existing = this.configMaps.get(path);
      if (!existing) {
        throw new KubeError(404, 'configmap not found');
      }
      existing.data = { ...existing.data, ...(body as { data?: Record<string, string> }).data };
    }
    if (path.includes('/secrets/')) {
      const existing = this.secrets.get(path) as { data: Record<string, string> } | undefined;
      if (!existing) {
        throw new KubeError(404, 'secret not found');
      }
      existing.data = { ...existing.data, ...encode((body as { stringData?: Record<string, string> }).stringData ?? {}) };
    }
  }

  override async create(path: string, body: unknown): Promise<void> {
    this.writes.push({ method: 'POST', path, body });
    if (path.endsWith('/configmaps')) {
      const b = body as { metadata: { name: string }; data: Record<string, string> };
      this.configMaps.set(`${path}/${b.metadata.name}`, { data: { ...b.data } });
    }
    if (path.endsWith('/secrets')) {
      const b = body as { metadata: { name: string }; stringData: Record<string, string> };
      this.secrets.set(`${path}/${b.metadata.name}`, { data: encode(b.stringData) });
    }
  }
}

function encode(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Buffer.from(v).toString('base64')]));
}
