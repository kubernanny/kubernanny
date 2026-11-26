import { cpuMilli, parseQuantity } from '../inventory/inventory';
import { KubeClient, KubeError } from '../kube/kube-client';
import { HINT_DAYS } from '../modules/kubernetes-support/evaluate';
import { KUBERNETES_EOL } from '../modules/kubernetes-support/releases';
import { DEMO_SLOW_PEER, standardAlertsAnswer } from './demo-standard-alerts';

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
  /** `lastReason`: how the last run ended (OOMKilled when the limit is too small); Error by default. */
  crash?: { reason: string; restarts: number; message?: string; lastReason?: string };
  /** A ConfigMap the container reads through env/envFrom; it changed after the last start (broken scenario). */
  envConfigMap?: string;
  pvc?: { size: string; class: string };
  /** Broken scenario only: no securityContext and no memory limit, for the security posture check. */
  loose?: boolean;
  /**
   * Broken scenario only: runs without securityContext (the root hint) and
   * accepts that in its `kubernanny.io/accept` annotation, with this reason.
   */
  acceptRoot?: string;
  /** Runs in the broken scenario only (Gatus, Uptime Kuma), so the others keep their reviewed shape. */
  brokenOnly?: boolean;
}

const W: WorkloadSpec[] = [
  // kube-system
  { kind: 'DaemonSet', ns: 'kube-system', name: 'rke2-canal', image: 'rancher/hardened-calico:v3.29.1-build20250218' },
  {
    kind: 'Deployment',
    ns: 'kube-system',
    name: 'rke2-coredns-rke2-coredns',
    image: 'rancher/hardened-coredns:v1.12.0-build20250218',
    replicas: 2,
    ports: [{ port: 53, name: 'udp-53' }],
  },
  {
    kind: 'Deployment',
    ns: 'kube-system',
    name: 'rke2-metrics-server',
    image: 'rancher/hardened-k8s-metrics-server:v0.7.2-build20250218',
    ports: [{ port: 443 }],
  },
  {
    kind: 'DaemonSet',
    ns: 'kube-system',
    name: 'rke2-traefik',
    image: 'rancher/mirrored-library-traefik:3.3.6',
    ports: [
      { port: 80, name: 'web' },
      { port: 443, name: 'websecure' },
    ],
  },
  { kind: 'DaemonSet', ns: 'kube-system', name: 'kured', image: 'ghcr.io/kubereboot/kured:1.17.1' },
  {
    kind: 'Deployment',
    ns: 'system-upgrade',
    name: 'system-upgrade-controller',
    image: 'rancher/system-upgrade-controller:v0.15.2',
  },
  // storage
  {
    kind: 'DaemonSet',
    ns: 'longhorn-system',
    name: 'longhorn-manager',
    image: 'longhornio/longhorn-manager:v1.9.0',
    ports: [{ port: 9500, name: 'manager' }],
  },
  {
    kind: 'Deployment',
    ns: 'longhorn-system',
    name: 'longhorn-ui',
    image: 'longhornio/longhorn-ui:v1.9.0',
    replicas: 2,
    ports: [{ port: 80, name: 'http' }],
    host: 'longhorn.home.example',
  },
  {
    kind: 'Deployment',
    ns: 'local-path-storage',
    name: 'local-path-provisioner',
    image: 'rancher/local-path-provisioner:v0.0.31',
  },
  {
    kind: 'Deployment',
    ns: 'rook-ceph',
    name: 'rook-ceph-operator',
    image: 'docker.io/rook/ceph:v1.17.7',
    brokenOnly: true,
  },
  // gitops
  { kind: 'StatefulSet', ns: 'argocd', name: 'argocd-application-controller', image: 'quay.io/argoproj/argocd:v3.1.2' },
  {
    kind: 'Deployment',
    ns: 'argocd',
    name: 'argocd-server',
    image: 'quay.io/argoproj/argocd:v3.1.2',
    ports: [{ port: 80, name: 'http' }],
    host: 'argo.home.example',
  },
  { kind: 'Deployment', ns: 'argocd', name: 'argocd-repo-server', image: 'quay.io/argoproj/argocd:v3.1.2' },
  {
    kind: 'Deployment',
    ns: 'argocd',
    name: 'argocd-image-updater',
    image: 'quay.io/argoprojlabs/argocd-image-updater:v0.17.0',
  },
  // certificates & secrets
  {
    kind: 'Deployment',
    ns: 'cert-manager',
    name: 'cert-manager',
    image: 'quay.io/jetstack/cert-manager-controller:v1.18.2',
  },
  {
    kind: 'Deployment',
    ns: 'infisical',
    name: 'infisical',
    image: 'infisical/infisical:v0.130.0',
    ports: [{ port: 8080 }],
    host: 'secrets.home.example',
  },
  { kind: 'Deployment', ns: 'infisical', name: 'infisical-operator', image: 'infisical/kubernetes-operator:v0.9.4' },
  {
    kind: 'Deployment',
    ns: 'kyverno',
    name: 'kyverno-admission-controller',
    image: 'ghcr.io/kyverno/kyverno:v1.15.1',
    brokenOnly: true,
  },
  {
    kind: 'Deployment',
    ns: 'gatekeeper-system',
    name: 'gatekeeper-controller-manager',
    image: 'openpolicyagent/gatekeeper:v3.20.1',
    brokenOnly: true,
  },
  {
    kind: 'Deployment',
    ns: 'trivy-system',
    name: 'trivy-operator',
    image: 'mirror.gcr.io/aquasec/trivy-operator:0.36.1',
    brokenOnly: true,
  },
  // databases
  // 1.26.1 has a known critical advisory (fixed in 1.28.3): the broken scenario runs it, the others the fix.
  {
    kind: 'Deployment',
    ns: 'cnpg-system',
    name: 'cnpg-controller-manager',
    image: 'ghcr.io/cloudnative-pg/cloudnative-pg:1.26.1',
  },
  {
    kind: 'StatefulSet',
    ns: 'default',
    name: 'shop-api-valkey',
    image: 'valkey/valkey:8.1-alpine',
    ports: [{ port: 6379 }],
    pvc: { size: '2Gi', class: 'longhorn' },
  },
  // monitoring
  {
    kind: 'StatefulSet',
    ns: 'monitoring',
    name: 'prometheus-monitoring-chart-kube-prom-prometheus',
    image: 'quay.io/prometheus/prometheus:v3.5.0',
    ports: [{ port: 9090, name: 'http-web' }],
    cpu: '200m',
    mem: '1Gi',
    pvc: { size: '50Gi', class: 'longhorn' },
  },
  {
    kind: 'StatefulSet',
    ns: 'monitoring',
    name: 'alertmanager-monitoring-chart-kube-prom-alertmanager',
    image: 'quay.io/prometheus/alertmanager:v0.28.1',
    ports: [{ port: 9093, name: 'http-web' }],
    host: 'alertmanager.home.example',
  },
  {
    kind: 'Deployment',
    ns: 'monitoring',
    name: 'monitoring-chart-grafana',
    image: 'docker.io/grafana/grafana:12.1.0',
    ports: [{ port: 80, name: 'http-web' }],
    host: 'monitoring.home.example',
    pvc: { size: '10Gi', class: 'longhorn' },
  },
  {
    kind: 'Deployment',
    ns: 'monitoring',
    name: 'monitoring-chart-kube-state-metrics',
    image: 'registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.16.0',
  },
  {
    kind: 'DaemonSet',
    ns: 'monitoring',
    name: 'monitoring-chart-prometheus-node-exporter',
    image: 'quay.io/prometheus/node-exporter:v1.9.1',
  },
  {
    kind: 'Deployment',
    ns: 'monitoring',
    name: 'monitoring-chart-prometheus-blackbox-exporter',
    image: 'quay.io/prometheus/blackbox-exporter:v0.27.0',
  },
  {
    kind: 'Deployment',
    ns: 'monitoring',
    name: 'gatus',
    image: 'twinproduction/gatus:v5.17.0',
    ports: [{ port: 8080, name: 'http' }],
    brokenOnly: true,
  },
  {
    kind: 'StatefulSet',
    ns: 'monitoring',
    name: 'uptime-kuma',
    image: 'louislam/uptime-kuma:1.23.16',
    ports: [{ port: 3001, name: 'http' }],
    brokenOnly: true,
  },
  {
    kind: 'StatefulSet',
    ns: 'monitoring',
    name: 'loki',
    image: 'docker.io/grafana/loki:3.5.3',
    ports: [{ port: 3100, name: 'http-metrics' }],
    pvc: { size: '30Gi', class: 'longhorn' },
  },
  { kind: 'DaemonSet', ns: 'monitoring', name: 'promtail', image: 'docker.io/grafana/promtail:3.5.3' },
  // apps
  {
    kind: 'Deployment',
    ns: 'default',
    name: 'shop-api-chart',
    image: 'ghcr.io/acme/shop-api:2026-11-24-412',
    replicas: 3,
    ports: [{ port: 3000 }],
    host: 'api.shop.example',
    cpu: '250m',
    mem: '512Mi',
  },
  {
    kind: 'Deployment',
    ns: 'default',
    name: 'shop-web-app-chart',
    image: 'ghcr.io/acme/shop-web-app:2026-11-24-118',
    replicas: 2,
    ports: [{ port: 4000 }],
    host: 'shop.example',
  },
  // Broken: its memory limit is too small since the last release, so restarting cannot help.
  {
    kind: 'Deployment',
    ns: 'default',
    name: 'shop-mcp-chart',
    image: 'ghcr.io/acme/shop-mcp:2026-06-02-0',
    replicas: 2,
    ports: [{ port: 8787 }],
    host: 'mcp.shop.example',
    crash: {
      reason: 'CrashLoopBackOff',
      restarts: 9,
      message: 'back-off 2m40s restarting failed container',
      lastReason: 'OOMKilled',
    },
  },
  {
    kind: 'Deployment',
    ns: 'default',
    name: 'social-importer',
    image: 'ghcr.io/acme/social-importer:2026-11-20-3',
    crash: { reason: 'CrashLoopBackOff', restarts: 14, message: 'back-off 5m0s restarting failed container' },
  },
  // Crashed on a missing setting; the ConfigMap it reads through env has been fixed since its last start.
  {
    kind: 'Deployment',
    ns: 'default',
    name: 'newsletter-worker',
    image: 'ghcr.io/acme/newsletter-worker:2026-11-25-2',
    crash: { reason: 'CrashLoopBackOff', restarts: 6, message: 'back-off 2m40s restarting failed container' },
    envConfigMap: 'newsletter-config',
    brokenOnly: true,
  },
  {
    kind: 'StatefulSet',
    ns: 'weblate',
    name: 'weblate',
    image: 'weblate/weblate:5.13.0',
    ports: [{ port: 8080 }],
    host: 'translate.shop.example',
    pvc: { size: '20Gi', class: 'longhorn' },
  },
  {
    kind: 'Deployment',
    ns: 'discourse',
    name: 'discourse',
    image: 'docker.io/bitnami/discourse:3.4.6',
    replicas: 2,
    ready: 1,
    ports: [{ port: 3000 }],
    host: 'community.shop.example',
    acceptRoot: 'the image boots runit as root and drops privileges itself',
  },
  {
    kind: 'Deployment',
    ns: 'pgadmin',
    name: 'pgadmin',
    image: 'dpage/pgadmin4:9.6',
    ports: [{ port: 80 }],
    host: 'pgadmin.home.example',
    loose: true,
  },
  { kind: 'Deployment', ns: 'velero', name: 'velero', image: 'velero/velero:v1.16.2' },
  {
    kind: 'Deployment',
    ns: 'kubernanny',
    name: 'kubernanny',
    image: 'ghcr.io/kubernanny/agent:0.2.0',
    ports: [{ port: 80, name: 'http' }],
    host: 'kubernanny.home.example',
  },
];

