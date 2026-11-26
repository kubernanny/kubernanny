import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { parseAllDocuments } from 'yaml';

import { CORE_CHECKS } from './modules/core';
import { INTEGRATIONS } from './modules/integrations';
import { rbacExport } from './rbac/rules';

const RBAC_JSON = join(__dirname, '../../deploy/helm/kubernanny/files/rbac.json');
if (process.env['UPDATE_RBAC']) {
  writeFileSync(RBAC_JSON, JSON.stringify(rbacExport(), null, 2) + '\n');
}

/** Every "/apis/<group>/<version>/<resource>" and "/api/v1/<resource>" the agent reads, from its source. */
function calledResources(): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== 'demo') {
          walk(path);
        }
      } else if (name.endsWith('.ts') && !name.endsWith('.spec.ts')) {
        // Gatus' own API (`/api/v1/endpoints/statuses`) looks like the core `endpoints` resource; it is plain HTTP to Gatus.
        const text = readFileSync(path, 'utf8').replaceAll("'/api/v1/endpoints/statuses'", '');
        for (const m of text.matchAll(
          /['`]\/apis\/([a-z0-9.-]+)\/v[0-9a-z]+\/(?:namespaces\/\$\{[^}]+\}\/)?([a-z]+)/g,
        )) {
          // A resource chosen at runtime (`…/namespaces/${ns}/${kind}`) shows up as "namespaces"; the workload kinds are asserted below.
          if (m[2] !== 'namespaces') {
            found.add(`${m[1]}/${m[2]}`);
          }
        }
        for (const m of text.matchAll(/['`]\/api\/v1\/(?:namespaces\/[^/'`]+\/)?([a-z]+)[?/'`]/g)) {
          // Prometheus and Alertmanager paths look like core API paths.
          if (
            !['query', 'alerts', 'silences', 'targets'].includes(m[1]) &&
            (m[1] !== 'namespaces' || /\/api\/v1\/namespaces['`?]/.test(m[0]))
          ) {
            found.add(`/${m[1]}`);
          }
        }
      }
    }
  };
  walk(join(__dirname));
  return found;
}

function granted(file: string): Set<string> {
  const docs = parseAllDocuments(readFileSync(file, 'utf8')).map((d) => d.toJS());
  const out = new Set<string>();
  for (const doc of docs) {
    if (doc?.kind !== 'ClusterRole' && doc?.kind !== 'Role') {
      continue;
    }
    for (const rule of doc.rules as { apiGroups: string[]; resources: string[] }[]) {
      for (const g of rule.apiGroups) {
        for (const r of rule.resources) {
          out.add(`${g}/${r}`);
        }
      }
    }
  }
  return out;
}

/**
 * The chart's ClusterRole with every module and action on: the static rules of
 * the template plus everything in files/rbac.json. (Helm itself renders it in
 * CI; this keeps the test free of a Helm binary.)
 */
