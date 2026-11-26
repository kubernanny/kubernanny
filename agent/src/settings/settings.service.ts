import type { Principal } from '../auth/devices.service';
import { ActionType, OPT_IN_ACTIONS } from '../checks/types';
import type { Config } from '../config';
import { DemoKubeClient } from '../demo/demo-cluster';
import { CATALOG, CatalogEntry, Category } from '../discovery/catalog';
import { customEntries } from '../discovery/discovery';
import { BadRequestError, ForbiddenError } from '../http/errors';
import { raw, t, Text } from '../i18n/text';
import { upsertConfigMapData } from '../kube/configmap';
import { KubeClient } from '../kube/kube-client';
import { Logger } from '../logger';
import { CORE_CHECKS } from '../modules/core';
import { INTEGRATIONS } from '../modules/integrations';
import { Notifier, SecurityEvent } from '../notify/notifier';
import { Serial } from '../util/serial';
import { NotLoadedError, readAtStartup } from '../util/startup-read';

export const SETTINGS_CONFIGMAP = 'kubernanny-settings';

/** Modules that stay off until someone switches them on: those sending data out of the cluster. */
const DEFAULT_OFF: ReadonlySet<string> = new Set(CORE_CHECKS.filter((c) => c.defaultOff).map((c) => c.id));

const action = (type: ActionType, write: boolean) => ({
  type,
  label: t(`action.${type}.label`),
  description: t(`action.${type}.description`),
  effect: t(`action.${type}.effect`),
  write,
});

/** `effect`: what the action may change in the cluster, in one line (docs/PERMISSIONS.md has the details). */
export const ACTION_TYPES: readonly {
  type: ActionType;
  label: Text;
  description: Text;
  effect: Text;
  write: boolean;
}[] = [
  action('restart', true),
  action('argocd-sync', true),
  action('argocd-sync-prune', true),
  action('argocd-sync-replace', true),
  action('argocd-refresh', true),
  action('argocd-rollback', true),
  action('cnpg-backup', true),
  action('longhorn-backup', true),
  action('velero-backup', true),
  action('reconcile-now', true),
  action('uncordon', true),
  action('cleanup-pods', true),
  action('job-rerun', true),
  action('force-delete-terminating', true),
  action('argocd-terminate-op', true),
  action('pvc-expand', true),
  action('config-change-hint', false),
  action('logs', false),
];

/** on: runs. off: switched off in the app. locked: switched off in the deployment (Helm values), the app cannot change it. */
export type ToggleState = 'on' | 'off' | 'locked';

export interface ModuleSetting {
  id: string;
  name: Text;
  icon: string;
  category: Category | 'core';
  /** One sentence: what the module looks at. */
  description: Text;
  /** An integration with a deep check (reads its own resources) rather than only its pods. */
  deep: boolean;
  /** Found in the cluster in the last run (always true for core checks). */
  detected: boolean;
  state: ToggleState;
  /** Off until switched on, because it sends data out of the cluster. */
  defaultOff?: boolean;
  /** What it sends where, shown next to the switch. */
  privacy?: Text;
}

export interface SettingsView {
  modules: ModuleSetting[];
  actions: { type: ActionType; label: Text; description: Text; effect: Text; state: ToggleState }[];
  notifications: ToggleState;
}

export interface SettingsPatch {
  modules?: Record<string, boolean>;
  actions?: Record<string, boolean>;
  notifications?: boolean;
}

interface Stored {
  disabledModules: string[];
  /** Modules that are off by default (`defaultOff`), switched on in the app. */
  enabledModules: string[];
  disabledActions: string[];
  notificationsPaused: boolean;
}

/**
 * What runs, in two layers:
 *
 * 1. **The deployment** (Helm values `checks.disabled`, `actions.disabled`,
 *    `actions.enabled`, `rbac.allowActions`; env `DISABLED_MODULES`,
 *    `DISABLED_ACTIONS`, `ENABLED_ACTIONS`). This is
 *    the security boundary: the chart also drops the RBAC rules of a
 *    disabled module, so the agent could not read it even if asked.
 * 2. **The app**, within those limits: any paired device can switch modules,
 *    action types and notifications off and on again. Stored in the
 *    ConfigMap `kubernanny-settings`, so it survives restarts. Every change
 *    is in the audit log with the device, and switching anything off, or a
 *    module on that sends data out of the cluster, is announced through the
 *    notification channels first (Notifier.securityAlert).
 */
export class SettingsService {
  private readonly logger = new Logger('audit');
  private stored: Stored = { disabledModules: [], enabledModules: [], disabledActions: [], notificationsPaused: false };
  /**
   * True once the ConfigMap was read (or found missing). Until then every
   * action is off and nothing is written: an owner's "off" must not come
   * back on because the API server hiccuped at start-up.
   */
  private loaded = false;
  private listeners: (() => void)[] = [];
  private readonly writes = new Serial();

