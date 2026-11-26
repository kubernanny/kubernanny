import { describe, expect, it } from 'vitest';

import { Issue, IssueAction } from '../core/agent.model';
import { de as deTexts } from '../i18n/de';
import { flatten } from '../i18n/dictionary';
import { en as enTexts } from '../i18n/en';
import { translatorFor } from '../i18n/translator';
import { actionButton, issueCards } from './cluster-view';

const NOW = new Date('2026-11-24T12:00:00Z');
const de = translatorFor('de');
const en = translatorFor('en');

const issue = (actions: IssueAction[]): Issue => ({
  id: 'pods/shop/Deployment/web',
  check: 'pods',
  module: 'pods',
  severity: 'critical',
  title: 't',
  cause: 'c',
  actions,
  since: NOW.toISOString(),
});

const ALL: IssueAction[] = [
  { type: 'restart', kind: 'Deployment', namespace: 'shop', name: 'web' },
  { type: 'uncordon', node: 'rke2-node-4' },
  { type: 'job-rerun', namespace: 'default', from: 'CronJob', name: 'nightly' },
  { type: 'job-rerun', namespace: 'default', from: 'Job', name: 'migrate' },
  { type: 'reconcile-now', kind: 'Kustomization', namespace: 'flux-system', name: 'apps' },
  { type: 'reconcile-now', kind: 'ExternalSecret', namespace: 'shop', name: 'db' },
  { type: 'reconcile-now', kind: 'InfisicalStaticSecret', namespace: 'shop', name: 'token' },
  { type: 'reconcile-now', kind: 'Certificate', namespace: 'weblate', name: 'weblate-tls' },
  { type: 'cleanup-pods', namespace: 'default', pods: ['a', 'b'] },
  {
    type: 'force-delete-terminating',
    namespace: 'monitoring',
    pod: 'uptime-kuma-0',
    node: 'rke2-node-2',
    statefulSet: 'uptime-kuma',
  },
  {
    type: 'longhorn-backup',
    namespace: 'longhorn-system',
    volume: 'pvc-1',
    label: 'weblate/data-weblate-0',
  },
  { type: 'velero-backup', namespace: 'velero', schedule: 'daily-apps' },
  { type: 'argocd-terminate-op', namespace: 'argocd', app: 'discourse-new' },
  {
    type: 'pvc-expand',
    namespace: 'monitoring',
    name: 'data-prom-0',
    from: '50Gi',
    to: '63Gi',
    template: 'prom',
  },
];

describe('action buttons', () => {
  it('puts the logs first on a crash loop and the restart second, quiet, with its hint', () => {
    const [card] = issueCards(
      [
        issue([
          { type: 'logs', namespace: 'shop', pod: 'web-1', previous: true },
          { type: 'restart', kind: 'Deployment', namespace: 'shop', name: 'web', secondary: true },
        ]),
      ],
      [],
      NOW,
      de,
    );
    expect(card!.buttons.map((b) => [b.label, b.emphasis, b.hint])).toEqual([
      ['Logs vor dem Absturz', 'primary', null],
      [
        'web neu starten',
        'secondary',
        'Hilft, wenn du die Ursache schon behoben hast, z.\u00a0B. ein Secret geändert oder eine Abhängigkeit ist wieder da.',
      ],
    ]);
  });

  it('makes the restart the primary button when a ConfigMap changed, and its confirmation says so', () => {
    const [card] = issueCards(
      [
        issue([
          {
            type: 'restart',
            kind: 'Deployment',
            namespace: 'shop',
            name: 'web',
            changed: { kind: 'ConfigMap', name: 'app-config' },
          },
          { type: 'logs', namespace: 'shop', pod: 'web-1' },
        ]),
      ],
      [],
      NOW,
      de,
    );
    expect(card!.buttons[0]).toMatchObject({ type: 'restart', emphasis: 'primary', hint: null });
    expect(card!.buttons[0]!.confirm).toBe(
      'Deployment shop/web neu starten? Die Pods werden nacheinander ersetzt und lesen dabei die geänderte ConfigMap app-config.',
    );
  });

  it('confirms every action that changes the cluster, naming what exactly happens, in both languages', () => {
    for (const tr of [de, en]) {
      for (const action of ALL) {
        const b = actionButton(action, 0, tr);
        expect(b.confirm, action.type).toBeTruthy();
        expect(b.confirm, action.type).not.toMatch(/\{\{|[–—]/);
        expect(b.label, action.type).not.toMatch(/\{\{/);
      }
    }
  });

  it('names the risk where there is one: running twice, no shrinking back, the template that stays', () => {
    const force = actionButton(ALL[9]!, 0, de).confirm!;
    expect(force).toContain('startet StatefulSet uptime-kuma denselben Pod ein zweites Mal');
    const grow = actionButton(ALL[13]!, 0, en);
    expect(grow.label).toBe('Grow to 63Gi');
    expect(grow.confirm).toBe(
      "Grow PVC monitoring/data-prom-0 from 50Gi to 63Gi? A volume cannot be shrunk afterwards. StatefulSet prom's volumeClaimTemplates keep the old size: change them wherever you manage them.",
    );
    expect(actionButton(ALL[7]!, 0, de)).toMatchObject({
      label: 'Neu ausstellen',
      icon: 'ribbon-outline',
    });
    expect(actionButton(ALL[8]!, 0, de).confirm).toBe(
      '2 beendete Pods in default löschen? Nur Pods, die nicht mehr laufen. Ihre Logs gehen damit verloren.',
    );
    expect(
      actionButton({ type: 'cleanup-pods', namespace: 'default', pods: ['a'] }, 0, en).confirm,
    ).toBe('Delete one finished pod in default? It no longer runs. Its logs go with it.');
  });

  it('has no em or en dashes in the new texts', () => {
    for (const texts of [deTexts, enTexts]) {
      for (const [key, value] of Object.entries(flatten(texts.actions, 'actions.'))) {
        expect(value, key).not.toMatch(/[–—]/);
      }
    }
  });
});