const CNPG = [
  { ns: 'default', name: 'shop-api-pg', instances: 2, ready: 2, backupHoursAgo: 31, archiving: true },
  { ns: 'infisical', name: 'infisical-pg', instances: 2, ready: 2, backupHoursAgo: 9, archiving: true },
  { ns: 'discourse', name: 'discourse-pg', instances: 2, ready: 1, backupHoursAgo: 10, archiving: true },
];

/** The manual-sync app of the demo with three deployments in its history (argocd-rollback). */
export const ROLLBACK_APP = 'shop-web-app-chart';
const ROLLBACK_SOURCE = {
  repoURL: 'https://git.example/homelab/gitops.git',
  path: 'apps/shop-web-app',
  targetRevision: 'main',
};
const ROLLBACK_HISTORY = [
  { id: 7, revision: '3f9c2a1d8e7b6a5c4d3e2f1a0b9c8d7e6f5a4b3c' },
  { id: 8, revision: 'a71e0c9b8d7f6e5a4b3c2d1e0f9a8b7c6d5e4f3a' },
  { id: 9, revision: 'c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3' },
];

/** Manual apps with a change in Git not yet synced, and what the change is, as Argo CD records it in the Application. */
const PENDING_APPS: Record<
  string,
  { namespace: string; hoursAgo: number; image?: { repo: string; from: string; to: string }; resources: object[] }
> = {
  'kubernanny-chart': {
    namespace: 'kubernanny',
    hoursAgo: 3,
    image: { repo: 'ghcr.io/kubernanny/agent', from: '2026-11-25-11', to: '2026-11-25-14' },
    resources: [
      {
        kind: 'Deployment',
        name: 'kubernanny',
        namespace: 'kubernanny',
        status: 'OutOfSync',
        health: { status: 'Healthy' },
      },
      {
        kind: 'Role',
        name: 'kubernanny-keys',
        namespace: 'kubernanny',
        status: 'OutOfSync',
        health: { status: 'Missing' },
      },
    ],
  },
  'weblate-chart': {
    namespace: 'weblate',
    hoursAgo: 26,
    image: { repo: 'weblate/weblate', from: '5.13.0', to: '5.13.2' },
    resources: [
      {
        kind: 'StatefulSet',
        name: 'weblate',
        namespace: 'weblate',
        status: 'OutOfSync',
        health: { status: 'Healthy' },
      },
      {
        kind: 'ConfigMap',
        name: 'weblate-legacy-settings',
        namespace: 'weblate',
        status: 'OutOfSync',
        requiresPruning: true,
      },
    ],
  },
};

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
  return (
    known.find(([, eol]) => eol - now.getTime() > (HINT_DAYS + 30) * 86_400_000)?.[0] ?? known[known.length - 1]![0] + 1
  );
}

const hash = (s: string) => {
  let h = 0;
  for (const c of s) {
    h = (h * 31 + c.charCodeAt(0)) >>> 0;
  }
  return h;
};

