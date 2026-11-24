import { describe, expect, it } from 'vitest';
import { Snapshot } from '../core/agent.model';
import { translatorFor } from '../i18n/translator';
import { buildClusterView } from './cluster-view';
import { statusReport } from './status-report';

const NOW = new Date('2026-11-24T12:00:00Z');

const snapshot: Snapshot = {
  cluster: 'home',
  light: 'red',
  score: 78,
  checkedAt: '2026-11-24T11:58:00Z',
  durationMs: 31,
  agentVersion: '0.4.0',
  kubernetes: { version: 'v1.33.4+rke2r1', distribution: 'RKE2' },
  modules: [{ id: 'argocd', name: 'Argo CD' } as Snapshot['modules'][number]],
  issues: [
    {
      id: 'argocd/web/health',
      check: 'argocd',
      module: 'argocd',
      severity: 'critical',
      title: 'App web Degraded',
      cause: 'Deployment web exceeded its progress deadline',
      since: '2026-11-24T11:00:00Z',
      actions: [{ type: 'argocd-sync', namespace: 'argocd', app: 'web' }],
    },
    { id: 'hint/1', check: 'argocd', module: 'argocd', severity: 'info', title: 'Change waits for sync', cause: '', since: '2026-11-24T10:00:00Z', actions: [] },
    { id: 'quiet/1', check: 'argocd', module: 'argocd', severity: 'warning', title: 'Slow backup', cause: 'Takes 3 h', since: '2026-11-24T09:00:00Z', silencedUntil: '2026-11-24T18:30:00Z', actions: [] },
  ],
} as Snapshot;

describe('statusReport', () => {
  it('writes what the screen shows as plain text, in German', () => {
    const tr = translatorFor('de');
    const text = statusReport({ name: 'homelab', view: buildClusterView(snapshot, null, NOW, tr), checkedAt: snapshot.checkedAt, agentVersion: '0.4.0', error: null }, tr);
    expect(text.split('\n').slice(0, 2)).toEqual(['Kubernanny: Zustand von homelab', 'Zustand: 1 Ausfall (Ampel rot, 78 von 100)']);
    expect(text).toContain('Agent 0.4.0');
    expect(text).toContain('Offene Probleme (1):\n- [Ausfall] App web Degraded\n  Deployment web exceeded its progress deadline\n  Argo CD, seit 1 h');
    expect(text).toContain('Hinweise (1):\n- [Hinweis] Change waits for sync\n  Argo CD, seit 2 h');
    expect(text).toMatch(/Stummgeschaltet \(1\):\n- \[Warnung\] Slow backup\n {2}Takes 3 h\n {2}Argo CD, stumm bis /);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('never carries ids, addresses or keys', () => {
    const tr = translatorFor('en');
    const text = statusReport({ name: 'homelab', view: buildClusterView(snapshot, null, NOW, tr), checkedAt: snapshot.checkedAt, agentVersion: null, error: null }, tr);
    expect(text).not.toMatch(/argocd\/web\/health|hint\/1|quiet\/1|https?:\/\//);
    expect(text).toContain('State: 1 outage (traffic light red, health 78 of 100)');
    expect(text).toContain('- [Outage] App web Degraded');
  });

  it('says when it is only the last known state', () => {
    const tr = translatorFor('en');
    const error = 'The agent cannot be reached. Are you on the VPN?';
    const text = statusReport({ name: 'homelab', view: buildClusterView({ ...snapshot, issues: [] }, error, NOW, tr), checkedAt: snapshot.checkedAt, agentVersion: null, error }, tr);
    expect(text).toContain('traffic light grey');
    expect(text).toContain(`No connection to the agent: ${error} This is the last known state.`);
    expect(text).toContain('No open issues.');
  });
});
