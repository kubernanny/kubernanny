/**
 * Regression tests with trimmed copies of objects as a real RKE2 cluster
 * returns them (names anonymised). Each case is a reading that was wrong
 * against real data.
 */
import { describe, expect, it } from 'vitest';

import { evaluateArgoApps, isAutomated } from '../../checks/argocd.check';
import { evaluateCnpg } from '../../checks/cnpg.check';
import { Detected } from '../../discovery/discovery';
import { emptyInventory } from '../../inventory/inventory';
import { KubeClient } from '../../kube/kube-client';
import { de } from '../../testing/i18n';
import { ModuleContext } from '../types';
import { InfisicalIntegration } from './infisical';
import { KuredIntegration } from './kured';

const NOW = new Date('2026-11-25T08:00:00Z');

class Lists extends KubeClient {
  constructor(private readonly items: Record<string, unknown[]>) {
    super();
  }
  override get inCluster(): boolean {
    return false;
  }
  override async list<T>(path: string): Promise<T[] | null> {
    return (this.items[path] as T[] | undefined) ?? null;
  }
}

const fakeProm = (answers: Record<string, { metric: Record<string, string>; value: number }[]>) =>
  ({
    query: async (expr: string) => answers[expr] ?? [],
    scalar: async () => null,
  }) as unknown as ModuleContext['prom'];

function ctx(kube: KubeClient, inv = emptyInventory(NOW), prom: ModuleContext['prom'] = null): ModuleContext {
  return { inv, kube, config: { backupMaxAgeHours: 26 } as ModuleContext['config'], now: NOW, prom, data: {} };
}

const det = (id: string, namespace: string, kind: string, name: string) =>
  ({
    entry: { id },
    namespace,
    services: [],
    links: [],
    workloads: [{ kind, namespace, name, ready: 3, desired: 3 }],
  }) as unknown as Detected;

describe('Infisical operator conditions', () => {
  // Operator v0.11.18: no Ready condition; the static secret reports LastReconcileStatus.
  const staticSecret = (name: string, status: 'True' | 'False', message: string) => ({
    metadata: { name, namespace: 'shop' },
    status: {
      error: status === 'False',
      observedGeneration: 1,
      conditions: [
        {
          type: 'secrets.infisical.com/LastReconcileStatus',
          status,
          reason: status === 'True' ? 'OK' : 'Error',
          message,
        },
        { type: 'secrets.infisical.com/LastReconcileAuthMethod', status: 'True', reason: 'OK', message: 'kubernetes' },
        {
          type: 'secrets.infisical.com/LastSuccessfulReconcileAt',
          status: 'True',
          reason: 'OK',
          message: '2026-11-25T07:31:23Z',
        },
      ],
    },
  });

  it('counts static secrets as ready by LastReconcileStatus, so stats and summary agree', async () => {
    const kube = new Lists({
      '/apis/secrets.infisical.com/v1beta1/infisicalstaticsecrets': [
        staticSecret('shop-api', 'True', 'Reconciliation successful'),
        staticSecret('shop-mail', 'True', 'Reconciliation successful'),
      ],
    });
    const r = de(
      await new InfisicalIntegration().run(
        ctx(kube),
        det('infisical', 'infisical', 'Deployment', 'infisical'),
        () => true,
      ),
    );
    expect(r.issues).toEqual([]);
    expect(r.summary).toBe('Alles bereit');
    expect(r.stats).toEqual([{ label: 'InfisicalStaticSecret', value: '2/2 bereit', tone: 'ok' }]);
  });

  it('reports a failed reconcile, and reads the inverted Reconcile condition of push secrets', async () => {
    const kube = new Lists({
      '/apis/secrets.infisical.com/v1beta1/infisicalstaticsecrets': [
        staticSecret('shop-api', 'False', 'Reconciliation failed: 403 forbidden'),
      ],
      '/apis/secrets.infisical.com/v1alpha1/infisicalpushsecrets': [
        {
          metadata: { name: 'ok-push', namespace: 'shop' },
          status: { conditions: [{ type: 'secrets.infisical.com/Reconcile', status: 'False', reason: 'OK' }] },
        },
        {
          metadata: { name: 'bad-push', namespace: 'shop' },
          status: {
            conditions: [
              {
                type: 'secrets.infisical.com/Reconcile',
                status: 'True',
                reason: 'Error',
                message: 'Reconcile failed, secrets were not pushed',
              },
            ],
          },
        },
      ],
      '/apis/secrets.infisical.com/v1alpha1/infisicalsecrets': [
        {
          metadata: { name: 'legacy', namespace: 'shop' },
          status: { conditions: [{ type: 'secrets.infisical.com/ReadyToSyncSecrets', status: 'True', reason: 'OK' }] },
        },
        { metadata: { name: 'fresh', namespace: 'shop' } },
      ],
    });
    const r = de(
      await new InfisicalIntegration().run(
        ctx(kube),
        det('infisical', 'infisical', 'Deployment', 'infisical'),
        () => true,
      ),
    );
    expect(r.issues.map((i) => [i.id, i.check, i.cause])).toEqual([
      ['infisical/InfisicalStaticSecret/shop/shop-api', 'infisical', 'Reconciliation failed: 403 forbidden'],
      ['infisical/InfisicalPushSecret/shop/bad-push', 'infisical', 'Reconcile failed, secrets were not pushed'],
    ]);
    expect(r.stats.map((s) => `${s.label} ${s.value}`)).toEqual([
      'InfisicalSecret 1/2 bereit',
      'InfisicalStaticSecret 0/1 bereit',
      'InfisicalPushSecret 1/2 bereit',
    ]);
  });
});