function buildDemoCluster(now: Date, scenario: DemoScenario = 'broken'): Map<string, unknown> {
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
    groups: [
      'apps',
      'batch',
      'networking.k8s.io',
      'storage.k8s.io',
      'metrics.k8s.io',
      'longhorn.io',
      'cert-manager.io',
      'argoproj.io',
      'postgresql.cnpg.io',
      'monitoring.coreos.com',
      'upgrade.cattle.io',
      'secrets.infisical.com',
      'policy',
      'autoscaling',
      'k3s.cattle.io',
      'velero.io',
    ].map((name) => ({ name })),
  });
  paths.set('/version', { gitVersion: k8sVersion, platform: 'linux/amd64' });

  const ready = (s = 'True') => [{ type: 'Ready', status: s }];
  list(
    '/api/v1/nodes',
    NODES.map((n, i) => ({
      metadata: {
        name: n.name,
        creationTimestamp: iso((210 - i * 60) * D),
        labels: {
          'node-role.kubernetes.io/control-plane': 'true',
          'node-role.kubernetes.io/etcd': 'true',
          'node-role.kubernetes.io/master': 'true',
        },
        // Broken: rke2-node-4 was cordoned for a disk swap five hours ago and never opened again.
        ...(broken && n.name === 'rke2-node-4'
          ? {
              managedFields: [
                {
                  manager: 'kubectl-cordon',
                  operation: 'Update',
                  apiVersion: 'v1',
                  time: iso(5.2 * H),
                  fieldsType: 'FieldsV1',
                  fieldsV1: { 'f:spec': { 'f:unschedulable': {} } },
                },
                {
                  manager: 'kubelet',
                  operation: 'Update',
                  apiVersion: 'v1',
                  time: iso(40_000),
                  fieldsType: 'FieldsV1',
                  fieldsV1: { 'f:status': { 'f:conditions': {} } },
                  subresource: 'status',
                },
              ],
            }
          : {}),
      },
      spec:
        broken && n.name === 'rke2-node-4'
          ? { unschedulable: true, taints: [{ key: 'node.kubernetes.io/unschedulable', effect: 'NoSchedule' }] }
          : {},
      status: {
        conditions: [
          ...ready(),
          { type: 'MemoryPressure', status: 'False' },
          { type: 'DiskPressure', status: 'False' },
          { type: 'PIDPressure', status: 'False' },
        ],
        capacity: { cpu: n.cpu, memory: n.mem, pods: '110' },
        allocatable: { cpu: n.cpu, memory: n.mem, pods: '110' },
        addresses: [
          { type: 'InternalIP', address: n.ip },
          { type: 'Hostname', address: n.name },
        ],
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
    NODES.map((n) => ({
      metadata: { name: n.name },
      usage: {
        cpu: `${n.usedCpu}m`,
        memory: `${Math.round((broken ? n.usedMem : Math.min(n.usedMem, 10.4)) * 1024)}Mi`,
      },
    })),
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
        ...(loose || (broken && w.acceptRoot) ? {} : { securityContext: HARDENED }),
        // Some workloads also cap CPU (four times the request), as real charts do; the loose ones set no limit at all.
        containers: [
          {
            name: w.name.split('-')[0],
            image,
            ...(w.envConfigMap
              ? {
                  envFrom: [{ configMapRef: { name: w.envConfigMap } }],
                  env: [
                    { name: 'SMTP_HOST', valueFrom: { configMapKeyRef: { name: w.envConfigMap, key: 'smtp_host' } } },
                  ],
                }
              : {}),
            resources: {
              requests: { cpu: w.cpu ?? '50m', memory: w.mem ?? '128Mi' },
              ...(loose
                ? {}
                : {
                    limits: {
                      memory: memLimit,
                      ...(hash(w.name) % 3 === 0 ? { cpu: `${cpuMilli(w.cpu ?? '50m') * 4}m` } : {}),
                    },
                  }),
            },
          },
        ],
        volumes: w.pvc ? [{ name: 'data', persistentVolumeClaim: { claimName: `data-${w.name}-0` } }] : [],
      },
    };
    const meta = {
      name: w.name,
      namespace: w.ns,
      creationTimestamp: iso(age),
      annotations: {} as Record<string, string>,
    };
    if (broken && w.acceptRoot) {
      meta.annotations['kubernanny.io/accept'] = `root: ${w.acceptRoot}`;
    }
    if (w.name === 'kured' && broken) {
      meta.annotations['weave.works/kured-node-lock'] = JSON.stringify({
        nodeID: 'rke2-node-5',
        created: iso(3 * H),
        TTL: 0,
      });
    }
    const status =
      w.kind === 'DaemonSet'
        ? { desiredNumberScheduled: desired, numberReady: readyCount }
        : { replicas: desired, readyReplicas: readyCount, availableReplicas: readyCount, updatedReplicas: desired };
    // A StatefulSet's volume comes from its volumeClaimTemplates (data-<name>-0), as charts make them.
    const claims =
      w.kind === 'StatefulSet' && w.pvc
        ? {
            volumeClaimTemplates: [
              {
                metadata: { name: 'data' },
                spec: {
                  accessModes: ['ReadWriteOnce'],
                  storageClassName: w.pvc.class,
                  resources: { requests: { storage: w.pvc.size } },
                },
              },
            ],
          }
        : {};
    const obj = {
      metadata: meta,
      spec: { replicas: desired, selector: { matchLabels: labels }, template, ...claims },
      status,
    };
    ({ Deployment: deployments, StatefulSet: statefulsets, DaemonSet: daemonsets })[w.kind].push(obj);

    const hashPart = (hash(w.name) % 0xfffff).toString(16).padStart(5, '0').slice(0, 5);
    for (let i = 0; i < desired; i++) {
      const node = NODES[(hash(w.name) + i) % NODES.length].name;
      const podName =
        w.kind === 'Deployment'
          ? `${w.name}-${hashPart}-${(hash(w.name + i) % 99999).toString(36)}`
          : w.kind === 'StatefulSet'
            ? `${w.name}-${i}`
            : `${w.name}-${(hash(w.name + node) % 99999).toString(36)}`;
      const isReady = i < readyCount;
      const owner =
        w.kind === 'Deployment'
          ? { kind: 'ReplicaSet', name: `${w.name}-${hashPart}` }
          : { kind: w.kind, name: w.name };
      const restarts = crash ? crash.restarts : hash(podName) % 7 === 0 ? 1 + (hash(podName) % 3) : 0;
      // Broken: Uptime Kuma's pod was on a node that died and was removed; it hangs in Terminating.
      const stranded = broken && w.name === 'uptime-kuma';
      pods.push({
        metadata: {
          name: podName,
          namespace: w.ns,
          labels: { ...labels, ...(w.kind === 'Deployment' ? { 'pod-template-hash': hashPart } : {}) },
          ownerReferences: [owner],
          creationTimestamp: iso(crash ? 2 * H : isReady ? age / 3 : 40 * 60_000),
          ...(stranded ? { deletionTimestamp: iso(26 * 60_000) } : {}),
        },
        spec: { ...template.spec, nodeName: stranded ? 'rke2-node-2' : node },
        status: {
          phase: isReady || crash ? 'Running' : 'Pending',
          conditions: [
            { type: 'Ready', status: isReady ? 'True' : 'False' },
            {
              type: 'PodScheduled',
              status: isReady || crash ? 'True' : 'False',
              message: isReady ? undefined : '0/3 nodes are available: 3 Insufficient memory.',
            },
          ],
          containerStatuses: [
            {
              name: template.spec.containers[0].name,
              ready: isReady,
              restartCount: restarts,
              state: crash ? { waiting: { reason: crash.reason, message: crash.message } } : { running: {} },
              // How the previous run ended: the crash, or for a few healthy pods an OOMKill or an error some hours ago.
              lastState: crash
                ? {
                    terminated: {
                      reason: crash.lastReason ?? 'Error',
                      exitCode: crash.lastReason === 'OOMKilled' ? 137 : 1,
                      startedAt: iso(4.5 * 60_000),
                      finishedAt: iso(4 * 60_000),
                    },
                  }
                : restarts > 0
                  ? {
                      terminated:
                        hash(podName) % 2 === 0
                          ? { reason: 'OOMKilled', exitCode: 137, finishedAt: iso((2 + (hash(podName) % 30)) * H) }
                          : { reason: 'Error', exitCode: 2, finishedAt: iso((1 + (hash(podName) % 50)) * H) },
                    }
                  : {},
            },
          ],
        },
      });
      podMetrics.push({
        metadata: { name: podName, namespace: w.ns },
        // Below the memory limit, as the kernel would keep it.
        containers: [
          {
            usage: {
              cpu: `${5 + (hash(podName) % 180)}m`,
              memory: `${Math.min(40 + (hash(podName) % 600), loose ? 4096 : Math.floor((parseQuantity(memLimit) / 2 ** 20) * 0.85))}Mi`,
            },
          },
        ],
      });
    }

    if (w.ports) {
      services.push({
        metadata: { name: w.name, namespace: w.ns },
        spec: {
          type: w.name === 'rke2-traefik' ? 'LoadBalancer' : 'ClusterIP',
          selector: labels,
          ports: w.ports.map((p) => ({ ...p, protocol: 'TCP' })),
        },
        status: w.name === 'rke2-traefik' ? { loadBalancer: { ingress: NODES.map((n) => ({ ip: n.ip })) } } : {},
      });
    }
    if (w.host) {
      const cert = CERTS.find((c) => c[2] === w.host);
      ingresses.push({
        metadata: {
          name: w.name,
          namespace: w.ns,
          annotations: { 'cert-manager.io/cluster-issuer': 'letsencrypt-prod' },
        },
        spec: {
          ingressClassName: 'traefik',
          tls: [{ hosts: [w.host], secretName: cert ? cert[1] : `${w.host}-tls` }],
          rules: [
            {
              host: w.host,
              http: {
                paths: [{ path: '/', backend: { service: { name: w.name, port: { number: w.ports?.[0].port } } } }],
              },
            },
          ],
        },
      });
    }
    if (w.pvc) {
      const pv = `pvc-${hash(w.name).toString(16)}-${hashPart}`;
      pvcs.push({
        metadata: { name: `data-${w.name}-0`, namespace: w.ns, creationTimestamp: iso(age) },
        spec: {
          storageClassName: w.pvc.class,
          accessModes: ['ReadWriteOnce'],
          volumeName: pv,
          resources: { requests: { storage: w.pvc.size } },
        },
        status: { phase: 'Bound', capacity: { storage: w.pvc.size } },
      });
      longhornVolumes.push({
        metadata: { name: pv },
        spec: { numberOfReplicas: 3, size: String(parseInt(w.pvc.size, 10) * 2 ** 30) },
        status: {
          state: 'attached',
          currentNodeID: NODES[hash(w.name) % NODES.length].name,
          robustness: w.name === 'weblate' && broken ? 'degraded' : 'healthy',
          kubernetesStatus: {
            namespace: w.ns,
            pvcName: `data-${w.name}-0`,
            workloadsStatus: [{ podName: `${w.name}-0` }],
          },
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
        metadata: {
          name,
          namespace: c.ns,
          labels: { 'cnpg.io/cluster': c.name },
          ownerReferences: [{ kind: 'Cluster', name: c.name }],
          creationTimestamp: iso(40 * D),
        },
        spec: {
          nodeName: NODES[i % 3].name,
          securityContext: HARDENED,
          containers: [
            {
              name: 'postgres',
              image: 'ghcr.io/cloudnative-pg/postgis:17-3.5',
              resources: { requests: { cpu: '100m', memory: '512Mi' }, limits: { memory: '1Gi' } },
            },
          ],
          volumes: [{ name: 'pgdata', persistentVolumeClaim: { claimName: name } }],
        },
        status: {
          phase: 'Running',
          conditions: ready(i <= c.ready ? 'True' : 'False'),
          containerStatuses: [{ name: 'postgres', ready: i <= c.ready, restartCount: 0, state: { running: {} } }],
        },
      });
      podMetrics.push({
        metadata: { name, namespace: c.ns },
        containers: [{ usage: { cpu: `${30 + i * 20}m`, memory: `${300 + i * 90}Mi` } }],
      });
      pvcs.push({
        metadata: { name, namespace: c.ns, creationTimestamp: iso(40 * D) },
        spec: {
          storageClassName: 'local-path',
          accessModes: ['ReadWriteOnce'],
          volumeName: `pvc-local-${name}`,
          resources: { requests: { storage: c.ns === 'default' ? '50Gi' : '10Gi' } },
        },
        status: { phase: 'Bound', capacity: { storage: c.ns === 'default' ? '50Gi' : '10Gi' } },
      });
    }
  }
  if (broken)
    pvcs.push({
      metadata: { name: 'uploads', namespace: 'discourse', creationTimestamp: iso(25 * 60_000) },
      spec: {
        storageClassName: 'longhorn',
        accessModes: ['ReadWriteMany'],
        resources: { requests: { storage: '20Gi' } },
      },
      status: { phase: 'Pending' },
    });

  // etcd static pods
  for (const n of NODES) {
    pods.push({
      metadata: {
        name: `etcd-${n.name}`,
        namespace: 'kube-system',
        labels: { component: 'etcd', tier: 'control-plane' },
        ownerReferences: [{ kind: 'Node', name: n.name }],
        creationTimestamp: iso(3 * D),
      },
      spec: {
        nodeName: n.name,
        containers: [
          {
            name: 'etcd',
            image: 'rancher/hardened-etcd:v3.5.21-k3s1',
            resources: { requests: { cpu: '200m', memory: '512Mi' } },
          },
        ],
      },
      status: {
        phase: 'Running',
        conditions: ready(),
        containerStatuses: [{ name: 'etcd', ready: true, restartCount: 0, state: { running: {} } }],
      },
    });
  }

  // Jobs: a nightly CronJob whose last run failed.
  const cron = {
    metadata: { name: 'appstore-metrics-reviews', namespace: 'default', creationTimestamp: iso(90 * D) },
    spec: { schedule: '0 6 * * *' },
    status: { lastScheduleTime: iso(6 * H) },
  };
  const allJobs = [
    {
      metadata: {
        name: 'appstore-metrics-reviews-29401200',
        namespace: 'default',
        ownerReferences: [{ kind: 'CronJob', name: 'appstore-metrics-reviews' }],
        creationTimestamp: iso(30 * H),
      },
      status: {
        succeeded: 1,
        completionTime: iso(30 * H - 60_000),
        conditions: [{ type: 'Complete', status: 'True' }],
      },
    },
    {
      metadata: {
        name: 'appstore-metrics-reviews-29402640',
        namespace: 'default',
        ownerReferences: [{ kind: 'CronJob', name: 'appstore-metrics-reviews' }],
        creationTimestamp: iso(6 * H),
      },
      status: {
        failed: 3,
        conditions: [
          {
            type: 'Failed',
            status: 'True',
            reason: 'BackoffLimitExceeded',
            message: 'Job has reached the specified backoff limit',
            lastTransitionTime: iso(5.8 * H),
          },
        ],
      },
    },
  ];
  const jobs = broken ? allJobs : allJobs.slice(0, 1);
  if (broken)
    pods.push({
      metadata: {
        name: 'appstore-metrics-reviews-29402640-x7k2p',
        namespace: 'default',
        ownerReferences: [{ kind: 'Job', name: 'appstore-metrics-reviews-29402640' }],
        creationTimestamp: iso(5.9 * H),
      },
      spec: {
        nodeName: 'rke2-node-4',
        securityContext: HARDENED,
        containers: [
          {
            name: 'reviews',
            image: 'ghcr.io/acme/appstore-metrics:2026-10-02-7',
            resources: { limits: { memory: '256Mi' } },
          },
        ],
      },
      status: {
        phase: 'Failed',
        conditions: ready('False'),
        containerStatuses: [
          { name: 'reviews', ready: false, restartCount: 0, state: { terminated: { reason: 'Error' } } },
        ],
      },
    });

  // Broken: two web app pods the kubelet evicted under memory pressure last night; the ReplicaSet replaced them.
  if (broken) {
    for (const suffix of ['k2v9q', 'x8m4d']) {
      pods.push({
        metadata: {
          name: `shop-web-app-chart-6b8f9c7d4-${suffix}`,
          namespace: 'default',
          labels: { 'app.kubernetes.io/name': 'shop-web-app-chart' },
          ownerReferences: [{ kind: 'ReplicaSet', name: 'shop-web-app-chart-6b8f9c7d4' }],
          creationTimestamp: iso(11 * H),
        },
        spec: {
          nodeName: 'rke2-node-5',
          securityContext: HARDENED,
          containers: [
            {
              name: 'shop',
              image: 'ghcr.io/acme/shop-web-app:2026-11-24-118',
              resources: { limits: { memory: '256Mi' } },
            },
          ],
        },
        status: {
          phase: 'Failed',
          reason: 'Evicted',
          message: 'The node was low on resource: memory. Threshold quantity: 100Mi, available: 87316Ki.',
        },
      });
    }
  }
  list('/api/v1/pods', pods);
  list(
    '/api/v1/namespaces/kube-system/pods',
    pods.filter((p) => (p.metadata as Obj).namespace === 'kube-system'),
  );
  list('/apis/metrics.k8s.io/v1beta1/pods', podMetrics);
  list(
    '/api/v1/namespaces',
    [
      ...new Set(
        workloadSpecs
          .map((w) => w.ns)
          .concat(
            CNPG.map((c) => c.ns),
            ['kube-public', 'kube-node-lease'],
          ),
      ),
    ].map((name) => ({ metadata: { name } })),
  );
  list('/apis/apps/v1/deployments', deployments);
  list('/apis/apps/v1/statefulsets', statefulsets);
  list('/apis/apps/v1/daemonsets', daemonsets);
  list('/apis/batch/v1/jobs', jobs);
  // The descheduler runs as a CronJob, as it does in many homelabs.
  const descheduler = {
    metadata: { name: 'descheduler', namespace: 'kube-system', creationTimestamp: iso(60 * D) },
    spec: {
      schedule: '*/15 4-7 * * *',
      jobTemplate: {
        spec: {
          template: {
            spec: { containers: [{ name: 'descheduler', image: 'registry.k8s.io/descheduler/descheduler:v0.33.0' }] },
          },
        },
      },
    },
    status: { lastScheduleTime: iso(8 * H), lastSuccessfulTime: iso(8 * H) },
  };
  list('/apis/batch/v1/cronjobs', [cron, descheduler]);
  list('/api/v1/services', services);
  list('/apis/networking.k8s.io/v1/ingresses', ingresses);
  list('/api/v1/persistentvolumeclaims', pvcs);
  list('/apis/storage.k8s.io/v1/storageclasses', [
    {
      metadata: { name: 'longhorn', annotations: { 'storageclass.kubernetes.io/is-default-class': 'true' } },
      provisioner: 'driver.longhorn.io',
      reclaimPolicy: 'Delete',
      allowVolumeExpansion: true,
    },
    {
      metadata: { name: 'local-path' },
      provisioner: 'rancher.io/local-path',
      reclaimPolicy: 'Delete',
      allowVolumeExpansion: false,
    },
  ]);
  list(
    '/api/v1/events?fieldSelector=type%3DWarning',
    !broken
      ? []
      : [
          {
            metadata: { name: 'e1', namespace: 'default' },
            type: 'Warning',
            reason: 'BackOff',
            message: 'Back-off restarting failed container importer in pod social-importer',
            count: 14,
            lastTimestamp: iso(2 * 60_000),
            involvedObject: { kind: 'Pod', name: 'social-importer', namespace: 'default' },
          },
          {
            metadata: { name: 'e2', namespace: 'discourse' },
            type: 'Warning',
            reason: 'FailedScheduling',
            message: '0/3 nodes are available: 3 Insufficient memory. preemption: 0/3 nodes are available.',
            count: 31,
            lastTimestamp: iso(4 * 60_000),
            involvedObject: { kind: 'Pod', name: 'discourse', namespace: 'discourse' },
          },
          // Kubernetes writes a new Event when the message changes; the view groups it with e2.
          {
            metadata: { name: 'e2b', namespace: 'discourse' },
            type: 'Warning',
            reason: 'FailedScheduling',
            message: '0/3 nodes are available: 1 node(s) were unschedulable, 2 Insufficient memory.',
            count: 4,
            firstTimestamp: iso(39 * 60_000),
            lastTimestamp: iso(31 * 60_000),
            involvedObject: { kind: 'Pod', name: 'discourse', namespace: 'discourse' },
          },
          {
            metadata: { name: 'e3', namespace: 'discourse' },
            type: 'Warning',
            reason: 'ProvisioningFailed',
            message:
              'failed to provision volume with StorageClass "longhorn": ReadWriteMany needs the share manager, which is disabled',
            count: 6,
            lastTimestamp: iso(9 * 60_000),
            involvedObject: { kind: 'PersistentVolumeClaim', name: 'uploads', namespace: 'discourse' },
          },
          {
            metadata: { name: 'e4', namespace: 'longhorn-system' },
            type: 'Warning',
            reason: 'Degraded',
            message: 'volume is degraded: replica on rke2-node-5 is rebuilding',
            count: 1,
            lastTimestamp: iso(41 * 60_000),
            involvedObject: { kind: 'Volume', name: 'pvc-weblate', namespace: 'longhorn-system' },
          },
          {
            metadata: { name: 'e5', namespace: 'default' },
            type: 'Warning',
            reason: 'BackoffLimitExceeded',
            message: 'Job has reached the specified backoff limit',
            count: 1,
            lastTimestamp: iso(5.8 * H),
            involvedObject: { kind: 'Job', name: 'appstore-metrics-reviews-29402640', namespace: 'default' },
          },
          {
            metadata: { name: 'e6', namespace: 'kube-system' },
            type: 'Warning',
            reason: 'NodeNotReady',
            message: 'Node rke2-node-5 status is now: NodeNotReady',
            count: 1,
            lastTimestamp: iso(3 * H),
            involvedObject: { kind: 'Node', name: 'rke2-node-5' },
          },
        ],
  );

  // CRDs
  list('/apis/longhorn.io/v1beta2/volumes', longhornVolumes);
  list(
    '/apis/longhorn.io/v1beta2/nodes',
    NODES.map((n, i) => ({
      metadata: { name: n.name },
      spec: { allowScheduling: true },
      status: {
        conditions: ready(),
        diskStatus: {
          default: {
            storageMaximum: [160, 320, 160][i] * 2 ** 30,
            storageAvailable: [61, 188, 22][i] * 2 ** 30,
            storageScheduled: [80, 120, 110][i] * 2 ** 30,
          },
        },
      },
    })),
  );
  list(
    '/apis/cert-manager.io/v1/certificates',
    CERTS.map(([ns, secret, host, d]) => [ns, secret, host, warn ? d : Math.max(d, 49)] as const).map(
      ([ns, secret, host, days]) => ({
        metadata: { name: secret, namespace: ns },
        spec: { secretName: secret, dnsNames: [host] },
        status: {
          notAfter: new Date(now.getTime() + days * D).toISOString(),
          renewalTime: new Date(now.getTime() + (days - 30) * D).toISOString(),
          conditions: ready(),
        },
      }),
    ),
  );
  list('/apis/cert-manager.io/v1/clusterissuers', [
    { metadata: { name: 'letsencrypt-prod' }, status: { conditions: ready() } },
    { metadata: { name: 'letsencrypt-staging' }, status: { conditions: ready() } },
  ]);
  list(
    '/apis/argoproj.io/v1alpha1/applications',
    // Two manual apps with a change waiting in every scenario: routine ("ready to sync"), never an issue. In the broken one
    // weblate-chart has waited nine days, past the week after which a hint asks whether the sync was forgotten.
    ARGO_APPS.map(
      ([name, s0, h0, auto]) =>
        [name, PENDING_APPS[name] ? 'OutOfSync' : broken ? s0 : 'Synced', broken ? h0 : 'Healthy', auto] as const,
    ).map(([name, sync, health, auto]) => ({
      metadata: { name, namespace: 'argocd' },
      spec: {
        project: 'default',
        destination: { namespace: PENDING_APPS[name]?.namespace ?? 'default' },
        syncPolicy: auto ? { automated: { prune: true, selfHeal: true } } : {},
        ...(name === ROLLBACK_APP ? { source: ROLLBACK_SOURCE } : {}),
        ...(PENDING_APPS[name]?.image
          ? {
              source: {
                repoURL: 'https://git.example/homelab/gitops.git',
                path: `apps/${name}`,
                helm: {
                  parameters: [
                    { name: 'image.name', value: PENDING_APPS[name]!.image!.repo },
                    { name: 'image.tag', value: PENDING_APPS[name]!.image!.to },
                  ],
                },
              },
            }
          : {}),
      },
      status: {
        sync: {
          status: sync,
          ...(name === ROLLBACK_APP
            ? { revision: ROLLBACK_HISTORY[2]!.revision }
            : PENDING_APPS[name]
              ? { revision: '9b1d0c3e5f7a2b4c6d8e0f1a3b5c7d9e1f2a4b6c' }
              : {}),
        },
        // Broken: discourse-new's sync waits for a migration hook Job that never finishes.
        ...(broken && name === 'discourse-new'
          ? {
              operationState: {
                phase: 'Running',
                startedAt: iso(47 * 60_000),
                message: 'waiting for completion of hook batch/Job/discourse-migrate',
              },
            }
          : {}),
        ...(PENDING_APPS[name]
          ? {
              operationState: {
                phase: 'Succeeded',
                finishedAt: iso((broken && name === 'weblate-chart' ? 9 * 24 : PENDING_APPS[name]!.hoursAgo) * H),
                syncResult: { revision: '4e6a8c0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2c' },
              },
              summary: {
                images: PENDING_APPS[name]!.image
                  ? [`${PENDING_APPS[name]!.image!.repo}:${PENDING_APPS[name]!.image!.from}`]
                  : [],
              },
            }
          : {}),
        // One manual-sync app with a history, so the rollback (on in the demo) has something to show.
        ...(name === ROLLBACK_APP
          ? {
              history: ROLLBACK_HISTORY.map((h, i) => ({
                ...h,
                deployedAt: iso([9 * D, 3 * D, 5 * H][i]!),
                source: ROLLBACK_SOURCE,
              })),
            }
          : {}),
        health: { status: health },
        resources:
          health === 'Degraded'
            ? [
                {
                  kind: 'Deployment',
                  name: 'social-importer',
                  namespace: 'default',
                  health: {
                    status: 'Degraded',
                    message: 'Deployment "social-importer" exceeded its progress deadline',
                  },
                },
              ]
            : (PENDING_APPS[name]?.resources ?? []),
      },
    })),
  );
  list(
    '/apis/postgresql.cnpg.io/v1/clusters',
    cnpg.map((c) => ({
      metadata: { name: c.name, namespace: c.ns },
      spec: {
        instances: c.instances,
        storage: { size: c.ns === 'default' ? '50Gi' : '10Gi' },
        backup: { barmanObjectStore: { destinationPath: `s3://shop-backups/cnpg/${c.name}` } },
      },
      status: {
        pgDataImageInfo: { majorVersion: 17 },
        phase: c.ready === c.instances ? 'Cluster in healthy state' : 'Waiting for the instances to become active',
        instances: c.instances,
        readyInstances: c.ready,
        currentPrimary: `${c.name}-1`,
        lastSuccessfulBackup: iso(c.backupHoursAgo * H),
        conditions: [{ type: 'ContinuousArchiving', status: c.archiving ? 'True' : 'False' }],
      },
    })),
  );
  // One daily ScheduledBackup per cluster, like the real ones (status as the operator writes it).
  list(
    '/apis/postgresql.cnpg.io/v1/scheduledbackups',
    cnpg.map((c, i) => ({
      metadata: { name: `${c.name}-daily`, namespace: c.ns },
      spec: { schedule: `0 0 ${2 + i} * * *`, cluster: { name: c.name } },
      status: { lastScheduleTime: iso(c.backupHoursAgo * H), nextScheduleTime: iso(-(24 - c.backupHoursAgo) * H) },
    })),
  );
  // Three replicas per Longhorn volume, one per node; the degraded one has one rebuilding.
  list(
    '/apis/longhorn.io/v1beta2/replicas',
    longhornVolumes.flatMap((obj) => {
      const v = obj as { metadata: { name: string }; status: { robustness: string } };
      return NODES.map((n, i) => ({
        metadata: { name: `${v.metadata.name}-r-${i}`, namespace: 'longhorn-system' },
        spec: {
          volumeName: v.metadata.name,
          nodeID: n.name,
          failedAt: v.status.robustness === 'degraded' && i === 2 ? iso(41 * 60_000) : '',
        },
        status: { currentState: v.status.robustness === 'degraded' && i === 2 ? 'error' : 'running' },
      }));
    }),
  );
  list('/apis/upgrade.cattle.io/v1/plans', [
    {
      metadata: { name: 'server-plan', namespace: 'system-upgrade' },
      spec: { channel: 'https://update.rke2.io/v1-release/channels/stable' },
      status: { latestVersion: k8sVersion, applying: [], conditions: [{ type: 'LatestResolved', status: 'True' }] },
    },
  ]);
  // The Infisical operator has no Ready condition: InfisicalStaticSecret reports LastReconcileStatus.
  list('/apis/secrets.infisical.com/v1alpha1/infisicalsecrets', []);
  list('/apis/secrets.infisical.com/v1alpha1/infisicaldynamicsecrets', []);
  list('/apis/secrets.infisical.com/v1alpha1/infisicalpushsecrets', []);
  list(
    '/apis/secrets.infisical.com/v1beta1/infisicalstaticsecrets',
    ['shop-api-secret', 'cloudflare-api-token', 'alertmanager-smtp'].map((name) => ({
      metadata: { name, namespace: 'default' },
      status: {
        error: false,
        conditions: [
          // Broken: the token of the machine identity expired; it has been renewed since, the operator retries only every few minutes.
          broken && name === 'cloudflare-api-token'
            ? {
                type: 'secrets.infisical.com/LastReconcileStatus',
                status: 'False',
                reason: 'Error',
                message: 'Failed to authenticate: 401 token expired',
              }
            : {
                type: 'secrets.infisical.com/LastReconcileStatus',
                status: 'True',
                reason: 'OK',
                message: 'Reconciliation successful',
              },
          {
            type: 'secrets.infisical.com/LastReconcileAuthMethod',
            status: 'True',
            reason: 'OK',
            message: 'kubernetes',
          },
        ],
      },
    })),
  );

  // PodDisruptionBudgets: one with a single pod and minAvailable 1 blocks every drain.
  const pdb = (ns: string, name: string, expected: number, min: number) => ({
    metadata: { name, namespace: ns },
    spec: { minAvailable: min },
    status: {
      expectedPods: expected,
      currentHealthy: expected,
      desiredHealthy: min,
      disruptionsAllowed: Math.max(0, expected - min),
    },
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
        {
          type: 'ScalingLimited',
          status: limited ? 'True' : 'False',
          reason: limited ? 'TooManyReplicas' : 'DesiredWithinRange',
        },
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
      spec: {
        snapshotName: `etcd-snapshot-rke2-node-1-${i}`,
        nodeName: 's3',
        location: 's3://shop-backups/etcd',
        s3: {},
      },
      status: { creationTime: iso(h * H), readyToUse: true, size: '48Mi' },
    })),
    // RKE2 also keeps each snapshot on the node that took it.
    ...NODES.map((n, i) => ({
      metadata: { name: `local-etcd-snapshot-${n.name}-0`, creationTimestamp: iso(3 * H) },
      spec: {
        snapshotName: `etcd-snapshot-${n.name}-0`,
        nodeName: n.name,
        location: `file:///var/lib/rancher/rke2/server/db/snapshots/etcd-snapshot-${n.name}-${i}`,
      },
      status: { creationTime: iso(3 * H), readyToUse: true, size: '48Mi' },
    })),
  ]);

  // Longhorn backups to S3, nightly at 02:00; one failed when broken.
  list('/apis/longhorn.io/v1beta2/backuptargets', [
    {
      metadata: { name: 'default' },
      spec: { backupTargetURL: 's3://shop-backups@eu-central-2/longhorn-backups' },
      status: { available: true },
    },
  ]);
  list(
    '/apis/longhorn.io/v1beta2/backups',
    longhornVolumes
      .filter((v) => !/prometheus|loki/.test(((v.status as Obj).kubernetesStatus as { pvcName: string }).pvcName))
      .flatMap((v) => {
        const volume = (v.metadata as { name: string }).name;
        const failed = broken && volume.startsWith(`pvc-${hash('weblate').toString(16)}-`);
        return [
          {
            metadata: { name: `backup-${volume}-a` },
            status: { state: 'Completed', volumeName: volume, backupCreatedAt: iso(34 * H) },
          },
          {
            metadata: { name: `backup-${volume}-b` },
            status: failed
              ? {
                  state: 'Error',
                  volumeName: volume,
                  backupCreatedAt: iso(10 * H),
                  error: 'failed to upload block: context deadline exceeded (S3 eu-central-2)',
                }
              : { state: 'Completed', volumeName: volume, backupCreatedAt: iso(10 * H) },
          },
        ];
      }),
  );

  // Velero: a nightly schedule for the apps and a weekly one for everything, to S3. The nightly one partly failed when broken.
  const velero = (schedule: string, n: number, hoursAgo: number, phase = 'Completed', extra: Obj = {}) => ({
    metadata: {
      name: `${schedule}-${n}`,
      namespace: 'velero',
      labels: { 'velero.io/schedule-name': schedule },
      creationTimestamp: iso(hoursAgo * H),
    },
    spec: { storageLocation: 'default' },
    status: {
      phase,
      startTimestamp: iso(hoursAgo * H),
      completionTimestamp: iso(hoursAgo * H - 9 * 60_000),
      errors: 0,
      warnings: 0,
      ...extra,
    },
  });
  if (broken) {
    // Rook Ceph, Kyverno and Gatekeeper run in the broken cluster only: Ceph remembers a crashed daemon, one Kyverno policy finds pgadmin running as root.
    list('/apis/ceph.rook.io/v1/cephclusters', [
      {
        metadata: { name: 'rook-ceph', namespace: 'rook-ceph' },
        status: {
          phase: 'Ready',
          conditions: [
            { type: 'Ready', status: 'True', reason: 'ClusterCreated', message: 'Cluster created successfully' },
          ],
          ceph: {
            health: 'HEALTH_WARN',
            lastChecked: iso(40_000),
            details: { RECENT_CRASH: { message: '1 daemons have recently crashed', severity: 'HEALTH_WARN' } },
            capacity: { bytesTotal: 6 * 2 ** 40, bytesUsed: 3.4 * 2 ** 40, bytesAvailable: 2.6 * 2 ** 40 },
          },
        },
      },
    ]);
    const kyvernoPolicy = (name: string, mode: string) => ({
      metadata: { name },
      spec: { validationFailureAction: mode, rules: [{ name }] },
      status: { conditions: ready() },
    });
    list('/apis/kyverno.io/v1/clusterpolicies', [
      kyvernoPolicy('require-run-as-nonroot', 'Audit'),
      kyvernoPolicy('disallow-latest-tag', 'Audit'),
      kyvernoPolicy('restrict-image-registries', 'Enforce'),
    ]);
    list('/apis/kyverno.io/v1/policies', []);
    list('/apis/wgpolicyk8s.io/v1alpha2/policyreports', [
      {
        metadata: { name: 'pgadmin-report', namespace: 'pgadmin' },
        results: [
          {
            policy: 'require-run-as-nonroot',
            rule: 'run-as-non-root',
            result: 'fail',
            message:
              'validation error: Running as root is not allowed. Set runAsNonRoot to true. rule run-as-non-root failed at path /spec/securityContext/runAsNonRoot/',
          },
          { policy: 'disallow-latest-tag', rule: 'require-image-tag', result: 'pass' },
          { policy: 'restrict-image-registries', rule: 'validate-registries', result: 'pass' },
        ],
      },
    ]);
    list('/apis/wgpolicyk8s.io/v1alpha2/clusterpolicyreports', []);
    // Trivy Operator scanned two workloads the built-in lookup cannot see: the own-image app (a fixable high,
    // a warning) and Valkey (an unfixed medium, a hint). The third report is of an image social-importer no
    // longer runs and is skipped. Advisory records trimmed to the fields Kubernanny reads.
    list('/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports', [
      trivyReport(
        'default',
        'ReplicaSet',
        'social-importer-7d9f8b6c5',
        'social',
        { server: 'ghcr.io', repository: 'acme/social-importer', tag: '2026-11-20-3' },
        iso(5 * H),
        [
          {
            vulnerabilityID: 'CVE-2024-21538',
            severity: 'HIGH',
            score: 7.5,
            resource: 'cross-spawn',
            installedVersion: '7.0.3',
            fixedVersion: '7.0.5',
          },
        ],
      ),
      trivyReport(
        'default',
        'ReplicaSet',
        'social-importer-5c4b9d7f8',
        'social',
        { server: 'ghcr.io', repository: 'acme/social-importer', tag: '2026-11-02-1' },
        iso(6 * H),
        [
          {
            vulnerabilityID: 'CVE-2024-21538',
            severity: 'HIGH',
            score: 7.5,
            resource: 'cross-spawn',
            installedVersion: '7.0.3',
            fixedVersion: '7.0.5',
          },
        ],
      ),
      trivyReport(
        'default',
        'StatefulSet',
        'shop-api-valkey',
        'shop',
        { server: 'index.docker.io', repository: 'valkey/valkey', tag: '8.1-alpine' },
        iso(7 * H),
        [
          {
            vulnerabilityID: 'CVE-2023-42363',
            severity: 'MEDIUM',
            score: 5.5,
            resource: 'busybox',
            installedVersion: '1.37.0-r18',
            fixedVersion: '',
          },
        ],
      ),
    ]);
    list('/apis/aquasecurity.github.io/v1alpha1/clustervulnerabilityreports', []);
    list('/apis/templates.gatekeeper.sh/v1/constrainttemplates', [
      {
        metadata: { name: 'k8srequiredlabels' },
        spec: { crd: { spec: { names: { kind: 'K8sRequiredLabels' } } } },
        status: { created: true, byPod: [{ id: 'gatekeeper-audit' }] },
      },
    ]);
    list('/apis/constraints.gatekeeper.sh/v1beta1/k8srequiredlabels', [
      {
        kind: 'K8sRequiredLabels',
        metadata: { name: 'ns-must-have-owner' },
        spec: { enforcementAction: 'dryrun' },
        status: { totalViolations: 0, byPod: [{ id: 'gatekeeper-audit' }] },
      },
    ]);
  }
  list('/apis/velero.io/v1/schedules', [
    {
      metadata: { name: 'daily-apps', namespace: 'velero' },
      spec: {
        schedule: '0 3 * * *',
        template: {
          includedNamespaces: ['default', 'weblate', 'discourse'],
          storageLocation: 'default',
          ttl: '720h0m0s',
        },
      },
    },
    {
      metadata: { name: 'weekly-full', namespace: 'velero' },
      spec: { schedule: '0 4 * * 0', template: { storageLocation: 'default', ttl: '2160h0m0s' } },
    },
  ]);
  list('/apis/velero.io/v1/backups', [
    velero('daily-apps', 1, 52),
    velero('daily-apps', 2, 28),
    broken ? velero('daily-apps', 3, 4, 'PartiallyFailed', { errors: 2, warnings: 1 }) : velero('daily-apps', 3, 4),
    velero('weekly-full', 1, 7 * 24 + 20),
    velero('weekly-full', 2, 20),
  ]);
  return paths;
}

