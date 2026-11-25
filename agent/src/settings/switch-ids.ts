import type { IssueActionType } from '../checks/types';
import type { Config } from '../config';
import { ACTION_PERMISSIONS, knownModuleIds } from '../rbac/rules';

export const ACTION_TYPE_IDS = Object.keys(ACTION_PERMISSIONS) as IssueActionType[];

/**
 * Fails the start on an id no module or action has. A hard switch that names
 * `prometeus` would otherwise leave Prometheus running while the person who
 * set it believes it off.
 */
export function checkSwitchIds(config: Config): Config {
  const modules = new Set([...knownModuleIds(), ...config.customComponents.map((c) => c.id)]);
  for (const [name, ids] of [
    ['DISABLED_MODULES (checks.disabled)', config.disabledModules],
    ['ENABLED_MODULES', config.enabledModules],
  ] as const) {
    const unknown = ids.filter((id) => !modules.has(id));
    if (unknown.length > 0) {
      throw new Error(`${name} names unknown modules: ${unknown.join(', ')}. Known: ${[...modules].join(', ')}`);
    }
  }
  const unknownActions = config.disabledActions.filter((type) => !(ACTION_TYPE_IDS as string[]).includes(type));
  if (unknownActions.length > 0) {
    throw new Error(`DISABLED_ACTIONS (actions.disabled) names unknown action types: ${unknownActions.join(', ')}. Known: ${ACTION_TYPE_IDS.join(', ')}`);
  }
  return config;
}
