import { describe, expect, it } from 'vitest';

import { PendingSync, SyncOffer } from '../core/agent.model';
import { translatorFor } from '../i18n/translator';
import { pendingSyncRows } from './pending-syncs';
import { needsSyncSheet, syncOptionsView } from './sync-options';

const de = translatorFor('de');
const en = translatorFor('en');
const DUPLICATE =
  'Deployment.apps "loki-gateway" is invalid: spec.template.spec.containers[0].ports[1].name: Duplicate value: "http"';

const offer = (o: Partial<SyncOffer> = {}): SyncOffer => ({
  prune: [],
  serverSide: false,
  canPrune: false,
  canReplace: false,
  ...o,
});

describe('the sync sheet', () => {
  it('is needed only for something to delete or a refused patch', () => {
    expect(needsSyncSheet(undefined)).toBe(false);
    expect(needsSyncSheet(offer({ serverSide: true }))).toBe(false);
    expect(needsSyncSheet(offer({ prune: [{ kind: 'CronJob', name: 'c', namespace: 'x' }] }))).toBe(
      true,
    );
    expect(needsSyncSheet(offer({ failure: { kind: 'immutable', message: 'm' } }))).toBe(true);
  });

  it('lists every resource prune would delete, as the agent expects them back, greyed while the switch is off', () => {
    const prune = [
      { kind: 'CronJob', name: 'weblate-cleanup', namespace: 'weblate' },
      { kind: 'ClusterRole', name: 'old' },
    ];
    const on = syncOptionsView('weblate-chart', offer({ prune, canPrune: true }), de);
    expect(on.prune).toMatchObject({
      title: 'Löschen, was nicht mehr im Repo ist',
      intro: 'Argo CD löscht diese 2 Ressourcen aus dem Cluster:',
      resources: [
        { key: 'CronJob/weblate/weblate-cleanup', text: 'CronJob weblate/weblate-cleanup' },
        { key: 'ClusterRole//old', text: 'ClusterRole old' },
      ],
      enabled: true,
      note: null,
    });
    expect(on.serverSide).toBeNull();
    expect(on.replace).toBeNull();
    expect(on.failure).toBeNull();
    const off = syncOptionsView('weblate-chart', offer({ prune }), en);
    expect(off.prune).toMatchObject({
      enabled: false,
      note: 'Switched off (argocd-sync-prune). Without deleting they stay.',
    });
  });

  it('suggests Replace for a duplicate value when Server-Side Apply is on already, and does not offer SSA again', () => {
    const view = syncOptionsView(
      'loki-chart',
      offer({
        serverSide: true,
        failure: { kind: 'duplicate', message: DUPLICATE },
        canReplace: true,
      }),
      de,
    );
    expect(view.failure?.message).toBe(DUPLICATE);
    expect(view.failure?.explanation).toContain(
      'Ersetzen schreibt das Objekt so, wie es in Git steht.',
    );
    expect(view.serverSide).toBeNull();
    expect(view.serverSideOn).toBe('Server-Side Apply ist für diese App schon an.');
    expect(view.replace).toMatchObject({ title: 'Ersetzen', enabled: true, recommended: true });
  });

  it('offers Server-Side Apply for another refused patch, and nothing for an immutable field', () => {
    const invalid = syncOptionsView(
      'a',
      offer({ failure: { kind: 'invalid', message: 'is invalid' } }),
      en,
    );
    expect(invalid.serverSide).toMatchObject({ title: 'Server-Side Apply', recommended: true });
    expect(invalid.replace).toMatchObject({
      enabled: false,
      note: 'Switched off (argocd-sync-replace).',
      recommended: false,
    });
    const immutable = syncOptionsView(
      'a',
      offer({ failure: { kind: 'immutable', message: 'field is immutable' }, canReplace: false }),
      en,
    );
    expect(immutable.serverSide).toBeNull();
    expect(immutable.replace).toBeNull();
    expect(immutable.failure?.explanation).toContain('has to be deleted and created again');
  });

  it('says under the pending list whether a sync from here deletes what is no longer in Git', () => {
    const pending = (canPrune: boolean): PendingSync => ({
      id: 'argocd/argocd/weblate-chart/sync',
      namespace: 'argocd',
      app: 'weblate-chart',
      resources: [
        { kind: 'StatefulSet', name: 'weblate', change: 'update' },
        { kind: 'CronJob', name: 'weblate-cleanup', namespace: 'weblate', change: 'prune' },
      ],
      images: [],
      canSync: true,
      offer: offer({
        prune: [{ kind: 'CronJob', name: 'weblate-cleanup', namespace: 'weblate' }],
        canPrune,
      }),
    });
    const now = new Date('2026-11-25T12:00:00Z');
    expect(pendingSyncRows([pending(true)], now, de)[0]).toMatchObject({
      pruneNote:
        'Nicht mehr im Repo. Ein Sync löscht sie nur, wenn du beim Sync „Löschen, was nicht mehr im Repo ist“ wählst.',
    });
    expect(pendingSyncRows([pending(false)], now, en)[0]!.pruneNote).toBe(
      'No longer in Git. A sync from the app leaves it in place: deleting on sync is switched off.',
    );
    expect(pendingSyncRows([pending(false)], now, en)[0]!.resources[1]!.label).toBe('not in Git');
  });
});
