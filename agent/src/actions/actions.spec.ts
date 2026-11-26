import { describe, expect, it } from 'vitest';

import type { ActionType, Issue, IssueAction, SyncOffer } from '../checks/types';
import { HttpError } from '../http/errors';
import { KubeClient, KubeError } from '../kube/kube-client';
import type { SettingsService } from '../settings/settings.service';
import type { StatusService } from '../status/status.service';
import { de } from '../testing/i18n';
import { ActionsService } from './actions.service';

/** Records every call; `objects` answers the reads an action makes before it writes. */
class FakeKube extends KubeClient {
  readonly calls: { method: string; path: string; body?: unknown }[] = [];
  constructor(private readonly objects: Record<string, unknown> = {}) {
    super();
  }
  override async get<T>(path: string): Promise<T> {
    this.calls.push({ method: 'GET', path });
    if (!(path in this.objects)) {
      throw new KubeError(404, `not found: ${path}`);
    }
    return structuredClone(this.objects[path]) as T;
  }
  override async mergePatch(path: string, body: unknown): Promise<void> {
    this.calls.push({ method: 'PATCH', path, body });
  }
  override async create(path: string, body: unknown): Promise<void> {
    this.calls.push({ method: 'POST', path, body });
  }
  override async delete(path: string, opts: { gracePeriodSeconds?: number } = {}): Promise<void> {
    this.calls.push({ method: 'DELETE', path, body: opts });
    if (path.endsWith('/gone')) {
      throw new KubeError(404, 'gone');
    }
  }
  writes() {
    return this.calls.filter((c) => c.method !== 'GET');
  }
}

function service(
  action: IssueAction,
  opts: { off?: ActionType[]; objects?: Record<string, unknown>; noIssue?: boolean } = {},
) {
  const kube = new FakeKube(opts.objects);
  const issue: Issue = {
    id: 'x/issue',
    check: 'pods',
    severity: 'warning',
    title: { $t: 'raw', p: { text: 't' } },
    cause: { $t: 'raw', p: { text: 'c' } },
    actions: [action],
  };
  const status = {
    findIssue: (id: string) => (opts.noIssue || id !== issue.id ? undefined : issue),
    refresh: async () => undefined,
  } as unknown as StatusService;
  const settings = {
    actionOn: (type: ActionType) => !(opts.off ?? []).includes(type),
  } as unknown as SettingsService;
  return { kube, actions: new ActionsService(kube, status, settings) };
}

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpError) {
      return (err.getResponse() as { code: string }).code;
    }
    throw err;
  }
  return 'OK';
}

const APP = '/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/loki';

const CASES: { action: IssueAction; objects?: Record<string, unknown> }[] = [
  { action: { type: 'uncordon', node: 'n4' } },
  { action: { type: 'argocd-sync', namespace: 'argocd', app: 'loki' }, objects: { [APP]: { metadata: {} } } },
  {
    action: { type: 'job-rerun', namespace: 'ns', from: 'CronJob', name: 'nightly' },
    objects: {
      '/apis/batch/v1/namespaces/ns/cronjobs/nightly': {
        metadata: { name: 'nightly', uid: 'u1' },
        spec: { jobTemplate: { spec: { template: {} } } },
      },
    },
  },
  { action: { type: 'reconcile-now', kind: 'Kustomization', namespace: 'flux-system', name: 'apps' } },
  { action: { type: 'cleanup-pods', namespace: 'ns', pods: ['a'] } },
  { action: { type: 'force-delete-terminating', namespace: 'ns', pod: 'p', node: 'n2' } },
  { action: { type: 'longhorn-backup', namespace: 'longhorn-system', volume: 'pvc-1', label: 'ns/data' } },
  {
    action: { type: 'velero-backup', namespace: 'velero', schedule: 'daily' },
    objects: { '/apis/velero.io/v1/namespaces/velero/schedules/daily': { spec: { template: {} } } },
  },
  {
    action: { type: 'argocd-terminate-op', namespace: 'argocd', app: 'shop' },
    objects: {
      '/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/shop': {
        metadata: {},
        status: { operationState: { phase: 'Running' } },
      },
    },
  },
  {
    action: { type: 'pvc-expand', namespace: 'ns', name: 'data', from: '8Gi', to: '10Gi' },
    objects: {
      '/api/v1/namespaces/ns/persistentvolumeclaims/data': {
        metadata: {},
        spec: { resources: { requests: { storage: '8Gi' } } },
      },
    },
  },
];