/** A Trivy Operator VulnerabilityReport for one container, with the summary counted from its advisories. */
function trivyReport(
  ns: string,
  kind: string,
  name: string,
  container: string,
  artifact: { server: string; repository: string; tag: string },
  updated: string,
  vulnerabilities: {
    vulnerabilityID: string;
    severity: string;
    score: number;
    resource: string;
    installedVersion: string;
    fixedVersion: string;
  }[],
): Obj {
  const count = (s: string) => vulnerabilities.filter((v) => v.severity === s).length;
  return {
    metadata: {
      name: `${kind.toLowerCase()}-${name}-${container}`,
      namespace: ns,
      creationTimestamp: updated,
      labels: {
        'trivy-operator.resource.kind': kind,
        'trivy-operator.resource.name': name,
        'trivy-operator.resource.namespace': ns,
        'trivy-operator.container.name': container,
      },
    },
    report: {
      updateTimestamp: updated,
      registry: { server: artifact.server },
      artifact: { repository: artifact.repository, tag: artifact.tag },
      scanner: { name: 'Trivy', vendor: 'Aqua Security', version: '0.76.1' },
      summary: {
        criticalCount: count('CRITICAL'),
        highCount: count('HIGH'),
        mediumCount: count('MEDIUM'),
        lowCount: count('LOW'),
        unknownCount: count('UNKNOWN'),
        noneCount: 0,
      },
      vulnerabilities,
    },
  };
}

