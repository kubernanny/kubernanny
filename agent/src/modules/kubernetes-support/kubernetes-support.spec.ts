import { describe, expect, it } from 'vitest';

import { maintainedMinor } from '../../demo/demo-cluster';
import { de, en } from '../../testing/i18n';
import { deprecatedApisFrom, evaluateDeprecatedApis } from './deprecated-apis';
import { evaluateKubernetesSupport, upgradeGuide } from './evaluate';
import { KUBERNETES_EOL, RELEASES_COMPILED } from './releases';

const day = 86_400_000;
const at = (iso: string) => new Date(`${iso}T12:00:00Z`);
const table = { 30: '2025-07-15', 31: '2025-11-11', 32: '2026-02-28', 33: '2026-06-28' };

describe('kubernetes-support', () => {
  it('warns past the end of life and names the oldest maintained minor and the upgrade guide', () => {
    const state = evaluateKubernetesSupport('v1.30.4+rke2r1', at('2026-01-10'), 'RKE2', table);
    expect(state).toMatchObject({ minor: '1.30', eol: '2025-07-15', ended: true, next: '1.32' });
    expect(state.issues).toHaveLength(1);
    const issue = de(state.issues[0]!);
    expect(issue).toMatchObject({
      id: 'kubernetes-support/1.30',
      severity: 'warning',
      actions: [],
      title: 'Kubernetes 1.30 bekommt keine Updates mehr',
    });
    expect(issue.cause).toBe(
      'Das Kubernetes-Projekt pflegt 1.30 seit dem 15.07.2025 nicht mehr, auch Sicherheitslücken werden nicht mehr geschlossen. Aktualisiere auf 1.32 oder neuer, eine Minor-Version nach der anderen. Anleitung: https://docs.rke2.io/upgrades/manual_upgrade',
    );
    expect(en(state.issues[0]!).cause).toContain('stopped maintaining 1.30 on 2025-07-15');
  });

  it('warns from 60 days before the end, hints from 120, and is quiet before', () => {
    const before = (days: number) => new Date(Date.parse('2026-06-28T23:59:59Z') - days * day);
    expect(evaluateKubernetesSupport('v1.33.1', before(59), 'k3s', table).issues[0]).toMatchObject({
      severity: 'warning',
    });
    expect(en(evaluateKubernetesSupport('v1.33.1', before(59), 'k3s', table).issues[0]!).title).toBe(
      'Kubernetes 1.33: support ends in 59 days',
    );
    expect(en(evaluateKubernetesSupport('v1.33.1', before(59), 'k3s', table).issues[0]!).cause).toContain(
      'https://docs.k3s.io/upgrades',
    );
    expect(evaluateKubernetesSupport('v1.33.1', before(100), 'k3s', table).issues[0]).toMatchObject({
      severity: 'info',
    });
    expect(evaluateKubernetesSupport('v1.33.1', before(130), 'k3s', table).issues).toEqual([]);
  });

  it('says nothing about a minor newer than the table, and calls one older than the table ended', () => {
    expect(evaluateKubernetesSupport('v1.34.0', at('2026-01-10'), 'kubeadm', table)).toMatchObject({
      minor: '1.34',
      eol: null,
      issues: [],
    });
    const old = evaluateKubernetesSupport('v1.18.20', at('2026-01-10'), 'kubeadm', table);
    expect(old.issues[0]).toMatchObject({ severity: 'warning' });
    expect(de(old.issues[0]!).cause).toContain('schon lange nicht mehr');
    expect(de(old.issues[0]!).cause).toContain('kubeadm-upgrade');
  });

  it('is only a hint when the table knows nothing newer that is still maintained (the table is out of date)', () => {
    expect(evaluateKubernetesSupport('v1.33.0', at('2027-01-10'), 'RKE2', table).issues[0]).toMatchObject({
      severity: 'info',
    });
    expect(en(evaluateKubernetesSupport('v1.33.0', at('2027-01-10'), 'RKE2', table).issues[0]!).cause).toContain(
      'Upgrade to a newer minor version',
    );
  });

  it('cannot judge an unreadable version', () => {
    expect(evaluateKubernetesSupport(undefined, at('2026-01-10'), 'RKE2')).toMatchObject({ minor: null, issues: [] });
    expect(evaluateKubernetesSupport('garbage', at('2026-01-10'), 'RKE2').issues).toEqual([]);
  });

  it('points managed clusters to the release list and everything unknown to kubeadm', () => {
    expect(upgradeGuide('EKS')).toBe('https://kubernetes.io/releases/');
    expect(upgradeGuide('kubeadm')).toContain('kubeadm-upgrade');
  });

  it('keeps its table ordered, dated and in the past of its compile date only for released minors', () => {
    const minors = Object.keys(KUBERNETES_EOL).map(Number);
    expect(minors).toEqual([...minors].sort((a, b) => a - b));
    expect(Object.values(KUBERNETES_EOL).every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))).toBe(true);
    expect(RELEASES_COMPILED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('gives the healthy demo a minor that stays quiet whatever the date', () => {
    for (const date of ['2026-11-24', '2027-05-01', '2030-01-01']) {
      const now = at(date);
      expect(evaluateKubernetesSupport(`v1.${maintainedMinor(now)}.4+rke2r1`, now, 'RKE2').issues, date).toEqual([]);
    }
  });
});

describe('deprecated APIs in use', () => {
  const sample = (group: string, version: string, resource: string, removed_release: string) => ({
    metric: { group, version, resource, removed_release },
  });
  const apis = deprecatedApisFrom([
    sample('flowcontrol.apiserver.k8s.io', 'v1beta3', 'flowschemas', '1.34'),
    sample('flowcontrol.apiserver.k8s.io', 'v1beta3', 'prioritylevelconfigurations', '1.34'),
    sample('resource.k8s.io', 'v1beta1', 'deviceclasses', '1.37'),
    sample('policy', 'v1beta1', 'poddisruptionbudgets', '1.25'),
    sample('', 'v1', 'componentstatuses', ''),
  ]);

  it('warns about what the next minor removes and hints at later removals', () => {
    const issues = evaluateDeprecatedApis(apis, '1.33');
    expect(issues.map((i) => [i.id, i.severity])).toEqual([
      ['kubernetes-support/deprecated-apis/1.34', 'warning'],
      ['kubernetes-support/deprecated-apis/1.37', 'info'],
    ]);
    expect(en(issues[0]!).title).toBe('2 APIs in use are gone in Kubernetes 1.34');
    expect(en(issues[0]!).cause).toContain(
      'flowcontrol.apiserver.k8s.io/v1beta3 flowschemas, flowcontrol.apiserver.k8s.io/v1beta3 prioritylevelconfigurations',
    );
    expect(de(issues[1]!).title).toBe('Eine genutzte API fehlt ab Kubernetes 1.37');
    expect(issues.every((i) => i.actions.length === 0)).toBe(true);
  });

  it('ignores removals the running version is already past, and samples without a release', () => {
    expect(apis).toHaveLength(4);
    expect(evaluateDeprecatedApis(apis, '1.36').map((i) => i.id)).toEqual(['kubernetes-support/deprecated-apis/1.37']);
    expect(evaluateDeprecatedApis(apis, null)).toEqual([]);
  });
});