describe('the issue actions (target from the issue, never from the request)', () => {
  it.each(CASES.map((c) => [c.action.type, c] as const))(
    '%s refuses when switched off, and when no open issue offers it, without touching the cluster',
    async (_type, c) => {
      const off = service(c.action, { off: [c.action.type], objects: c.objects });
      expect(await code(off.actions.run('x/issue', c.action.type, 0, { id: 'd1', name: 'phone' } as never))).toBe(
        'ACTION_DISABLED',
      );
      expect(off.kube.calls).toEqual([]);
      const gone = service(c.action, { noIssue: true, objects: c.objects });
      expect(await code(gone.actions.run('x/issue', c.action.type))).toBe('ISSUE_GONE');
      expect(gone.kube.calls).toEqual([]);
      const other = service({ type: 'logs', namespace: 'ns', pod: 'p' }, { objects: c.objects });
      expect(await code(other.actions.run('x/issue', c.action.type))).toBe('ACTION_NOT_OFFERED');
      expect(other.kube.calls).toEqual([]);
    },
  );

  it("uncordon patches spec.unschedulable of the issue's node, nothing else", async () => {
    const { kube, actions } = service({ type: 'uncordon', node: 'rke2-node-4' });
    expect(de(await actions.run('x/issue', 'uncordon'))).toEqual({ done: 'rke2-node-4 nimmt wieder Pods an.' });
    expect(kube.writes()).toEqual([
      { method: 'PATCH', path: '/api/v1/nodes/rke2-node-4', body: { spec: { unschedulable: false } } },
    ]);
  });

  it('job-rerun creates a Job from the CronJob template, owned by the CronJob like kubectl create job --from', async () => {
    const template = {
      metadata: { labels: { app: 'reviews' } },
      spec: {
        backoffLimit: 2,
        template: { spec: { containers: [{ name: 'r', image: 'r:1' }], restartPolicy: 'Never' } },
      },
    };
    const { kube, actions } = service(
      { type: 'job-rerun', namespace: 'default', from: 'CronJob', name: 'appstore-metrics-reviews' },
      {
        objects: {
          '/apis/batch/v1/namespaces/default/cronjobs/appstore-metrics-reviews': {
            metadata: { name: 'appstore-metrics-reviews', uid: 'cj-uid' },
            spec: { jobTemplate: template },
          },
        },
      },
    );
    await actions.run('x/issue', 'job-rerun');
    expect(kube.writes()).toEqual([
      {
        method: 'POST',
        path: '/apis/batch/v1/namespaces/default/jobs',
        body: {
          apiVersion: 'batch/v1',
          kind: 'Job',
          metadata: {
            generateName: 'appstore-metrics-reviews-manual-',
            labels: { app: 'reviews', 'app.kubernetes.io/created-by': 'kubernanny' },
            annotations: { 'cronjob.kubernetes.io/instantiate': 'manual' },
            ownerReferences: [
              {
                apiVersion: 'batch/v1',
                kind: 'CronJob',
                name: 'appstore-metrics-reviews',
                uid: 'cj-uid',
                controller: true,
              },
            ],
          },
          spec: template.spec,
        },
      },
    ]);
  });

  it('job-rerun copies a failed stand-alone Job without its controller labels and selector, and refuses an owned or healthy one', async () => {
    const job = {
      metadata: {
        name: 'migrate',
        labels: { app: 'm', 'controller-uid': 'u', 'batch.kubernetes.io/job-name': 'migrate' },
      },
      spec: {
        backoffLimit: 1,
        selector: { matchLabels: { 'controller-uid': 'u' } },
        manualSelector: false,
        template: {
          metadata: { labels: { app: 'm', 'controller-uid': 'u', 'job-name': 'migrate' } },
          spec: { containers: [{ name: 'm', image: 'm:1' }] },
        },
      },
      status: { conditions: [{ type: 'Failed', status: 'True' }] },
    };
    const path = '/apis/batch/v1/namespaces/shop/jobs/migrate';
    const action: IssueAction = { type: 'job-rerun', namespace: 'shop', from: 'Job', name: 'migrate' };
    const ok = service(action, { objects: { [path]: job } });
    await ok.actions.run('x/issue', 'job-rerun');
    expect(ok.kube.writes()[0]).toEqual({
      method: 'POST',
      path: '/apis/batch/v1/namespaces/shop/jobs',
      body: {
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata: {
          generateName: 'migrate-rerun-',
          labels: { app: 'm', 'app.kubernetes.io/created-by': 'kubernanny', 'kubernanny.io/rerun-of': 'migrate' },
        },
        spec: {
          backoffLimit: 1,
          template: { metadata: { labels: { app: 'm' } }, spec: { containers: [{ name: 'm', image: 'm:1' }] } },
        },
      },
    });
    const owned = service(action, {
      objects: {
        [path]: { ...job, metadata: { ...job.metadata, ownerReferences: [{ kind: 'Workflow', name: 'w' }] } },
      },
    });
    expect(await code(owned.actions.run('x/issue', 'job-rerun'))).toBe('TARGET_CHANGED');
    const healthy = service(action, {
      objects: { [path]: { ...job, status: { conditions: [{ type: 'Complete', status: 'True' }] } } },
    });
    expect(await code(healthy.actions.run('x/issue', 'job-rerun'))).toBe('TARGET_CHANGED');
    expect([...owned.kube.writes(), ...healthy.kube.writes()]).toEqual([]);
  });

  it.each([
    [
      'Kustomization',
      '/apis/kustomize.toolkit.fluxcd.io/v1/namespaces/flux-system/kustomizations/apps',
      'reconcile.fluxcd.io/requestedAt',
    ],
    [
      'HelmRelease',
      '/apis/helm.toolkit.fluxcd.io/v2/namespaces/flux-system/helmreleases/apps',
      'reconcile.fluxcd.io/requestedAt',
    ],
    ['ExternalSecret', '/apis/external-secrets.io/v1/namespaces/flux-system/externalsecrets/apps', 'force-sync'],
    [
      'InfisicalStaticSecret',
      '/apis/secrets.infisical.com/v1beta1/namespaces/flux-system/infisicalstaticsecrets/apps',
      'kubernanny.io/requested-at',
    ],
  ] as const)("reconcile-now on a %s sets its controller's annotation only", async (kind, path, annotation) => {
    const { kube, actions } = service({ type: 'reconcile-now', kind, namespace: 'flux-system', name: 'apps' });
    await actions.run('x/issue', 'reconcile-now');
    const writes = kube.writes();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(path);
    const annotations = (writes[0]!.body as { metadata: { annotations: Record<string, string> } }).metadata.annotations;
    expect(Object.keys(writes[0]!.body as object)).toEqual(['metadata']);
    expect(Object.keys(annotations)).toEqual([annotation]);
  });

  it('reconcile-now on a Certificate sets Issuing=True (ManuallyTriggered) on the status subresource, keeping the other conditions', async () => {
    const path = '/apis/cert-manager.io/v1/namespaces/weblate/certificates/weblate-tls';
    const ready = { type: 'Ready', status: 'True', reason: 'Ready' };
    const { kube, actions } = service(
      { type: 'reconcile-now', kind: 'Certificate', namespace: 'weblate', name: 'weblate-tls' },
      {
        objects: {
          [path]: {
            metadata: { resourceVersion: '41', generation: 3 },
            status: { conditions: [ready, { type: 'Issuing', status: 'False' }] },
          },
        },
      },
    );
    expect(de(await actions.run('x/issue', 'reconcile-now'))).toEqual({
      done: 'Zertifikat weblate-tls wird neu ausgestellt.',
    });
    const [write] = kube.writes();
    expect(write!.path).toBe(`${path}/status`);
    const body = write!.body as {
      metadata: { resourceVersion: string };
      status: { conditions: Record<string, unknown>[] };
    };
    expect(body.metadata.resourceVersion).toBe('41');
    expect(body.status.conditions[0]).toEqual(ready);
    expect(body.status.conditions[1]).toMatchObject({
      type: 'Issuing',
      status: 'True',
      reason: 'ManuallyTriggered',
      observedGeneration: 3,
    });
    expect(body.status.conditions).toHaveLength(2);
  });

  it('cleanup-pods deletes the listed pods of the namespace and takes a vanished one in its stride', async () => {
    const { kube, actions } = service({ type: 'cleanup-pods', namespace: 'default', pods: ['a', 'gone', 'b'] });
    expect(de(await actions.run('x/issue', 'cleanup-pods'))).toEqual({ done: '2 Pods in default gelöscht.' });
    expect(kube.writes().map((w) => [w.method, w.path, w.body])).toEqual([
      ['DELETE', '/api/v1/namespaces/default/pods/a', {}],
      ['DELETE', '/api/v1/namespaces/default/pods/gone', {}],
      ['DELETE', '/api/v1/namespaces/default/pods/b', {}],
    ]);
  });

  it('force-delete-terminating deletes the one pod with grace period 0', async () => {
    const { kube, actions } = service({
      type: 'force-delete-terminating',
      namespace: 'monitoring',
      pod: 'uptime-kuma-0',
      node: 'rke2-node-2',
      statefulSet: 'uptime-kuma',
    });
    await actions.run('x/issue', 'force-delete-terminating');
    expect(kube.writes()).toEqual([
      { method: 'DELETE', path: '/api/v1/namespaces/monitoring/pods/uptime-kuma-0', body: { gracePeriodSeconds: 0 } },
    ]);
  });

  it("longhorn-backup creates a snapshot and a backup of it for the issue's volume", async () => {
    const { kube, actions } = service({
      type: 'longhorn-backup',
      namespace: 'longhorn-system',
      volume: 'pvc-1',
      label: 'weblate/data',
    });
    await actions.run('x/issue', 'longhorn-backup');
    const [snap, backup] = kube.writes() as {
      path: string;
      body: { kind: string; metadata: { name: string; labels: Record<string, string> }; spec: Record<string, unknown> };
    }[];
    expect(snap!.path).toBe('/apis/longhorn.io/v1beta2/namespaces/longhorn-system/snapshots');
    expect(snap!.body.spec).toEqual({ volume: 'pvc-1', createSnapshot: true });
    expect(backup!.path).toBe('/apis/longhorn.io/v1beta2/namespaces/longhorn-system/backups');
    expect(backup!.body.spec).toEqual({ snapshotName: snap!.body.metadata.name });
    expect(backup!.body.metadata.labels).toEqual({
      'app.kubernetes.io/created-by': 'kubernanny',
      'backup-volume': 'pvc-1',
    });
  });

  it("velero-backup creates a backup from the schedule's template, like --from-schedule", async () => {
    const { kube, actions } = service(
      { type: 'velero-backup', namespace: 'velero', schedule: 'daily-apps' },
      {
        objects: {
          '/apis/velero.io/v1/namespaces/velero/schedules/daily-apps': {
            spec: {
              template: { metadata: { labels: { tier: 'apps' } }, includedNamespaces: ['default'], ttl: '720h0m0s' },
            },
          },
        },
      },
    );
    await actions.run('x/issue', 'velero-backup');
    const [write] = kube.writes() as {
      path: string;
      body: { metadata: { name: string; labels: Record<string, string> }; spec: unknown };
    }[];
    expect(write!.path).toBe('/apis/velero.io/v1/namespaces/velero/backups');
    expect(write!.body.metadata.name).toMatch(/^daily-apps-\d{14}$/);
    expect(write!.body.metadata.labels).toEqual({
      tier: 'apps',
      'app.kubernetes.io/created-by': 'kubernanny',
      'velero.io/schedule-name': 'daily-apps',
    });
    expect(write!.body.spec).toEqual({ includedNamespaces: ['default'], ttl: '720h0m0s' });
  });

  it('velero-backup refuses a schedule with hooks, a resource policy or an order (the admission policy denies them)', async () => {
    for (const field of ['hooks', 'resourcePolicy', 'orderedResources']) {
      const { kube, actions } = service(
        { type: 'velero-backup', namespace: 'velero', schedule: 'db' },
        { objects: { '/apis/velero.io/v1/namespaces/velero/schedules/db': { spec: { template: { [field]: {} } } } } },
      );
      expect(await code(actions.run('x/issue', 'velero-backup'))).toBe('VELERO_HOOKS');
      expect(kube.writes()).toEqual([]);
    }
  });

  it('job-rerun refuses a template with host access or extra privileges (the admission policy denies them)', async () => {
    const risky = [
      { hostNetwork: true, containers: [] },
      { volumes: [{ name: 'h', hostPath: { path: '/' } }], containers: [] },
      { containers: [{ name: 'c', securityContext: { privileged: true } }] },
      { containers: [{ name: 'c', securityContext: { allowPrivilegeEscalation: true } }] },
      { initContainers: [{ name: 'i', securityContext: { capabilities: { add: ['NET_ADMIN'] } } }], containers: [] },
    ];
    for (const spec of risky) {
      const { kube, actions } = service(
        { type: 'job-rerun', namespace: 'ns', from: 'CronJob', name: 'nightly' },
        {
          objects: {
            '/apis/batch/v1/namespaces/ns/cronjobs/nightly': {
              metadata: { name: 'nightly', uid: 'u' },
              spec: { jobTemplate: { spec: { template: { spec } } } },
            },
          },
        },
      );
      expect(await code(actions.run('x/issue', 'job-rerun')), JSON.stringify(spec)).toBe('JOB_PRIVILEGED');
      expect(kube.writes()).toEqual([]);
    }
  });

  it('argocd-terminate-op sets the running operation to Terminating, and refuses once it no longer runs', async () => {
    const path = '/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/discourse-new';
    const action: IssueAction = { type: 'argocd-terminate-op', namespace: 'argocd', app: 'discourse-new' };
    const running = service(action, {
      objects: { [path]: { metadata: { resourceVersion: '7' }, status: { operationState: { phase: 'Running' } } } },
    });
    await running.actions.run('x/issue', 'argocd-terminate-op');
    expect(running.kube.writes()).toEqual([
      {
        method: 'PATCH',
        path,
        body: { metadata: { resourceVersion: '7' }, status: { operationState: { phase: 'Terminating' } } },
      },
    ]);
    const done = service(action, {
      objects: { [path]: { metadata: {}, status: { operationState: { phase: 'Succeeded' } } } },
    });
    expect(await code(done.actions.run('x/issue', 'argocd-terminate-op'))).toBe('TARGET_CHANGED');
    expect(done.kube.writes()).toEqual([]);
  });

  it('pvc-expand raises the request to the offered size, and refuses when the claim changed meanwhile', async () => {
    const path = '/api/v1/namespaces/monitoring/persistentvolumeclaims/data';
    const action: IssueAction = { type: 'pvc-expand', namespace: 'monitoring', name: 'data', from: '50Gi', to: '63Gi' };
    const ok = service(action, {
      objects: {
        [path]: { metadata: { resourceVersion: '9' }, spec: { resources: { requests: { storage: '50Gi' } } } },
      },
    });
    expect(de(await ok.actions.run('x/issue', 'pvc-expand'))).toEqual({
      done: 'monitoring/data wird auf 63Gi vergrößert.',
    });
    expect(ok.kube.writes()).toEqual([
      {
        method: 'PATCH',
        path,
        body: { metadata: { resourceVersion: '9' }, spec: { resources: { requests: { storage: '63Gi' } } } },
      },
    ]);
    const grown = service(action, {
      objects: { [path]: { metadata: {}, spec: { resources: { requests: { storage: '63Gi' } } } } },
    });
    expect(await code(grown.actions.run('x/issue', 'pvc-expand'))).toBe('TARGET_CHANGED');
    expect(grown.kube.writes()).toEqual([]);
  });
});

