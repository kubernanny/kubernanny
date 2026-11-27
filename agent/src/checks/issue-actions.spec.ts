import { describe, expect, it } from 'vitest';

import { emptyInventory, Pvc, Workload } from '../inventory/inventory';
import { evaluateVolumes, grownSize } from '../modules/core/volumes';
import { evaluateJobs } from '../modules/core/workloads';
import { de } from '../testing/i18n';
import { evaluateArgoApps } from './argocd.check';
import { evaluateCertificates } from './certificates.check';
import { evaluateLonghornBackups } from './maintenance.check';
import { cordonedSince, evaluateCordoned, kuredLockHolders, Node } from './nodes.check';
import {
  configMapQuestions,
  envConfigMaps,
  evaluateFinishedPods,
  evaluatePods,
  evaluateStuckTerminating,
  Pod,
} from './pods.check';

const NOW = new Date('2026-11-24T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
const ready = [{ type: 'Ready', status: 'True' }];

function crashing(lastReason: string, extra: Partial<Pod['spec']> = {}): Pod {
  return {
    metadata: {
      name: 'web-abc12-x',
      namespace: 'shop',
      labels: { 'pod-template-hash': 'abc12' },
      ownerReferences: [{ kind: 'ReplicaSet', name: 'web-abc12' }],
    },
    spec: { containers: [{ name: 'web', resources: { limits: { memory: '256Mi' } } }], ...extra },
    status: {
      phase: 'Running',
      containerStatuses: [
        {
          name: 'web',
          ready: false,
          restartCount: 5,
          state: { waiting: { reason: 'CrashLoopBackOff' } },
          lastState: { terminated: { reason: lastReason, exitCode: 1, startedAt: minutesAgo(5) } },
        },
      ],
    },
  };
}

describe('restart offers on a crash loop', () => {
  it('puts the logs first and the restart second, with no known cause', () => {
    const [issue] = evaluatePods([crashing('Error')], NOW);
    expect(issue!.actions.map((a) => [a.type, a.type === 'restart' && a.secondary])).toEqual([
      ['logs', false],
      ['restart', true],
    ]);
  });

  it('offers no restart after an OOMKill and names the limit to raise', () => {
    const [issue] = de(evaluatePods([crashing('OOMKilled')], NOW));
    expect(issue!.actions.map((a) => a.type)).toEqual(['logs']);
    expect(issue!.title).toBe('shop/web: OOMKilled');
    expect(issue!.cause).toBe(
      'Der Container web braucht mehr Speicher als sein Limit von 256Mi und wird beendet (OOMKilled, 5 Neustarts). Ein Neustart hilft nicht: erhöhe das Memory-Limit.',
    );
    const [noLimit] = de(evaluatePods([crashing('OOMKilled', { containers: [{ name: 'web' }] })], NOW));
    expect(noLimit!.cause).toContain('ohne eigenes Memory-Limit');
  });

  it('makes the restart the fix when a ConfigMap of the environment changed after the last start', () => {
    const pod = crashing('Error', {
      containers: [
        {
          name: 'web',
          envFrom: [{ configMapRef: { name: 'app-config' } }],
          env: [{ name: 'X', valueFrom: { configMapKeyRef: { name: 'other' } } }],
        },
      ],
    });
    expect(envConfigMaps(pod, 'web')).toEqual(['app-config', 'other']);
    expect([...configMapQuestions([pod], NOW)]).toEqual([
      ['shop/web-abc12-x', { namespace: 'shop', configMaps: ['app-config', 'other'], since: minutesAgo(5) }],
    ]);
    const [issue] = de(evaluatePods([pod], NOW, new Map([['shop/web-abc12-x', 'app-config']])));
    expect(issue!.actions[0]).toEqual({
      type: 'restart',
      kind: 'Deployment',
      namespace: 'shop',
      name: 'web',
      changed: { kind: 'ConfigMap', name: 'app-config' },
    });
    expect(issue!.cause).toMatch(
      /^ConfigMap app-config wurde nach dem letzten Start geändert: ein Neustart lädt sie sofort\./,
    );
  });

  it('asks nothing about an OOMKill or a pod without env ConfigMaps', () => {
    expect(
      configMapQuestions(
        [
          crashing('OOMKilled', { containers: [{ name: 'web', envFrom: [{ configMapRef: { name: 'c' } }] }] }),
          crashing('Error'),
        ],
        NOW,
      ).size,
    ).toBe(0);
  });
});

describe('uncordon offer', () => {
  const node = (over: Partial<Node> = {}): Node => ({
    metadata: {
      name: 'n4',
      managedFields: [
        { manager: 'kubectl-cordon', time: minutesAgo(90), fieldsV1: { 'f:spec': { 'f:unschedulable': {} } } },
        { manager: 'kubelet', time: minutesAgo(1), fieldsV1: {} },
      ],
    },
    spec: { unschedulable: true },
    status: { conditions: ready },
    ...over,
  });

  it('reports a Ready node cordoned for over 30 minutes, timed by the owner of spec.unschedulable', () => {
    expect(cordonedSince(node(), undefined)).toBe(Date.parse(minutesAgo(90)));
    const [issue] = de(evaluateCordoned([node()], [], new Set(), new Map(), NOW));
    expect(issue).toMatchObject({
      id: 'nodes/n4/cordoned',
      title: 'Node n4 seit 2 h cordoned',
      actions: [{ type: 'uncordon', node: 'n4' }],
    });
  });

  it('stays quiet while kured holds the lock, a drain evicts pods, the node is NotReady, or it is new', () => {
    expect(evaluateCordoned([node()], [], new Set(['n4']), new Map(), NOW)).toEqual([]);
    expect(
      evaluateCordoned(
        [node()],
        [{ metadata: { deletionTimestamp: minutesAgo(1) }, spec: { nodeName: 'n4' } }],
        new Set(),
        new Map(),
        NOW,
      ),
    ).toEqual([]);
    expect(
      evaluateCordoned(
        [node({ status: { conditions: [{ type: 'Ready', status: 'False' }] } })],
        [],
        new Set(),
        new Map(),
        NOW,
      ),
    ).toEqual([]);
    const fresh = node({ metadata: { name: 'n4' } });
    expect(evaluateCordoned([fresh], [], new Set(), new Map([['n4', Date.parse(minutesAgo(10))]]), NOW)).toEqual([]);
    expect(evaluateCordoned([fresh], [], new Set(), new Map([['n4', Date.parse(minutesAgo(40))]]), NOW)).toHaveLength(
      1,
    );
  });

  it("reads kured's lock holders, one or several", () => {
    const ds = (lock: string) => ({
      metadata: { name: 'kured', annotations: { 'weave.works/kured-node-lock': lock } },
    });
    expect([
      ...kuredLockHolders([
        ds('{"nodeID":"n1"}'),
        ds('{"maxOwners":2,"locks":[{"nodeID":"n2"},{"nodeID":"n3"}]}'),
        ds('not json'),
      ]),
    ]).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('pods on a lost node and finished pods', () => {
  const nodes = [
    { metadata: { name: 'up' }, status: { conditions: ready } },
    { metadata: { name: 'down' }, status: { conditions: [{ type: 'Ready', status: 'Unknown' }] } },
  ];
  const terminating = (node: string, minutes: number): Pod => ({
    metadata: {
      name: `db-0-${node}`,
      namespace: 'shop',
      deletionTimestamp: minutesAgo(minutes),
      ownerReferences: [{ kind: 'StatefulSet', name: 'db' }],
    },
    spec: { nodeName: node },
    status: { phase: 'Running' },
  });

  it('offers a force delete only for a pod stuck over 10 minutes on a NotReady or vanished node', () => {
    const issues = evaluateStuckTerminating(
      [terminating('down', 20), terminating('gone', 20), terminating('up', 60), terminating('down', 5)],
      nodes,
      NOW,
    );
    expect(issues.map((i) => i.actions[0])).toEqual([
      { type: 'force-delete-terminating', namespace: 'shop', pod: 'db-0-down', node: 'down', statefulSet: 'db' },
      { type: 'force-delete-terminating', namespace: 'shop', pod: 'db-0-gone', node: 'gone', statefulSet: 'db' },
    ]);
  });

  it('lists failed and evicted pods per namespace, never running ones or those of a Job that still exists', () => {
    const pod = (name: string, phase: string, over: Partial<Pod['metadata']> = {}, reason?: string): Pod => ({
      metadata: { name, namespace: 'shop', creationTimestamp: minutesAgo(120), ...over },
      status: { phase, ...(reason ? { reason } : {}) },
    });
    const issues = de(
      evaluateFinishedPods(
        [
          pod('evicted', 'Failed', {}, 'Evicted'),
          pod('crashed', 'Failed'),
          pod('running', 'Running'),
          pod('young', 'Failed', { creationTimestamp: minutesAgo(5) }),
          pod('job-pod', 'Failed', { ownerReferences: [{ kind: 'Job', name: 'nightly' }] }),
          pod('orphan', 'Succeeded', { ownerReferences: [{ kind: 'Job', name: 'deleted' }] }),
          pod('done-standalone', 'Succeeded'),
        ],
        [{ metadata: { name: 'nightly', namespace: 'shop' } }],
        NOW,
      ),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      id: 'pods/finished/shop',
      severity: 'info',
      actions: [{ type: 'cleanup-pods', namespace: 'shop', pods: ['crashed', 'evicted', 'orphan'] }],
    });
  });
});

describe('job rerun offers', () => {
  const failed = {
    type: 'Failed',
    status: 'True',
    message: 'BackoffLimitExceeded',
    lastTransitionTime: minutesAgo(30),
  };
  it('offers a rerun of a CronJob and of a Job nobody owns, never of one an operator owns, and hides a Job that was run again', () => {
    const inv = emptyInventory(NOW);
    inv.jobs = [
      {
        metadata: {
          name: 'nightly-1',
          namespace: 'shop',
          ownerReferences: [{ kind: 'CronJob', name: 'nightly' }],
          creationTimestamp: minutesAgo(60),
        },
        status: { conditions: [failed] },
      },
      { metadata: { name: 'migrate', namespace: 'shop' }, status: { conditions: [failed] } },
      {
        metadata: { name: 'hook', namespace: 'shop', ownerReferences: [{ kind: 'Workflow', name: 'w' }] },
        status: { conditions: [failed] },
      },
      { metadata: { name: 'seed', namespace: 'shop' }, status: { conditions: [failed] } },
      {
        metadata: { name: 'seed-rerun-abcde', namespace: 'shop', labels: { 'kubernanny.io/rerun-of': 'seed' } },
        status: {},
      },
    ];
    const byId = Object.fromEntries(
      evaluateJobs(inv).map((i) => [i.id, i.actions.filter((a) => a.type === 'job-rerun')]),
    );
    expect(byId).toEqual({
      'jobs/shop/nightly': [{ type: 'job-rerun', namespace: 'shop', from: 'CronJob', name: 'nightly' }],
      'jobs/shop/migrate': [{ type: 'job-rerun', namespace: 'shop', from: 'Job', name: 'migrate' }],
      'jobs/shop/hook': [],
    });
  });

  it('offers to delete the failed Job itself, by uid: the last run of a CronJob and a Job nobody owns, never one an operator owns', () => {
    const inv = emptyInventory(NOW);
    inv.jobs = [
      {
        metadata: {
          name: 'nightly-2',
          namespace: 'shop',
          uid: 'u-2',
          ownerReferences: [{ kind: 'CronJob', name: 'nightly' }],
          creationTimestamp: minutesAgo(60),
        },
        status: { conditions: [failed] },
      },
      {
        metadata: {
          name: 'nightly-1',
          namespace: 'shop',
          uid: 'u-1',
          ownerReferences: [{ kind: 'CronJob', name: 'nightly' }],
          creationTimestamp: minutesAgo(120),
        },
        status: { conditions: [failed] },
      },
      { metadata: { name: 'migrate', namespace: 'shop', uid: 'u-m' }, status: { conditions: [failed] } },
      {
        metadata: { name: 'hook', namespace: 'shop', uid: 'u-h', ownerReferences: [{ kind: 'Workflow', name: 'w' }] },
        status: { conditions: [failed] },
      },
      // Without a uid (an older inventory) nothing is offered: the delete must name exactly the Job seen.
      { metadata: { name: 'old', namespace: 'shop' }, status: { conditions: [failed] } },
    ];
    const byId = Object.fromEntries(
      evaluateJobs(inv).map((i) => [i.id, i.actions.filter((a) => a.type === 'job-delete')]),
    );
    expect(byId).toEqual({
      'jobs/shop/nightly': [{ type: 'job-delete', namespace: 'shop', job: 'nightly-2', uid: 'u-2' }],
      'jobs/shop/migrate': [{ type: 'job-delete', namespace: 'shop', job: 'migrate', uid: 'u-m' }],
      'jobs/shop/hook': [],
      'jobs/shop/old': [],
    });
  });
});

describe('volume growth offer', () => {
  const pvc = (over: Partial<Pvc> = {}): Pvc => ({
    metadata: { name: 'data-prom-0', namespace: 'mon' },
    spec: { storageClassName: 'longhorn', resources: { requests: { storage: '50Gi' } } },
    status: { phase: 'Bound' },
    ...over,
  });
  const usage = new Map([['mon/data-prom-0', { used: 44 * 2 ** 30, capacity: 50 * 2 ** 30 }]]);

  it('grows by a quarter, rounded up to whole Gi, at least 1 Gi', () => {
    expect([grownSize('50Gi'), grownSize('8Gi'), grownSize('1Gi'), grownSize('500Mi')]).toEqual([
      '63Gi',
      '10Gi',
      '2Gi',
      '1Gi',
    ]);
  });

  it('offers it only where the StorageClass allows expansion, names the StatefulSet template, and points CNPG volumes to the Cluster', () => {
    const inv = emptyInventory(NOW);
    inv.storageClasses = [
      { metadata: { name: 'longhorn' }, allowVolumeExpansion: true },
      { metadata: { name: 'local' }, allowVolumeExpansion: false },
    ];
    inv.statefulsets = [
      {
        metadata: { name: 'prom', namespace: 'mon' },
        spec: { volumeClaimTemplates: [{ metadata: { name: 'data' } }] },
      } as unknown as Workload,
    ];
    inv.pvcs = [pvc()];
    expect(evaluateVolumes(inv, usage)[0]!.actions).toEqual([
      { type: 'pvc-expand', namespace: 'mon', name: 'data-prom-0', from: '50Gi', to: '63Gi', template: 'prom' },
    ]);
    inv.pvcs = [pvc({ spec: { storageClassName: 'local', resources: { requests: { storage: '50Gi' } } } })];
    expect(evaluateVolumes(inv, usage)[0]!.actions).toEqual([]);
    inv.pvcs = [
      pvc({
        metadata: {
          name: 'data-prom-0',
          namespace: 'mon',
          ownerReferences: [{ kind: 'Cluster', name: 'pg', apiVersion: 'postgresql.cnpg.io/v1' }],
        },
      }),
    ];
    const [cnpg] = de(evaluateVolumes(inv, usage));
    expect(cnpg!.actions).toEqual([]);
    expect(cnpg!.cause).toContain('CloudNativePG-Cluster pg: vergrößere dort storage.size');
  });
});

describe('reconcile, backup and terminate offers', () => {
  it('renews a certificate unless cert-manager is issuing already', () => {
    const cert = (issuing: string) => ({
      metadata: { name: 'tls', namespace: 'web' },
      status: {
        notAfter: new Date(NOW.getTime() + 5 * 86_400_000).toISOString(),
        conditions: [...ready, { type: 'Issuing', status: issuing }],
      },
    });
    const opts = { warnDays: 14, criticalDays: 7 };
    expect(evaluateCertificates([cert('False')], NOW, opts)[0]!.actions).toEqual([
      { type: 'reconcile-now', kind: 'Certificate', namespace: 'web', name: 'tls' },
    ]);
    expect(evaluateCertificates([cert('True')], NOW, opts)[0]!.actions).toEqual([]);
  });

  it('offers a Longhorn backup for an attached volume only', () => {
    const backups = [
      {
        metadata: { name: 'b' },
        status: { state: 'Completed', volumeName: 'pvc-1', backupCreatedAt: minutesAgo(60 * 50) },
      },
    ];
    const vol = (state: string) => [
      {
        metadata: { name: 'pvc-1', namespace: 'longhorn-system' },
        status: { state, kubernetesStatus: { namespace: 'web', pvcName: 'data' } },
      },
    ];
    expect(evaluateLonghornBackups([], backups, vol('attached'), NOW, 26)[0]!.actions).toEqual([
      { type: 'longhorn-backup', namespace: 'longhorn-system', volume: 'pvc-1', label: 'web/data' },
    ]);
    expect(evaluateLonghornBackups([], backups, vol('detached'), NOW, 26)[0]!.actions).toEqual([]);
  });

  it('offers to end an Argo CD sync running for over 30 minutes', () => {
    const app = (minutes: number) => ({
      metadata: { name: 'shop', namespace: 'argocd' },
      status: { operationState: { phase: 'Running', startedAt: minutesAgo(minutes) } },
    });
    expect(evaluateArgoApps([app(45)], undefined, NOW).map((i) => [i.id, i.actions])).toEqual([
      ['argocd/argocd/shop/operation-stuck', [{ type: 'argocd-terminate-op', namespace: 'argocd', app: 'shop' }]],
    ]);
    expect(evaluateArgoApps([app(10)], undefined, NOW)).toEqual([]);
  });
});