  constructor(
    private readonly config: Config,
    private readonly kube: KubeClient,
    /** Announces switches turned off; absent in unit tests that do not care. */
    private readonly notifier?: Notifier,
  ) {}

  private get path(): string {
    return `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}/configmaps`;
  }

  /** Reads the stored switches, retrying transient errors; throws when they stay unreadable, so the process ends and restarts. */
  async onModuleInit(delaysMs?: readonly number[]): Promise<void> {
    const log = new Logger(SettingsService.name);
    const cm = await readAtStartup(
      `ConfigMap ${SETTINGS_CONFIGMAP}`,
      () => this.kube.get<{ data?: { settings?: string } }>(`${this.path}/${SETTINGS_CONFIGMAP}`),
      {
        onRetry: (err, attempt) =>
          log.warn(
            `cannot read ConfigMap ${SETTINGS_CONFIGMAP} (${err instanceof Error ? err.message : err}), attempt ${attempt}; retrying`,
          ),
        ...(delaysMs ? { delaysMs } : {}),
      },
    );
    this.stored = parseStored(cm?.data?.settings);
    this.loaded = true;
  }
  /**
   * Reads it again once, throwing on any failure but 404 and keeping nothing
   * old: a pod taking over the lease, or answering next to the pod in charge
   * during a rolling update, must not act on state the other pod changed
   * (a revoked device, an action switched off). See agent.ts.
   */
  reload(): Promise<void> {
    return this.onModuleInit([]);
  }

  /** Called after every change, e.g. to start a new run. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  moduleState(id: string, stored: Stored = this.stored): ToggleState {
    if (this.config.disabledModules.includes(id)) {
      return 'locked';
    }
    if (stored.disabledModules.includes(id)) {
      return 'off';
    }
    if (DEFAULT_OFF.has(id)) {
      // On when the app switched it on, or the deployment did (Helm, ENABLED_MODULES). The demo shows everything.
      return stored.enabledModules.includes(id) ||
        this.config.enabledModules.includes(id) ||
        this.kube instanceof DemoKubeClient
        ? 'on'
        : 'off';
    }
    return 'on';
  }

  moduleOn(id: string): boolean {
    return this.moduleState(id) === 'on';
  }

  actionState(type: ActionType): ToggleState {
    if (this.config.disabledActions.includes(type)) {
      return 'locked';
    }
    // Opt-in types (argocd-rollback) stay locked until the deployment names them; the demo shows them.
    if (OPT_IN_ACTIONS.includes(type) && !(this.config.enabledActions ?? []).includes(type) && !this.config.demo) {
      return 'locked';
    }
    // Not read yet: whatever the owner switched off may be among them.
    if (!this.loaded) {
      return 'off';
    }
    return this.stored.disabledActions.includes(type) ? 'off' : 'on';
  }

  actionOn = (type: ActionType): boolean => this.actionState(type) === 'on';

  notificationsOn(): boolean {
    return !this.stored.notificationsPaused && !this.config.disabledModules.includes('notifications');
  }

  /** Every module the app can show a switch for: core checks, every integration, and recognised components. */
  view(detectedIds: readonly string[]): SettingsView {
    const detected = new Set(detectedIds);
    const ids = [
      ...new Set([
        ...INTEGRATIONS.map((i) => i.id),
        ...detectedIds,
        ...this.stored.disabledModules.filter((id) => !id.startsWith('custom:')),
        ...this.config.disabledModules,
      ]),
    ];
    const entries = [...CATALOG, ...customEntries(this.config.customComponents)];
    const components = ids
      .map((id) => entries.find((e) => e.id === id))
      .filter((entry) => entry !== undefined)
      // Detected first, then by name; locale-independent, so the order is the same in every language.
      .sort((a, b) => Number(detected.has(b.id)) - Number(detected.has(a.id)) || a.name.localeCompare(b.name, 'en'))
      .map((entry) => this.componentModuleSetting(entry, detected.has(entry.id)));
    return {
      modules: [...CORE_CHECKS.map((c) => this.coreModuleSetting(c)), ...components],
      actions: ACTION_TYPES.map((a) => ({
        type: a.type,
        label: a.label,
        description: a.description,
        effect: a.effect,
        state: this.actionState(a.type),
      })),
      notifications: this.config.disabledModules.includes('notifications')
        ? 'locked'
        : this.stored.notificationsPaused
          ? 'off'
          : 'on',
    };
  }

  private coreModuleSetting(c: (typeof CORE_CHECKS)[number]): ModuleSetting {
    const privacy = c.privacy(this.config);
    return {
      id: c.id,
      name: c.name,
      icon: c.icon,
      category: 'core',
      description: c.description,
      deep: true,
      detected: true,
      state: this.moduleState(c.id),
      ...(c.defaultOff ? { defaultOff: true } : {}),
      ...(privacy ? { privacy } : {}),
    };
  }

