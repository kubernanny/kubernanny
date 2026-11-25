import { describe, expect, it } from 'vitest';
import { de } from '../testing/i18n';
import { evaluateAlerts } from './alertmanager.check';
import { evaluateArgoApps } from './argocd.check';
import { evaluateCertificates } from './certificates.check';
import { evaluateCnpg } from './cnpg.check';
import { evaluateEtcd } from './etcd.check';
import { evaluateLonghorn } from './longhorn.check';
import { evaluateNodes } from './nodes.check';
import { Pod, evaluatePods, podOwner } from './pods.check';
import { emptyInventory } from '../inventory/inventory';

const NOW = new Date('2026-11-24T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString();

const readyPod = (name: string, ready: boolean, extra: Partial<Pod> = {}): Pod => ({
  metadata: { name, namespace: 'kube-system', ...extra.metadata },
  spec: { nodeName: name.replace('etcd-', '') },
  status: { phase: 'Running', conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }], ...extra.status },
});

describe('nodes', () => {
  it('reports a NotReady node as critical', () => {
    const issues = de(evaluateNodes([
      { metadata: { name: 'n1' }, status: { conditions: [{ type: 'Ready', status: 'True' }] } },
      { metadata: { name: 'n2' }, status: { conditions: [{ type: 'Ready', status: 'Unknown', message: 'Kubelet stopped posting node status.' }] } },
    ]));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id: 'nodes/n2/not-ready', severity: 'critical', cause: 'Kubelet stopped posting node status.' });
  });

  it('treats a cordoned NotReady node (kured reboot) as a warning', () => {
    const [issue] = de(evaluateNodes([
      { metadata: { name: 'n1' }, spec: { unschedulable: true }, status: { conditions: [{ type: 'Ready', status: 'False' }] } },
    ]));
    expect(issue.severity).toBe('warning');
  });

  it('reports disk pressure on a ready node', () => {
    const issues = de(evaluateNodes([
      {
        metadata: { name: 'n1' },
        status: { conditions: [{ type: 'Ready', status: 'True' }, { type: 'DiskPressure', status: 'True' }] },
      },
    ]));
    expect(issues.map((i) => i.id)).toEqual(['nodes/n1/DiskPressure']);
  });
});

describe('etcd', () => {
  it('is skipped where etcd runs no static pods', () => {
    expect(de(evaluateEtcd([]))).toBeNull();
  });

  it('warns on one member of three down and turns critical without quorum', () => {
    const one = de(evaluateEtcd([readyPod('etcd-a', true), readyPod('etcd-b', true), readyPod('etcd-c', false)]));
    expect(one?.[0].severity).toBe('warning');
    const two = de(evaluateEtcd([readyPod('etcd-a', true), readyPod('etcd-b', false), readyPod('etcd-c', false)]));
    expect(two?.[0]).toMatchObject({ severity: 'critical', title: 'etcd ohne Quorum (1/3)' });
  });

  it('is quiet when all members are ready', () => {
    expect(de(evaluateEtcd([readyPod('etcd-a', true)]))).toEqual([]);
  });
});

describe('pods', () => {
  const crashing = (name: string): Pod => ({
    metadata: {
      name,
      namespace: 'default',
      labels: { 'pod-template-hash': '7c9f' },
      ownerReferences: [{ kind: 'ReplicaSet', name: 'shop-api-chart-7c9f' }],
    },
    status: {
      phase: 'Running',
      containerStatuses: [
        {
          name: 'api',
          ready: false,
          restartCount: 12,
          state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 5m0s' } },
          lastState: { terminated: { reason: 'Error', exitCode: 1 } },
        },
      ],
    },
  });

  it('finds the Deployment behind a ReplicaSet pod', () => {
    expect(podOwner(crashing('x'))).toEqual({ kind: 'Deployment', name: 'shop-api-chart' });
  });

  it('groups crashing replicas into one issue with logs of the last run and a restart', () => {
    const issues = de(evaluatePods([crashing('a'), crashing('b')], NOW));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: 'pods/default/Deployment/shop-api-chart',
      severity: 'critical',
      title: 'default/shop-api-chart: CrashLoopBackOff (2 Pods)',
    });
    expect(issues[0].actions).toEqual([
      { type: 'logs', namespace: 'default', pod: 'a', container: 'api', previous: true },
      { type: 'restart', kind: 'Deployment', namespace: 'default', name: 'shop-api-chart' },
    ]);
  });

  it('gives a pod a grace period before Pending counts', () => {
    const pending = (age: number): Pod => ({
      metadata: { name: 'p', namespace: 'x', creationTimestamp: hoursAgo(age), ownerReferences: [{ kind: 'StatefulSet', name: 'db' }] },
      status: { phase: 'Pending', conditions: [{ type: 'PodScheduled', status: 'False', message: '0/3 nodes are available' }] },
    });
    expect(de(evaluatePods([pending(0.05)], NOW))).toEqual([]);
    expect(de(evaluatePods([pending(1)], NOW))[0]).toMatchObject({ severity: 'warning', title: 'x/db: Pending' });
  });

  it('ignores finished job pods', () => {
    expect(de(evaluatePods([{ metadata: { name: 'job' }, status: { phase: 'Succeeded' } }], NOW))).toEqual([]);
  });
});

