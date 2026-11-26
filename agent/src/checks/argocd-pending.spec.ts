import { describe, expect, it } from 'vitest';

import { imageChanges, isReadyToSync, pendingSync } from './argocd-pending';

// The shape of a real manual app with an Image Updater change waiting (kubernanny-chart, November 2026).
const app = {
  metadata: { name: 'kubernanny-chart', namespace: 'argocd' },
  spec: {
    project: 'default',
    destination: { namespace: 'kubernanny', server: 'https://kubernetes.default.svc' },
    source: {
      repoURL: 'https://github.com/example/infra',
      path: 'charts/kubernanny-chart',
      helm: {
        parameters: [
          { name: 'image.name', value: 'ghcr.io/kubernanny/agent' },
          { name: 'image.tag', value: '2026-11-25-14' },
        ],
      },
    },
  },
  status: {
    sync: { status: 'OutOfSync', revision: 'e7eb06b454bb654df4d1d4d0f3d5232135f295d6' },
    health: { status: 'Healthy' },
    operationState: {
      phase: 'Succeeded',
      finishedAt: '2026-11-25T09:49:40Z',
      syncResult: { revision: 'aee71e4addd4d082239a2e49fc90b321e87d4a8e' },
    },
    summary: { images: ['ghcr.io/kubernanny/agent:2026-11-25-11'] },
    history: [{ id: 3, revision: 'aee71e4addd4d082239a2e49fc90b321e87d4a8e', deployedAt: '2026-11-25T09:49:40Z' }],
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
      { kind: 'ConfigMap', name: 'old', namespace: 'kubernanny', status: 'OutOfSync', requiresPruning: true },
      { kind: 'Service', name: 'kubernanny', namespace: 'kubernanny', status: 'Synced' },
    ],
  },
};

describe('apps ready to sync', () => {
  it('lists what the sync changes, from the Application resource alone', () => {
    expect(isReadyToSync(app, false)).toBe(true);
    expect(pendingSync(app, true)).toEqual({
      id: 'argocd/argocd/kubernanny-chart/sync',
      namespace: 'argocd',
      app: 'kubernanny-chart',
      project: 'default',
      destination: 'kubernanny',
      lastSyncAt: '2026-11-25T09:49:40Z',
      syncedRevision: 'aee71e4',
      targetRevision: 'e7eb06b',
      resources: [
        { kind: 'Deployment', name: 'kubernanny', namespace: 'kubernanny', change: 'update' },
        { kind: 'Role', name: 'kubernanny-keys', namespace: 'kubernanny', change: 'new' },
        { kind: 'ConfigMap', name: 'old', namespace: 'kubernanny', change: 'prune' },
      ],
      images: [{ from: 'ghcr.io/kubernanny/agent:2026-11-25-11', to: 'ghcr.io/kubernanny/agent:2026-11-25-14' }],
      canSync: true,
      // A plain sync leaves the ConfigMap standing; only with argocd-sync-prune on can the app choose to delete it.
      offer: {
        prune: [{ kind: 'ConfigMap', name: 'old', namespace: 'kubernanny' }],
        serverSide: false,
        canPrune: false,
        canReplace: false,
      },
    });
    expect(pendingSync(app, true, { prune: true, replace: true }).offer).toMatchObject({
      canPrune: true,
      canReplace: false,
    });
  });

  it('reads Kustomize image overrides and ignores a registry port', () => {
    const k = {
      ...app,
      spec: { source: { kustomize: { images: ['web=registry.local:5000/web:2.1'] } } },
      status: { ...app.status, summary: { images: ['registry.local:5000/web:2.0'] } },
    };
    expect(imageChanges(k as never)).toEqual([
      { from: 'registry.local:5000/web:2.0', to: 'registry.local:5000/web:2.1' },
    ]);
  });

  it('is not ready to sync when degraded, after a failed sync, or when Argo syncs it itself', () => {
    expect(isReadyToSync({ ...app, status: { ...app.status, health: { status: 'Degraded' } } }, false)).toBe(false);
    expect(isReadyToSync({ ...app, status: { ...app.status, operationState: { phase: 'Failed' } } }, false)).toBe(
      false,
    );
    expect(isReadyToSync(app, true)).toBe(false);
  });
});