function chartRules(): Set<string> {
  const raw = readFileSync(join(__dirname, '../../deploy/helm/kubernanny/templates/rbac.yaml'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\{\{-?/.test(l))
    .join('\n')
    .replace(/\{\{[^}]*\}\}/g, 'x');
  const out = new Set<string>();
  for (const doc of parseAllDocuments(raw).map((d) => d.toJS())) {
    if (doc?.kind !== 'ClusterRole') {
      continue;
    }
    for (const rule of (doc.rules ?? []) as { apiGroups: string[]; resources: string[] }[]) {
      for (const g of rule.apiGroups) {
        for (const r of rule.resources) {
          // Lines filled from files/rbac.json by the range loops; added below from the file itself.
          if (g !== 'x') {
            out.add(`${g}/${r}`);
          }
        }
      }
    }
  }
  const generated = JSON.parse(readFileSync(RBAC_JSON, 'utf8')) as ReturnType<typeof rbacExport>;
  for (const rules of [...Object.values(generated.modules), ...Object.values(generated.actions).map((a) => a.rules)]) {
    for (const rule of rules) {
      for (const r of rule.resources) {
        out.add(`${rule.group}/${r}`);
      }
    }
  }
  return out;
}

describe('declared reads of the modules', () => {
  it('are what files/rbac.json in the chart says (run `npm run rbac` after adding an integration)', () => {
    expect(JSON.parse(readFileSync(RBAC_JSON, 'utf8'))).toEqual(JSON.parse(JSON.stringify(rbacExport())));
  });

  it('are granted by install.yaml and by the Helm chart', () => {
    const declared = [...INTEGRATIONS.flatMap((i) => i.reads), ...CORE_CHECKS.flatMap((m) => m.reads)].map(
      (r) => `${r.group}/${r.resource}`,
    );
    expect(declared.length).toBeGreaterThan(10);
    const install = granted(join(__dirname, '../../deploy/install.yaml'));
    const chart = chartRules();
    expect(declared.filter((r) => !install.has(r))).toEqual([]);
    expect(declared.filter((r) => !chart.has(r))).toEqual([]);
  });

  it('keeps the chart (everything on) and install.yaml granting the same in the ClusterRole', () => {
    const install = clusterRoleOnly(join(__dirname, '../../deploy/install.yaml'));
    const chart = chartRules();
    expect([...install].filter((r) => !chart.has(r))).toEqual([]);
    // install.yaml has the chart's defaults: a resource only an opt-in action touches is not in it.
    const generated = rbacExport();
    const optInOnly = new Set(
      generated.optInActions
        .flatMap((type) => generated.actions[type]!.rules.flatMap((r) => r.resources.map((x) => `${r.group}/${x}`)))
        .filter((r) => !install.has(r)),
    );
    expect([...optInOnly]).toEqual(['/configmaps']);
    expect([...chart].filter((r) => !install.has(r) && !optInOnly.has(r))).toEqual([]);
  });

  it('gives every action type a permission line, and only the declared modules offer it', () => {
    const generated = rbacExport();
    expect(Object.keys(generated.actions).sort()).toEqual([
      'argocd-refresh',
      'argocd-rollback',
      'argocd-sync',
      'argocd-terminate-op',
      'cleanup-pods',
      'cnpg-backup',
      'config-change-hint',
      'force-delete-terminating',
      'job-rerun',
      'logs',
      'longhorn-backup',
      'pvc-expand',
      'reconcile-now',
      'restart',
      'uncordon',
      'velero-backup',
    ]);
    // The rollback shares the sync's verb; what it adds is an admission branch, and only on opt-in.
    expect(generated.actions['argocd-rollback']!.rules).toEqual(generated.actions['argocd-sync']!.rules);
    expect(generated.optInActions).toEqual([
      'argocd-rollback',
      'argocd-terminate-op',
      'config-change-hint',
      'force-delete-terminating',
      'job-rerun',
      'pvc-expand',
    ]);
    // The restart itself reads nothing beyond the inventory: ConfigMaps only with the opt-in hint.
    expect(generated.actions['restart']!.rules.flatMap((r) => r.resources)).toEqual([
      'deployments',
      'statefulsets',
      'daemonsets',
    ]);
    expect(generated.actions['config-change-hint']).toEqual({
      modules: ['pods'],
      rules: [{ group: '', resources: ['configmaps'], verbs: ['get'] }],
    });
    expect(generated.actions['argocd-terminate-op']!.rules).toEqual(generated.actions['argocd-sync']!.rules);
    expect(generated.actions['uncordon']!.modules).toEqual(['nodes']);
    expect(generated.actions['reconcile-now']!.modules).toEqual([
      'cert-manager',
      'external-secrets',
      'flux',
      'infisical',
    ]);
    expect(generated.actions['pvc-expand']!.modules).toEqual(['volumes']);
    expect(generated.actions['longhorn-backup']!.modules).toEqual(['longhorn']);
    expect(generated.actions['velero-backup']!.modules).toEqual(['velero']);
    expect(generated.actions['job-rerun']!.modules).toEqual(['pods']);
    expect(INTEGRATIONS.find((i) => i.id === 'argocd')!.actions).toContain('argocd-sync');
    // An action's permission is tied to the modules offering it: switching off Argo CD also drops its patch.
    expect(generated.actions['argocd-sync']!.modules).toEqual(['argocd']);
    expect(generated.actions['cnpg-backup']!.modules).toEqual(['cnpg']);
    expect(generated.actions['restart']!.modules).toEqual(['argocd', 'pods']);
    for (const [type, grant] of Object.entries(generated.actions)) {
      expect(grant.modules.length, `${type} is offered by no module`).toBeGreaterThan(0);
    }
    expect(INTEGRATIONS.filter((i) => i.untrusted).flatMap((i) => i.actions)).toEqual([]);
  });
});

function clusterRoleOnly(file: string): Set<string> {
  const out = new Set<string>();
  for (const doc of parseAllDocuments(readFileSync(file, 'utf8')).map((d) => d.toJS())) {
    if (doc?.kind !== 'ClusterRole') {
      continue;
    }
    for (const rule of doc.rules as { apiGroups: string[]; resources: string[] }[]) {
      for (const g of rule.apiGroups) {
        for (const r of rule.resources) {
          out.add(`${g}/${r}`);
        }
      }
    }
  }
  return out;
}

describe('RBAC of the install manifest', () => {
  it('grants every resource the agent reads, so no check fails with 403 in a real cluster', () => {
    const rules = granted(join(__dirname, '../../deploy/install.yaml'));
    const missing = [...calledResources()].filter((r) => !rules.has(r) && !rules.has(r.replace(/^\//, '/')));
    expect(missing).toEqual([]);
  });

  it('lets the agent touch only its own two Secrets and its settings and history ConfigMaps by name, and nothing else in its namespace', () => {
    const docs = parseAllDocuments(readFileSync(join(__dirname, '../../deploy/install.yaml'), 'utf8')).map((d) =>
      d.toJS(),
    );
    const role = docs.find((d) => d?.kind === 'Role');
    const secretRules = (role.rules as { resources: string[]; verbs: string[]; resourceNames?: string[] }[]).filter(
      (r) => r.resources.includes('secrets'),
    );
    for (const rule of secretRules) {
      if (rule.verbs.some((v) => v !== 'create')) {
        expect(rule.resourceNames).toBeDefined();
        expect(rule.resourceNames!.every((n) => ['kubernanny-identity', 'kubernanny-devices'].includes(n))).toBe(true);
      }
    }
    expect(secretRules.flatMap((r) => r.verbs)).not.toContain('list');
    const configMapRules = (role.rules as { resources: string[]; verbs: string[]; resourceNames?: string[] }[]).filter(
      (r) => r.resources.includes('configmaps') && r.verbs.some((v) => v !== 'create'),
    );
    expect(configMapRules.flatMap((r) => r.resourceNames ?? ['*'])).toEqual([
      'kubernanny-settings',
      'kubernanny-history',
    ]);
    // The history ConfigMap comes with the manifest (created empty), so the agent never needs to create it.
    expect(configMapRules.flatMap((r) => r.verbs)).not.toContain('update');
    expect(
      docs.find((d) => d?.kind === 'ConfigMap' && d.metadata?.name === 'kubernanny-history')?.data,
    ).toBeUndefined();
    expect(docs.some((d) => d?.kind === 'ConfigMap' && d.metadata?.name === 'kubernanny-history')).toBe(true);
    expect(secretRules.flatMap((r) => r.verbs)).not.toContain('delete');
    const clusterRole = docs.find((d) => d?.kind === 'ClusterRole');
    // No cluster-wide access to core Secrets (CRDs named *secrets* are fine).
    const coreSecrets = (clusterRole.rules as { apiGroups: string[]; resources: string[] }[]).filter(
      (r) => r.apiGroups.includes('') && r.resources.includes('secrets'),
    );
    expect(coreSecrets).toEqual([]);
  });

  it('allows the actions: patching workloads and Argo apps, creating CNPG backups and its own Secrets', () => {
    const rules = granted(join(__dirname, '../../deploy/install.yaml'));
    // The agent reaches services over cluster DNS; a services/proxy grant would reach every internal service.
    expect(rules.has('/services/proxy')).toBe(false);
    for (const r of [
      'apps/deployments',
      'apps/statefulsets',
      'apps/daemonsets',
      'argoproj.io/applications',
      'postgresql.cnpg.io/backups',
      '/secrets',
      '/pods/log',
    ]) {
      expect(rules.has(r), r).toBe(true);
    }
  });
});