describe('longhorn', () => {
  it('maps robustness to severity and names the PVC', () => {
    const issues = de(evaluateLonghorn([
      { metadata: { name: 'pvc-1' }, status: { robustness: 'healthy' } },
      { metadata: { name: 'pvc-2' }, status: { robustness: 'unknown', state: 'detached' } },
      {
        metadata: { name: 'pvc-3' },
        spec: { numberOfReplicas: 3 },
        status: { robustness: 'degraded', kubernetesStatus: { namespace: 'weblate', pvcName: 'data' } },
      },
      { metadata: { name: 'pvc-4' }, status: { robustness: 'faulted' } },
    ]));
    expect(issues.map((i) => [i.title, i.severity])).toEqual([
      ['Volume weblate/data beeinträchtigt', 'warning'],
      ['Volume pvc-4 ausgefallen', 'critical'],
    ]);
  });
});

describe('certificates', () => {
  const opts = { warnDays: 14, criticalDays: 3 };
  const cert = (notAfter: string, ready = 'True') => ({
    metadata: { name: 'web', namespace: 'default' },
    spec: { dnsNames: ['shop.example'] },
    status: { notAfter, conditions: [{ type: 'Ready', status: ready, message: 'Issuing certificate as Secret does not exist' }] },
  });

  it('is quiet for a certificate with time left', () => {
    expect(de(evaluateCertificates([cert(inDays(60))], NOW, opts))).toEqual([]);
  });

  it('warns when renewal is overdue and turns critical close to expiry', () => {
    expect(de(evaluateCertificates([cert(inDays(10))], NOW, opts))[0].severity).toBe('warning');
    expect(de(evaluateCertificates([cert(inDays(2))], NOW, opts))[0].severity).toBe('critical');
  });

  it('reports an expired certificate', () => {
    expect(de(evaluateCertificates([cert(inDays(-1))], NOW, opts))[0].title).toBe('Zertifikat shop.example abgelaufen');
  });

  it('reports Ready=False with cert-manager message', () => {
    const [issue] = de(evaluateCertificates([cert(inDays(60), 'False')], NOW, opts));
    expect(issue).toMatchObject({ severity: 'warning', cause: 'Issuing certificate as Secret does not exist' });
  });
});

/** An inventory with one Deployment in `ns`, ready or not. */
function invWith(ns: string, name: string, ready: boolean, kind: 'deployments' | 'daemonsets' = 'deployments') {
  const inv = emptyInventory(NOW);
  inv[kind].push({ metadata: { name, namespace: ns }, spec: { replicas: 2 }, status: kind === 'daemonsets' ? { desiredNumberScheduled: 3, numberReady: ready ? 3 : 1 } : { readyReplicas: ready ? 2 : 0 } });
  return inv;
}