describe('kured', () => {
  const inv = () => {
    const i = emptyInventory(NOW);
    i.daemonsets = [
      {
        metadata: {
          name: 'kured',
          namespace: 'kube-system',
          annotations: { 'deprecated.daemonset.template.generation': '4' },
        },
        spec: { template: { spec: { containers: [] } } },
      },
    ];
    return i;
  };

  it('does not claim "0 waiting" when Prometheus does not scrape kured', async () => {
    const r = de(
      await new KuredIntegration().run(
        ctx(new Lists({}), inv(), fakeProm({})),
        det('kured', 'kube-system', 'DaemonSet', 'kured'),
        () => true,
      ),
    );
    expect(r.stats).toEqual([]);
    expect(r.summary).toBe('Kein Neustart im Gange');
  });

  it('counts the nodes kured reports, and reads the multi-owner lock format', async () => {
    const i = inv();
    i.daemonsets[0]!.metadata.annotations = {
      'weave.works/kured-node-lock': JSON.stringify({
        maxOwners: 2,
        locks: [{ nodeID: 'node-2', created: '2026-11-25T07:50:00Z', TTL: 0 }],
      }),
    };
    const prom = fakeProm({
      kured_reboot_required: [
        { metric: { node: 'node-1' }, value: 1 },
        { metric: { node: 'node-2' }, value: 0 },
      ],
    });
    const r = de(
      await new KuredIntegration().run(
        ctx(new Lists({}), i, prom),
        det('kured', 'kube-system', 'DaemonSet', 'kured'),
        () => true,
      ),
    );
    expect(r.summary).toBe('Startet node-2 neu');
    const quiet = de(
      await new KuredIntegration().run(
        ctx(new Lists({}), inv(), prom),
        det('kured', 'kube-system', 'DaemonSet', 'kured'),
        () => true,
      ),
    );
    expect(quiet.summary).toBe('1 Node wartet auf das nächste Fenster');
    const none = de(
      await new KuredIntegration().run(
        ctx(new Lists({}), inv(), fakeProm({ kured_reboot_required: [{ metric: { node: 'node-1' }, value: 0 }] })),
        det('kured', 'kube-system', 'DaemonSet', 'kured'),
        () => true,
      ),
    );
    expect(none.summary).toBe('Kein Neustart nötig');
  });
});

describe('Argo CD sync policy', () => {
  it('treats automated.enabled: false (Argo CD 3) as manual sync, so OutOfSync is routine (ready to sync), not an issue', () => {
    const app = (automated: unknown) => ({
      metadata: { name: 'shop-web', namespace: 'argocd' },
      spec: { syncPolicy: { automated } },
      status: { sync: { status: 'OutOfSync' }, health: { status: 'Healthy' }, operationState: { phase: 'Succeeded' } },
    });
    expect(isAutomated(app({ prune: true, selfHeal: true }))).toBe(true);
    expect(isAutomated(app({ enabled: false, prune: true }))).toBe(false);
    expect(isAutomated(app(null))).toBe(false);
    expect(evaluateArgoApps([app({ enabled: false })], emptyInventory(NOW), NOW).map((i) => i.severity)).toEqual([]);
    expect(evaluateArgoApps([app({ selfHeal: true })], emptyInventory(NOW), NOW).map((i) => i.severity)).toEqual([
      'warning',
    ]);
  });
});

describe('CloudNativePG backups', () => {
  // CNPG 1.30 with the in-tree barmanObjectStore: the failed run is recorded next to the last success.
  const cluster = (lastSuccessfulBackup: string, lastFailedBackup: string, succeeded: 'True' | 'False') => ({
    metadata: { name: 'shop-pg', namespace: 'shop' },
    spec: { instances: 3, backup: { barmanObjectStore: { destinationPath: 's3://backups/shop-pg' } } },
    status: {
      phase: 'Cluster in healthy state',
      instances: 3,
      readyInstances: 3,
      currentPrimary: 'shop-pg-1',
      lastSuccessfulBackup,
      lastFailedBackup,
      conditions: [
        { type: 'ContinuousArchiving', status: 'True', reason: 'ContinuousArchivingSuccess' },
        {
          type: 'LastBackupSucceeded',
          status: succeeded,
          reason: succeeded === 'True' ? 'LastBackupSucceeded' : 'LastBackupFailed',
          message: succeeded === 'True' ? '' : 'barman-cloud-backup exited with 4',
        },
      ],
    },
  });

  it('is quiet when an old failure was followed by a success, and warns when the newest run failed', () => {
    expect(
      evaluateCnpg([cluster('2026-11-25T02:20:57Z', '2026-09-28T02:00:01Z', 'True')], NOW, { backupMaxAgeHours: 26 }),
    ).toEqual([]);
    const [issue] = de(
      evaluateCnpg([cluster('2026-11-24T20:20:57Z', '2026-11-25T02:00:01Z', 'False')], NOW, { backupMaxAgeHours: 26 }),
    );
    expect(issue).toMatchObject({
      id: 'cnpg/shop/shop-pg/backup',
      severity: 'warning',
      title: 'Letztes Backup von shop/shop-pg fehlgeschlagen',
      cause: 'barman-cloud-backup exited with 4',
    });
  });
});