/** Prometheus answers good enough to fill every chart and stat in the app. */
function prometheusAnswer(path: string, now: Date, scenario: DemoScenario): unknown {
  const broken = scenario === 'broken';
  const url = new URL(path, 'http://x');
  const query = url.searchParams.get('query') ?? '';
  const vector = (result: { metric: Record<string, string>; value: number }[]) => ({
    status: 'success',
    data: {
      resultType: 'vector',
      result: result.map((r) => ({ metric: r.metric, value: [now.getTime() / 1000, String(r.value)] })),
    },
  });
  const standard = url.pathname.endsWith('/query') ? standardAlertsAnswer(query, scenario) : null;
  if (standard) {
    return vector(standard);
  }
  if (url.pathname.endsWith('/query_range')) {
    const start = Number(url.searchParams.get('start'));
    const end = Number(url.searchParams.get('end'));
    const step = Number(url.searchParams.get('step'));
    const wave = (seed: number, base: number, amp: number) => {
      const values: [number, string][] = [];
      for (let t = start; t <= end; t += step) {
        const v =
          base +
          amp * Math.sin(t / 2400 + seed) +
          (amp / 3) * Math.sin(t / 530 + seed * 3) +
          (seed % 2 ? 0 : (amp / 4) * Math.max(0, Math.sin(t / 7000)));
        values.push([t, String(Math.max(0, v))]);
      }
      return values;
    };
    const matrix = (series: { metric: Record<string, string>; seed: number; base: number; amp: number }[]) => ({
      status: 'success',
      data: {
        resultType: 'matrix',
        result: series.map((s) => ({ metric: s.metric, values: wave(s.seed, s.base, s.amp) })),
      },
    });
    if (query.includes('by (instance)')) {
      const memory = query.includes('Mem');
      return matrix(
        NODES.map((n, i) => ({
          metric: { instance: `${n.ip}:9100` },
          seed: i + (memory ? 7 : 0),
          base: memory ? n.usedMem / Number.parseInt(n.mem, 10) : n.usedCpu / (Number(n.cpu) * 1000),
          amp: memory ? 0.04 : 0.12,
        })),
      );
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
  if (url.pathname.endsWith('/targets')) {
    // Prometheus' own view of its targets; the demo only lists the one that is down, with the error it reports.
    return {
      status: 'success',
      data: {
        activeTargets: !broken
          ? []
          : [
              {
                health: 'down',
                labels: { job: 'blackbox', instance: 'https://community.shop.example' },
                scrapePool: 'blackbox',
                lastError: 'Get "https://community.shop.example": context deadline exceeded',
                lastScrape: new Date(now.getTime() - 20_000).toISOString(),
              },
            ],
      },
    };
  }
  if (query.includes('prometheus_tsdb_storage_blocks_bytes')) {
    return vector([{ metric: {}, value: 38.6 * 2 ** 30 }]);
  }
  if (query.includes('prometheus_tsdb_retention_limit_seconds')) {
    return vector([{ metric: {}, value: 14 * 86_400 }]);
  }
  if (query.includes('prometheus_rule_evaluation_failures_total')) {
    return vector([{ metric: {}, value: 0 }]);
  }
  if (
    (query.includes('max by (pod)') && query.includes('etcd_')) ||
    (query.includes('le, pod') && query.includes('etcd_disk_wal_fsync'))
  ) {
    // etcd per member: rke2-node-1 leads; sizes and fsync differ a little.
    const value = (i: number) =>
      query.includes('is_leader')
        ? i === 0
          ? 1
          : 0
        : query.includes('db_total_size')
          ? [93, 121, 76][i]! * 2 ** 20
          : [0.0042, 0.0061, 0.0038][i]!;
    return vector(NODES.map((n, i) => ({ metric: { pod: `etcd-${n.name}` }, value: value(i) })));
  }
  if (query.includes('loki_distributor_bytes_received_total')) {
    return vector([{ metric: {}, value: 41_200 }]);
  }
  if (query.includes('loki_request_duration_seconds_count')) {
    return vector([{ metric: {}, value: 0 }]);
  }
  if (query.includes('count by (job) (up)')) {
    return vector(
      [
        'apiserver',
        'kubelet',
        'node-exporter',
        'kube-state-metrics',
        'etcd',
        'coredns',
        'longhorn',
        'shop-api',
        'loki',
        'traefik',
        'blackbox',
      ].map((job, i) => ({ metric: { job }, value: [3, 3, 3, 1, 3, 2, 3, 3, 1, 3, 12][i] })),
    );
  }
  if (query === 'up == 0') {
    return vector(
      !broken ? [] : [{ metric: { job: 'blackbox', instance: 'https://community.shop.example' }, value: 0 }],
    );
  }
  if (query.includes('prometheus_tsdb_head_series')) {
    return vector([{ metric: {}, value: 412_337 }]);
  }
  if (query.includes('node_filesystem_avail_bytes')) {
    return vector(
      NODES.map((n, i) => ({ metric: { instance: `${n.ip}:9100` }, value: [0.61, 0.44, broken ? 0.88 : 0.52][i] })),
    );
  }
  if (query.includes('kubelet_volume_stats_used_bytes')) {
    return vector([
      {
        metric: {
          namespace: 'monitoring',
          persistentvolumeclaim: 'data-prometheus-monitoring-chart-kube-prom-prometheus-0',
        },
        value: (broken ? 44.1 : 41.3) * 2 ** 30,
      },
      { metric: { namespace: 'monitoring', persistentvolumeclaim: 'data-loki-0' }, value: 12.1 * 2 ** 30 },
      { metric: { namespace: 'default', persistentvolumeclaim: 'shop-api-pg-1' }, value: 21.7 * 2 ** 30 },
      { metric: { namespace: 'weblate', persistentvolumeclaim: 'data-weblate-0' }, value: 6.4 * 2 ** 30 },
    ]);
  }
  if (query.includes('kubelet_volume_stats_capacity_bytes')) {
    return vector([
      {
        metric: {
          namespace: 'monitoring',
          persistentvolumeclaim: 'data-prometheus-monitoring-chart-kube-prom-prometheus-0',
        },
        value: 50 * 2 ** 30,
      },
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
    return vector(
      scenario !== 'warning'
        ? []
        : [
            {
              metric: {
                group: 'resource.k8s.io',
                version: 'v1beta1',
                resource: 'deviceclasses',
                removed_release: removed,
              },
              value: 1,
            },
          ],
    );
  }
  if (query.includes('kured_reboot_required')) {
    return vector(!broken ? [] : [{ metric: { node: 'rke2-node-5' }, value: 1 }]);
  }
  if (query.includes('loki_distributor_lines_received_total')) {
    return vector([{ metric: {}, value: 84.2 }]);
  }
  if (query.includes('traefik_router_requests_total')) {
    // Requests per router over 15 minutes; the forum, half down when broken, answers one request in nine with a 5xx.
    const errors = query.includes('5..');
    const routers: [string, number, number][] = [
      ['default-shop-api-chart-api-shop-example@kubernetes', 5210, 3],
      ['default-shop-web-app-chart-shop-example@kubernetes', 8930, 1],
      ['discourse-discourse-community-shop-example@kubernetes', 1840, broken ? 212 : 2],
      ['weblate-weblate-translate-shop-example@kubernetes', 96, 2],
    ];
    return vector(routers.map(([router, total, failed]) => ({ metric: { router }, value: errors ? failed : total })));
  }
  if (query.includes('node_timex_offset_seconds')) {
    return vector(NODES.map((n, i) => ({ metric: { instance: `${n.ip}:9100` }, value: [0.0021, -0.0007, 0.0034][i] })));
  }
  if (query.includes('node_timex_sync_status')) {
    return vector(NODES.map((n) => ({ metric: { instance: `${n.ip}:9100` }, value: 1 })));
  }
  if (query.includes('node_timex_maxerror_seconds')) {
    return vector(NODES.map((n) => ({ metric: { instance: `${n.ip}:9100` }, value: 0.012 })));
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
    const time = (minutesAgo: number) =>
      new Date(now.getTime() - minutesAgo * 60_000).toISOString().replace('T', ' ').replace('Z', '');
    return {
      heartbeatList: Object.fromEntries(
        monitors.map(([id, , status]) => [
          String(id),
          [2, 1, 0].map((m) => ({ status: m === 0 ? status : 1, time: time(m), msg: '', ping: 40 + id })),
        ]),
      ),
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
  /** The demo answers lists only: the inventory polls it, never watches (even in a pod). */
  override get supportsWatch(): boolean {
    return false;
  }

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

  /** The demo has no pages: the whole list, recorded like `list`. */
  override async listPage<T>(path: string): Promise<{ items: T[]; continue?: string } | null> {
    const items = await this.list<T>(path.split('?')[0]);
    return items ? { items } : null;
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
          {
            labels: {
              alertname: 'BlackboxProbeFailed',
              severity: 'critical',
              instance: 'https://community.shop.example',
            },
            annotations: { summary: 'community.shop.example has not answered for 12 minutes.' },
          },
          {
            labels: { alertname: 'KubePersistentVolumeFillingUp', severity: 'warning', namespace: 'monitoring' },
            annotations: { summary: 'The Prometheus volume will be full in about 4 days.' },
          },
          // The same pair the built-in check finds slow: shown once, as the built-in issue (standard-alerts/alertmanager-dedupe.ts).
          {
            labels: {
              alertname: 'etcdMemberCommunicationSlow',
              severity: 'warning',
              job: 'kube-etcd',
              ...DEMO_SLOW_PEER,
            },
            annotations: {
              summary:
                'etcd cluster "kube-etcd": member communication with f8e8e46b068fd5b9 is taking 0.212s on etcd instance 10.0.0.1:2381.',
            },
          },
          { labels: { alertname: 'Watchdog', severity: 'none' } },
        ] as T;
      }
      if (path.includes(':9093/proxy/api/v2/silences')) {
        return [
          {
            status: { state: 'active' },
            matchers: [{ name: 'alertname', value: 'KubeCPUOvercommit', isRegex: false, isEqual: true }],
            createdBy: 'nico',
            comment: 'Homelab: overcommit is intended',
            endsAt: new Date(this.now().getTime() + 6 * 86_400_000).toISOString(),
          },
        ] as T;
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
    // One Argo CD Application, read by the rollback before it patches.
    const app = /^\/apis\/argoproj\.io\/v1alpha1\/namespaces\/([^/]+)\/applications\/([^/]+)$/.exec(path);
    if (app) {
      this.paths = buildDemoCluster(this.now(), this.scenario);
      const items = (
        this.paths.get('/apis/argoproj.io/v1alpha1/applications') as {
          items: { metadata: { name: string; namespace?: string } }[];
        }
      ).items;
      const found = items.find(
        (a) => a.metadata.namespace === decodeURIComponent(app[1]!) && a.metadata.name === decodeURIComponent(app[2]!),
      );
      if (!found) {
        throw new KubeError(404, `not found: ${path}`);
      }
      return found as T;
    }
    const hit = this.paths.get(path) ?? this.one(path);
    if (hit === undefined) {
      throw new KubeError(404, `not found: ${path}`);
    }
    return hit as T;
  }

  /** One object out of the lists: `/apis/<g>/<v>/namespaces/<ns>/<res>/<name>` (or core `/api/v1/…`), as the actions read it before writing. */
  private one(path: string): unknown {
    const m = /^(\/apis\/[^/]+\/[^/]+|\/api\/v1)\/(?:namespaces\/([^/]+)\/)?([a-z]+)\/([^/]+)$/.exec(path);
    if (!m) {
      return undefined;
    }
    const [, prefix, ns, resource, name] = m;
    this.paths = buildDemoCluster(this.now(), this.scenario);
    const items =
      (
        this.paths.get(`${prefix}/${resource}`) as
          { items?: { metadata: { name: string; namespace?: string } }[] } | undefined
      )?.items ?? [];
    return items.find(
      (i) =>
        i.metadata.name === decodeURIComponent(name!) &&
        (ns === undefined || (i.metadata.namespace ?? 'default') === decodeURIComponent(ns)),
    );
  }

  /** ConfigMap metadata the restart offer reads: the one a crashing worker reads through env changed two minutes ago (broken). */
  override async metadata<T>(path: string): Promise<T> {
    if (this.scenario === 'broken' && path === '/api/v1/namespaces/default/configmaps/newsletter-config') {
      return {
        kind: 'PartialObjectMetadata',
        metadata: {
          name: 'newsletter-config',
          namespace: 'default',
          creationTimestamp: new Date(this.now().getTime() - 30 * 86_400_000).toISOString(),
          managedFields: [
            {
              manager: 'argocd-controller',
              operation: 'Apply',
              time: new Date(this.now().getTime() - 2 * 60_000).toISOString(),
            },
          ],
        },
      } as T;
    }
    throw new KubeError(404, `not found: ${path}`);
  }

  override async delete(path: string, opts: { gracePeriodSeconds?: number } = {}): Promise<void> {
    this.writes.push({ method: 'DELETE', path, body: opts });
  }

  override async text(path: string, _max?: number): Promise<string> {
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
      existing.data = {
        ...existing.data,
        ...encode((body as { stringData?: Record<string, string> }).stringData ?? {}),
      };
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
