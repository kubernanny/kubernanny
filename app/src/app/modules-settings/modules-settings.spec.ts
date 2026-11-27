import { describe, expect, it } from 'vitest';

import { SettingsView } from '../core/agent.model';
import { translatorFor } from '../i18n/translator';
import { settingsSections } from './modules-settings.page';

const de = translatorFor('de');

const view: SettingsView = {
  modules: [
    {
      id: 'nodes',
      name: 'Nodes',
      icon: 'hardware-chip-outline',
      category: 'core',
      description: 'Erreichbarkeit der Maschinen.',
      deep: true,
      detected: true,
      state: 'on',
    },
    {
      id: 'argocd',
      name: 'Argo CD',
      icon: 'git-branch-outline',
      category: 'gitops',
      description: 'GitOps.',
      deep: true,
      detected: true,
      state: 'off',
    },
    {
      id: 'weblate',
      name: 'Weblate',
      icon: 'language-outline',
      category: 'apps',
      description: 'Übersetzungen.',
      deep: false,
      detected: true,
      state: 'on',
    },
    {
      id: 'velero',
      name: 'Velero',
      icon: 'archive-outline',
      category: 'storage',
      description: 'Backups.',
      deep: true,
      detected: false,
      state: 'locked',
    },
  ],
  actions: [
    { type: 'logs', label: 'Logs lesen', description: 'Logs.', effect: 'l', state: 'on' },
    // An agent before lockedBy/optIn: locked, reason unknown, counts as disabled.
    {
      type: 'restart',
      label: 'Workloads neu starten',
      description: 'x',
      effect: 'y',
      state: 'locked',
    },
    {
      type: 'job-rerun',
      label: 'Jobs neu ausführen',
      description: 'Erneut starten.',
      effect: 'z',
      state: 'locked',
      lockedBy: 'opt-in',
      optIn: true,
    },
    {
      type: 'job-delete',
      label: 'Fehlgeschlagene Jobs löschen',
      description: 'Löschen.',
      effect: 'w',
      state: 'off',
      optIn: false,
    },
  ],
  notifications: 'off',
};

describe('settings sections', () => {
  it('groups modules and explains each state', () => {
    const s = settingsSections(view, de);
    expect(s.map((x) => x.title)).toEqual([
      'Kubernetes',
      'Erkannte Komponenten',
      'Aktionen',
      'Ausgeschaltete Aktionen',
      'Im Helm-Chart gesperrte Aktionen',
      'Benachrichtigungen',
      'Nicht gefunden',
    ]);
    const argo = s[1]!.rows.find((r) => r.title === 'Argo CD')!;
    expect(argo).toMatchObject({ on: false, locked: false });
    expect(argo.patch(true)).toEqual({ modules: { argocd: true } });
    expect(s[1]!.rows.find((r) => r.title === 'Weblate')!.note).toBe(
      'Übersetzungen. Geprüft werden nur die Pods.',
    );
    expect(s[2]!.rows.map((r) => r.title)).toEqual(['Logs lesen']);
    expect(s[3]!.rows[0]).toMatchObject({
      title: 'Fehlgeschlagene Jobs löschen',
      on: false,
      locked: false,
    });
    expect(s[3]!.rows[0]!.helm).toBeUndefined();
    expect(s[3]!.rows[0]!.patch(true)).toEqual({ actions: { 'job-delete': true } });
    const [restart, rerun] = s[4]!.rows;
    expect(restart).toMatchObject({ locked: true, helm: 'actions.disabled: [restart]' });
    expect(restart!.note).toContain('In den Helm-Values steht actions.disabled: [restart]');
    expect(rerun).toMatchObject({ locked: true, helm: 'actions.enabled: [job-rerun]' });
    expect(rerun!.note).toBe(
      'Erneut starten. Sie ist standardmäßig aus, weil ihr Recht weiter reicht als die Aktion selbst, falls der Agent je kompromittiert würde. Zum Freischalten actions.enabled: [job-rerun] in die Helm-Values (oder ENABLED_ACTIONS) eintragen und upgraden.',
    );
    expect(s[5]!.rows[0]!.patch(true)).toEqual({ notifications: true });
    expect(s[6]!.rows[0]).toMatchObject({ title: 'Velero', locked: true });
  });

  it('shows what a default-off module would send out of the cluster', () => {
    const privacy =
      'Schickt Namen und Versionen der Komponenten an api.osv.dev (Google). Keine Clusterdaten, keine Namen von Workloads.';
    const s = settingsSections(
      {
        ...view,
        modules: [
          ...view.modules,
          {
            id: 'vulnerabilities',
            name: 'Bekannte Schwachstellen',
            icon: 'bug-outline',
            category: 'core',
            description: 'Gleicht Versionen ab.',
            deep: true,
            detected: true,
            state: 'off',
            defaultOff: true,
            privacy,
          },
        ],
      },
      de,
    );
    const row = s[0]!.rows.find((r) => r.title === 'Bekannte Schwachstellen')!;
    expect(row).toMatchObject({ on: false, locked: false, note: 'Gleicht Versionen ab.', privacy });
    expect(row.patch(true)).toEqual({ modules: { vulnerabilities: true } });
    expect(s[0]!.rows.find((r) => r.title === 'Nodes')!.privacy).toBeUndefined();
  });

  it('explains the states in English too', () => {
    const s = settingsSections(view, translatorFor('en'));
    expect(s.map((x) => x.title)).toEqual([
      'Kubernetes',
      'Detected components',
      'Actions',
      'Actions switched off',
      'Actions locked in the deployment',
      'Notifications',
      'Not found',
    ]);
    expect(s[1]!.rows.find((r) => r.title === 'Weblate')!.note).toBe(
      'Übersetzungen. Only its pods are checked.',
    );
    expect(s[4]!.rows[1]!.note).toContain('add actions.enabled: [job-rerun] to the Helm values');
  });

  it("says under each action what it may change, in the agent's words", () => {
    const effect =
      'Darf am betroffenen Workload die Annotation restartedAt setzen, wie kubectl rollout restart.';
    const s = settingsSections(
      {
        ...view,
        actions: [
          {
            type: 'restart',
            label: 'Workloads neu starten',
            description: 'x',
            effect,
            state: 'on',
          },
        ],
      },
      de,
    );
    expect(s[2]!.rows[0]).toMatchObject({ effect, on: true });
  });

  it('leaves out the "not found" section when everything is in the cluster', () => {
    expect(
      settingsSections({ ...view, modules: view.modules.slice(0, 3) }, de).map((x) => x.title),
    ).not.toContain('Nicht gefunden');
  });
});