  private componentModuleSetting(entry: CatalogEntry, detected: boolean): ModuleSetting {
    return {
      id: entry.id,
      name: raw(entry.name),
      icon: entry.icon,
      category: entry.category,
      description: entry.description,
      deep: INTEGRATIONS.some((i) => i.id === entry.id),
      detected,
      state: this.moduleState(entry.id),
    };
  }

  /** One change at a time: each starts from what the one before it stored. */
  update(patch: SettingsPatch, who: Principal): Promise<void> {
    return this.writes.run(() => this.apply(patch, who));
  }

  private async apply(patch: SettingsPatch, who: Principal): Promise<void> {
    const next: Stored = {
      disabledModules: [...this.stored.disabledModules],
      enabledModules: [...this.stored.enabledModules],
      disabledActions: [...this.stored.disabledActions],
      notificationsPaused: this.stored.notificationsPaused,
    };
    const known = new Set([
      ...CORE_CHECKS.map((c) => c.id),
      ...CATALOG.map((e) => e.id),
      ...this.config.customComponents.map((c) => c.id),
    ]);
    for (const [id, on] of Object.entries(patch.modules ?? {})) {
      if (!known.has(id) || typeof on !== 'boolean') {
        throw new BadRequestError({ code: 'SETTING_UNKNOWN', message: t('error.moduleUnknown', { id }) });
      }
      if (this.config.disabledModules.includes(id)) {
        throw new ForbiddenError({ code: 'SETTING_LOCKED', message: t('error.settingLocked', { id }) });
      }
      next.disabledModules = toggle(next.disabledModules, id, !on);
      // Remembered both ways for default-off modules, so an install that switches it on in Helm still respects the app's "off".
      next.enabledModules = toggle(next.enabledModules, id, on && DEFAULT_OFF.has(id));
    }
    for (const [type, on] of Object.entries(patch.actions ?? {})) {
      if (!ACTION_TYPES.some((a) => a.type === type) || typeof on !== 'boolean') {
        throw new BadRequestError({ code: 'SETTING_UNKNOWN', message: t('error.actionUnknown', { type }) });
      }
      if (this.actionState(type as ActionType) === 'locked') {
        throw new ForbiddenError({ code: 'SETTING_LOCKED', message: t('error.settingLocked', { id: type }) });
      }
      next.disabledActions = toggle(next.disabledActions, type, !on);
    }
    if (patch.notifications !== undefined) {
      if (typeof patch.notifications !== 'boolean') {
        throw new BadRequestError({ code: 'SETTING_UNKNOWN', message: t('error.notificationsBoolean') });
      }
      next.notificationsPaused = !patch.notifications;
    }
    if (!this.loaded) {
      throw new NotLoadedError('settings');
    }
    // Before the change: once notifications are off, this would be the last message anyway.
    await this.notifier?.securityAlert(who.name, this.securityEvents(next));
    await this.save(next);
    this.logger.log(`settings changed by "${who.name}" (${who.id}): ${JSON.stringify(patch)}`);
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * What `next` changes that a stolen device key would use: everything it
   * switches off that runs now (to go unnoticed), and every default-off
   * module it switches on (those send data out of the cluster).
   */
  private securityEvents(next: Stored): SecurityEvent[] {
    const events: SecurityEvent[] = [];
    if (next.notificationsPaused && this.notificationsOn()) {
      events.push({ kind: 'notificationsOff' });
    }
    for (const id of next.disabledModules.filter((id) => !this.stored.disabledModules.includes(id))) {
      if (this.moduleOn(id)) {
        events.push({ kind: 'moduleOff', id });
      }
    }
    for (const id of DEFAULT_OFF) {
      if (!this.moduleOn(id) && this.moduleState(id, next) === 'on') {
        events.push({ kind: 'moduleOn', id });
      }
    }
    for (const type of next.disabledActions.filter((type) => !this.stored.disabledActions.includes(type))) {
      if (this.actionOn(type as ActionType)) {
        events.push({ kind: 'actionOff', id: type });
      }
    }
    return events;
  }

  private async save(next: Stored): Promise<void> {
    await upsertConfigMapData(this.kube, this.config.namespace, SETTINGS_CONFIGMAP, { settings: JSON.stringify(next) });
    this.stored = next;
  }
}

function toggle(list: string[], id: string, present: boolean): string[] {
  const without = list.filter((x) => x !== id);
  return present ? [...without, id] : without;
}

function parseStored(text: string | undefined): Stored {
  try {
    const raw = JSON.parse(text ?? '{}') as Partial<Stored>;
    const strings = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 500) : [];
    return {
      disabledModules: strings(raw.disabledModules),
      enabledModules: strings(raw.enabledModules),
      disabledActions: strings(raw.disabledActions),
      notificationsPaused: raw.notificationsPaused === true,
    };
  } catch {
    return { disabledModules: [], enabledModules: [], disabledActions: [], notificationsPaused: false };
  }
}