describe('argocd', () => {
  it('offers restart of the degraded deployment plus sync and refresh', () => {
    const [issue] = de(evaluateArgoApps([
      {
        metadata: { name: 'shop-api-chart', namespace: 'argocd' },
        spec: { destination: { namespace: 'default' } },
        status: {
          sync: { status: 'Synced' },
          health: { status: 'Degraded' },
          resources: [
            { kind: 'Service', name: 'api', health: { status: 'Healthy' } },
            { kind: 'Deployment', name: 'api', namespace: 'default', health: { status: 'Degraded', message: 'Deployment exceeded its progress deadline' } },
          ],
        },
      },
    ], invWith('default', 'api', false)));
    expect(issue.id).toBe('argocd/argocd/shop-api-chart/health');
    expect(issue.cause).toBe('Deployment api: Deployment exceeded its progress deadline');
    expect(issue.actions.map((a) => a.type)).toEqual(['restart', 'argocd-sync', 'argocd-refresh']);
  });

  describe('restart targets (security review H2: they come from attacker-writable status)', () => {
    const forged = (resources: { kind: string; namespace?: string; name: string }[], destination = 'tenant-a') => ({
      metadata: { name: 'x', namespace: 'tenant-a' },
      spec: { destination: { namespace: destination } },
      status: { health: { status: 'Degraded' }, resources: resources.map((r) => ({ ...r, health: { status: 'Degraded' } })) },
    });

    it('never offers a workload outside the destination namespace, even when it is broken', () => {
      const inv = invWith('kube-system', 'cilium', false, 'daemonsets');
      const [issue] = evaluateArgoApps([forged([{ kind: 'DaemonSet', namespace: 'kube-system', name: 'cilium' }])], inv);
      expect(issue!.actions.filter((a) => a.type === 'restart')).toEqual([]);
    });

    it('never offers a workload the inventory does not have, or shows ready', () => {
      expect(evaluateArgoApps([forged([{ kind: 'Deployment', name: 'ghost' }])], invWith('tenant-a', 'web', false))[0]!.actions.filter((a) => a.type === 'restart')).toEqual([]);
      expect(evaluateArgoApps([forged([{ kind: 'Deployment', name: 'web' }])], invWith('tenant-a', 'web', true))[0]!.actions.filter((a) => a.type === 'restart')).toEqual([]);
    });

    it('offers nothing without an inventory or a destination namespace', () => {
      const app = forged([{ kind: 'Deployment', name: 'web' }]);
      expect(evaluateArgoApps([app])[0]!.actions.filter((a) => a.type === 'restart')).toEqual([]);
      expect(evaluateArgoApps([{ ...app, spec: {} }], invWith('tenant-a', 'web', false))[0]!.actions.filter((a) => a.type === 'restart')).toEqual([]);
    });

    it('offers a not-ready workload in the destination namespace, and names the Application namespace in the id', () => {
      const [issue] = evaluateArgoApps([forged([{ kind: 'Deployment', name: 'web' }])], invWith('tenant-a', 'web', false));
      expect(issue!.id).toBe('argocd/tenant-a/x/health');
      expect(issue!.actions.filter((a) => a.type === 'restart')).toEqual([{ type: 'restart', kind: 'Deployment', namespace: 'tenant-a', name: 'web' }]);
    });
  });

  it('treats OutOfSync of a manual app as routine, of an automated app as a warning, and a manual one waiting a week as a hint', () => {
    const now = new Date('2026-11-25T12:00:00Z');
    const issues = de(evaluateArgoApps([
      { metadata: { name: 'manual' }, status: { sync: { status: 'OutOfSync' }, health: { status: 'Healthy' }, operationState: { phase: 'Succeeded', finishedAt: '2026-11-24T12:00:00Z' } } },
      { metadata: { name: 'forgotten' }, status: { sync: { status: 'OutOfSync' }, health: { status: 'Healthy' }, operationState: { phase: 'Succeeded', finishedAt: '2026-11-10T12:00:00Z' } } },
      {
        metadata: { name: 'auto' },
        spec: { syncPolicy: { automated: {} } },
        status: { sync: { status: 'OutOfSync' }, health: { status: 'Healthy' } },
      },
    ], undefined, now));
    expect(issues.map((i) => [i.id, i.severity])).toEqual([
      ['argocd/argocd/forgotten/sync', 'info'],
      ['argocd/argocd/auto/sync', 'warning'],
    ]);
    expect(issues[0].cause).toContain('15 Tagen');
    expect(issues[1].cause).toContain('Automatischer Sync');
    expect(issues[0].actions.map((a) => a.type)).toEqual(['argocd-sync', 'argocd-refresh']);
  });

  it('offers no sync while one is running', () => {
    const [issue] = de(evaluateArgoApps([
      { metadata: { name: 'a' }, spec: { syncPolicy: { automated: {} } }, status: { sync: { status: 'OutOfSync' }, operationState: { phase: 'Running' } } },
    ]));
    expect(issue.actions).toEqual([]);
  });

  it('reports a failed sync as critical', () => {
    const [issue] = de(evaluateArgoApps([
      { metadata: { name: 'a' }, status: { sync: { status: 'OutOfSync' }, operationState: { phase: 'Failed', message: 'one or more objects failed to apply' } } },
    ]));
    expect(issue).toMatchObject({ id: 'argocd/argocd/a/operation', severity: 'critical' });
  });
});

