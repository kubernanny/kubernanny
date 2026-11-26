import { describe, expect, it } from 'vitest';

import { patchFailureKind, SYNC_PRUNE_LIMIT, syncOffer, withSwitches } from './argocd-sync-offer';

const ON = { prune: true, replace: true };
const DUPLICATE =
  'one or more objects failed to apply, reason: Deployment.apps "loki-gateway" is invalid: spec.template.spec.containers[0].ports[1].name: Duplicate value: "http"';

const app = (status: object, syncOptions?: string[]) => ({
  metadata: { name: 'loki', namespace: 'argocd' },
  spec: syncOptions ? { syncPolicy: { syncOptions } } : {},
  status,
});

describe('sync options offered from the Application', () => {
  it('tells the refused patches apart', () => {
    expect(patchFailureKind(DUPLICATE)).toBe('duplicate');
    expect(
      patchFailureKind(
        'Service "web" is invalid: spec.clusterIPs[0]: Invalid value: ["10.0.0.9"]: may not change once set',
      ),
    ).toBe('invalid');
    expect(
      patchFailureKind('Deployment.apps "web" is invalid: spec.selector: Invalid value: {...}: field is immutable'),
    ).toBe('immutable');
    expect(patchFailureKind('ComparisonError: rpc error: repository not accessible')).toBeUndefined();
    expect(patchFailureKind(undefined)).toBeUndefined();
  });

  it('offers Replace for a duplicate value even when Server-Side Apply is on, and says SSA is on', () => {
    const offer = syncOffer(
      app({ operationState: { phase: 'Failed', message: DUPLICATE } }, [
        'CreateNamespace=true',
        'ServerSideApply=true',
      ]),
      ON,
    );
    expect(offer).toEqual({
      prune: [],
      serverSide: true,
      failure: { kind: 'duplicate', message: DUPLICATE },
      canPrune: false,
      canReplace: true,
    });
    // Off unless its switch is on.
    expect(withSwitches(offer, { prune: true, replace: false }).canReplace).toBe(false);
  });

  it('knows Server-Side Apply from the last sync too, and offers no replace for an immutable field', () => {
    const offer = syncOffer(
      app({
        operationState: {
          phase: 'Error',
          message: 'Job.batch "migrate" is invalid: spec.template: Invalid value: field is immutable',
          operation: { sync: { syncOptions: ['ServerSideApply=true'] } },
        },
      }),
      ON,
    );
    expect(offer.serverSide).toBe(true);
    expect(offer.failure?.kind).toBe('immutable');
    expect(offer.canReplace).toBe(false);
  });

  it('reports no failure for a sync that succeeded or failed for another reason, and cuts long messages', () => {
    expect(syncOffer(app({ operationState: { phase: 'Succeeded', message: DUPLICATE } }), ON).failure).toBeUndefined();
    expect(syncOffer(app({ operationState: { phase: 'Failed', message: 'hook failed' } }), ON).failure).toBeUndefined();
    const long = syncOffer(
      app({ operationState: { phase: 'Failed', message: `${DUPLICATE} ${'x'.repeat(2000)}` } }),
      ON,
    );
    expect(long.failure!.message).toHaveLength(600);
  });

  it('lists what prune would delete, and offers prune only for a list it can show whole', () => {
    const resources = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        kind: 'ConfigMap',
        name: `c${i}`,
        namespace: 'x',
        requiresPruning: true,
      }));
    const few = syncOffer(
      app({ resources: [...resources(2), { kind: 'Deployment', name: 'web', namespace: 'x', status: 'OutOfSync' }] }),
      ON,
    );
    expect(few.prune).toEqual([
      { kind: 'ConfigMap', name: 'c0', namespace: 'x' },
      { kind: 'ConfigMap', name: 'c1', namespace: 'x' },
    ]);
    expect(few.canPrune).toBe(true);
    expect(syncOffer(app({ resources: resources(2) }), { prune: false, replace: true }).canPrune).toBe(false);
    const many = syncOffer(app({ resources: resources(SYNC_PRUNE_LIMIT + 1) }), ON);
    expect(many.prune).toHaveLength(SYNC_PRUNE_LIMIT);
    expect(many.pruneMore).toBe(true);
    expect(many.canPrune).toBe(false);
  });
});
