import { ActionType, OPT_IN_ACTIONS } from '../checks/types';
import { CATALOG } from '../discovery/catalog';
import { CORE_CHECKS } from '../modules/core';
import { INTEGRATIONS } from '../modules/integrations';

export interface Rule {
  group: string;
  resources: string[];
  verbs: string[];
}

/**
 * What each action type needs beyond reading. The chart grants a line only
 * while the action is enabled (`actions.disabled`, `rbac.allowActions`).
 */
export const ACTION_PERMISSIONS: Record<ActionType, Rule[]> = {
  restart: [{ group: 'apps', resources: ['deployments', 'statefulsets', 'daemonsets'], verbs: ['patch'] }],
  'argocd-sync': [{ group: 'argoproj.io', resources: ['applications'], verbs: ['patch'] }],
  'argocd-refresh': [{ group: 'argoproj.io', resources: ['applications'], verbs: ['patch'] }],
  // The same verb as a sync: what a rollback adds is a branch of the admission policy, not RBAC.
  'argocd-rollback': [{ group: 'argoproj.io', resources: ['applications'], verbs: ['patch'] }],
  'cnpg-backup': [{ group: 'postgresql.cnpg.io', resources: ['backups'], verbs: ['create'] }],
  logs: [{ group: '', resources: ['pods/log'], verbs: ['get'] }],
};

/** "notifications" is not a module but switches every channel off (checks.disabled). */
export const NOTIFICATIONS_ID = 'notifications';

/** Every id `checks.disabled` (DISABLED_MODULES) and ENABLED_MODULES may name; custom components add `custom:<id>`. */
export function knownModuleIds(): string[] {
  return [...new Set([...CORE_CHECKS.map((c) => c.id), ...CATALOG.map((e) => e.id), NOTIFICATIONS_ID])].sort();
}

/** Action types that change the cluster: `rbac.allowActions: false` switches all of them off. */
export const WRITE_ACTIONS: ActionType[] = ['restart', 'argocd-sync', 'argocd-refresh', 'argocd-rollback', 'cnpg-backup'];

/**
 * deploy/helm/kubernanny/files/rbac.json, generated from the modules'
 * declarations (`npm run rbac`). The chart's ClusterRole grants
 *
 * - a module's reads only while the module is not in `checks.disabled`;
 * - a permission an action needs only while that action is enabled AND at
 *   least one module offering it is not in `checks.disabled`. Two actions
 *   needing the same permission (argocd-sync and argocd-refresh both patch
 *   Applications) keep it while either is enabled: to drop it, disable both
 *   or the module.
 */
export interface ActionGrant {
  /** Modules whose issues offer this action. Its rules are granted only while one of them is switched on. */
  modules: string[];
  rules: Rule[];
}

/**
 * `knownModules` and `actionTypes` let the chart refuse a typo in
 * `checks.disabled` / `actions.disabled` with `fail` instead of rendering a
 * switch that switches nothing off. `optInActions` are granted only while
 * named in `actions.enabled`.
 */
export function rbacExport(): {
  modules: Record<string, Rule[]>;
  actions: Record<string, ActionGrant>;
  writeActions: string[];
  knownModules: string[];
  actionTypes: string[];
  optInActions: string[];
} {
  const modules: Record<string, Rule[]> = {};
  for (const m of [...CORE_CHECKS, ...INTEGRATIONS]) {
    if (m.reads.length === 0) {
      continue;
    }
    const byGroup = new Map<string, string[]>();
    for (const r of m.reads) {
      byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r.resource]);
    }
    modules[m.id] = [...byGroup].map(([group, resources]) => ({ group, resources, verbs: ['get', 'list'] }));
  }
  const all = [...CORE_CHECKS, ...INTEGRATIONS];
  const actions = Object.fromEntries(
    (Object.keys(ACTION_PERMISSIONS) as ActionType[]).map((type) => [
      type,
      { modules: all.filter((m) => m.actions.includes(type)).map((m) => m.id).sort(), rules: ACTION_PERMISSIONS[type] },
    ]),
  );
  return { modules: sortKeys(modules), actions: sortKeys(actions), writeActions: WRITE_ACTIONS, knownModules: knownModuleIds(), actionTypes: Object.keys(ACTION_PERMISSIONS).sort(), optInActions: [...OPT_IN_ACTIONS].sort() };
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}