describe('cnpg', () => {
  const cluster = (status: object, backup = true) => ({
    metadata: { name: 'shop-api-pg', namespace: 'default' },
    spec: { instances: 2, backup: backup ? { barmanObjectStore: {} } : undefined },
    status: { phase: 'Cluster in healthy state', instances: 2, readyInstances: 2, currentPrimary: 'shop-api-pg-1', ...status },
  });
  const opts = { backupMaxAgeHours: 26 };

  it('is quiet for a healthy cluster with a fresh backup', () => {
    expect(de(evaluateCnpg([cluster({ lastSuccessfulBackup: hoursAgo(10) })], NOW, opts))).toEqual([]);
  });

  it('warns on an old backup and turns critical at twice the age', () => {
    const [warn] = de(evaluateCnpg([cluster({ lastSuccessfulBackup: hoursAgo(30) })], NOW, opts));
    expect(warn).toMatchObject({ severity: 'warning', title: 'Letztes Backup von default/shop-api-pg vor 30 h' });
    expect(warn.actions).toEqual([{ type: 'cnpg-backup', namespace: 'default', cluster: 'shop-api-pg' }]);
    expect(de(evaluateCnpg([cluster({ lastSuccessfulBackup: hoursAgo(60) })], NOW, opts))[0].severity).toBe('critical');
  });

  it('reports failing WAL archiving as critical', () => {
    const issues = de(evaluateCnpg(
      [
        cluster({
          lastSuccessfulBackup: hoursAgo(1),
          conditions: [{ type: 'ContinuousArchiving', status: 'False', message: 'unexpected failure invoking barman-cloud-wal-archive' }],
        }),
      ],
      NOW,
      opts,
    ));
    expect(issues.map((i) => [i.id, i.severity])).toEqual([['cnpg/default/shop-api-pg/archiving', 'critical']]);
  });

  it('ignores backups for clusters without backup config', () => {
    expect(de(evaluateCnpg([cluster({}, false)], NOW, opts))).toEqual([]);
  });

  it('reports missing replicas', () => {
    const [issue] = de(evaluateCnpg([cluster({ readyInstances: 1, phase: 'Waiting for the instances to become active', lastSuccessfulBackup: hoursAgo(1) })], NOW, opts));
    expect(issue).toMatchObject({ severity: 'warning', title: 'Postgres default/shop-api-pg: 1/2 Instanzen bereit' });
  });
});

describe('alertmanager', () => {
  it('groups by alert name, keeps the worst severity and drops Watchdog and info', () => {
    const issues = de(evaluateAlerts([
      { labels: { alertname: 'Watchdog', severity: 'none' } },
      { labels: { alertname: 'KubeJobFailed', severity: 'info' } },
      { labels: { alertname: 'EtcdHighFsyncDurations', severity: 'warning', instance: '10.0.0.4:2381' }, annotations: { summary: 'etcd fsync slow' } },
      { labels: { alertname: 'EtcdHighFsyncDurations', severity: 'critical', instance: '10.0.0.5:2381' } },
    ]));
    expect(issues).toEqual([
      {
        id: 'alertmanager/EtcdHighFsyncDurations',
        check: 'alertmanager',
        severity: 'critical',
        title: 'EtcdHighFsyncDurations (2×)',
        cause: 'etcd fsync slow',
        actions: [],
      },
    ]);
  });
});