describe('argocd-sync and its options (prune, Server-Side Apply, Replace)', () => {
  const DUPLICATE =
    'Deployment.apps "loki-gateway" is invalid: spec.template.spec.containers[0].ports[1].name: Duplicate value: "http"';
  const offer = (o: Partial<SyncOffer> = {}): SyncOffer => ({
    prune: [],
    serverSide: false,
    canPrune: false,
    canReplace: false,
    ...o,
  });
  const live = (o: { syncOptions?: string[]; prune?: string[] } = {}) => ({
    [APP]: {
      metadata: { name: 'loki', resourceVersion: '41' },
      spec: o.syncOptions ? { syncPolicy: { syncOptions: o.syncOptions } } : {},
      status: {
        resources: (o.prune ?? []).map((name) => ({ kind: 'CronJob', name, namespace: 'loki', requiresPruning: true })),
      },
    },
  });
  const sync = (o: SyncOffer, objects: Record<string, unknown>, off: ActionType[] = []) =>
    service({ type: 'argocd-sync', namespace: 'argocd', app: 'loki', offer: o }, { objects, off });
  const operation = (kube: { writes(): { body?: unknown }[] }) =>
    (kube.writes()[0]!.body as { operation: { sync: unknown } }).operation.sync;

  it("starts a plain sync with the app's own sync options, which an operation from kubectl does not get by itself", async () => {
    const { kube, actions } = sync(offer(), live({ syncOptions: ['CreateNamespace=true', 'ServerSideApply=true'] }));
    expect(de(await actions.run('x/issue', 'argocd-sync'))).toEqual({ done: 'Sync von loki gestartet.' });
    expect(kube.writes()).toEqual([
      {
        method: 'PATCH',
        path: APP,
        body: {
          operation: {
            initiatedBy: { username: 'kubernanny' },
            info: [{ name: 'Reason', value: 'Sync from the Kubernanny app' }],
            sync: { syncStrategy: { hook: {} }, syncOptions: ['CreateNamespace=true', 'ServerSideApply=true'] },
          },
        },
      },
    ]);
  });

  it('adds Server-Side Apply when chosen, in place of an app option that turns it off', async () => {
    const { kube, actions } = sync(offer(), live({ syncOptions: ['ServerSideApply=false', 'CreateNamespace=true'] }));
    expect(de(await actions.run('x/issue', 'argocd-sync', 0, undefined, { serverSideApply: true }))).toEqual({
      done: 'Sync von loki gestartet (Server-Side Apply).',
    });
    expect(operation(kube)).toEqual({
      syncStrategy: { hook: {} },
      syncOptions: ['CreateNamespace=true', 'ServerSideApply=true'],
    });
  });

  it('prunes exactly the confirmed resources, bound to the version it compared, and only with its switch', async () => {
    const o = offer({ prune: [{ kind: 'CronJob', name: 'cleanup', namespace: 'loki' }], canPrune: true });
    const ok = sync(o, live({ prune: ['cleanup'] }));
    await ok.actions.run('x/issue', 'argocd-sync', 0, undefined, { prune: ['CronJob/loki/cleanup'] });
    expect(ok.kube.writes()[0]!.body).toMatchObject({ metadata: { resourceVersion: '41' } });
    expect(operation(ok.kube)).toEqual({ syncStrategy: { hook: {} }, prune: true });

    // Switched off: refused before anything is read.
    const off = sync(o, live({ prune: ['cleanup'] }), ['argocd-sync-prune']);
    expect(
      await code(off.actions.run('x/issue', 'argocd-sync', 0, undefined, { prune: ['CronJob/loki/cleanup'] })),
    ).toBe('ACTION_DISABLED');
    expect(off.kube.calls).toEqual([]);
    // Nothing to prune in the issue's offer.
    const none = sync(offer(), live({ prune: ['cleanup'] }));
    expect(
      await code(none.actions.run('x/issue', 'argocd-sync', 0, undefined, { prune: ['CronJob/loki/cleanup'] })),
    ).toBe('OPTION_NOT_OFFERED');
    // Argo CD would now delete more than was confirmed: no write.
    const more = sync(o, live({ prune: ['cleanup', 'backup'] }));
    expect(
      await code(more.actions.run('x/issue', 'argocd-sync', 0, undefined, { prune: ['CronJob/loki/cleanup'] })),
    ).toBe('TARGET_CHANGED');
    expect(more.kube.writes()).toEqual([]);
  });

  it('replaces only after a refused patch a replace can fix, and only with its switch', async () => {
    const failed = offer({ failure: { kind: 'duplicate', message: DUPLICATE }, serverSide: true, canReplace: true });
    const ok = sync(failed, live({ syncOptions: ['ServerSideApply=true'] }));
    expect(de(await ok.actions.run('x/issue', 'argocd-sync', 0, undefined, { replace: true }))).toEqual({
      done: 'Sync von loki gestartet (Replace).',
    });
    expect(operation(ok.kube)).toEqual({
      syncStrategy: { hook: {} },
      syncOptions: ['ServerSideApply=true', 'Replace=true'],
    });
    const off = sync(failed, live(), ['argocd-sync-replace']);
    expect(await code(off.actions.run('x/issue', 'argocd-sync', 0, undefined, { replace: true }))).toBe(
      'ACTION_DISABLED',
    );
    for (const o of [offer(), offer({ failure: { kind: 'immutable', message: 'field is immutable' } })]) {
      const not = sync(o, live());
      expect(await code(not.actions.run('x/issue', 'argocd-sync', 0, undefined, { replace: true }))).toBe(
        'OPTION_NOT_OFFERED',
      );
      expect(not.kube.calls).toEqual([]);
    }
  });

  it('refuses options for any other action', async () => {
    const { kube, actions } = service({ type: 'uncordon', node: 'n4' });
    expect(await code(actions.run('x/issue', 'uncordon', 0, undefined, { replace: true }))).toBe('OPTIONS_UNSUPPORTED');
    expect(kube.calls).toEqual([]);
  });
});
