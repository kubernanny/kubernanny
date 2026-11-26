import { DEFAULT_LANG, Lang, resolveLang } from './i18n/text';
import { checkRelayUrl } from './relay/relay-url';
import { isInClusterHost } from './security/in-cluster-host';
import type { DemoScenario } from './demo/demo-cluster';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}"`);
  }
  return value;
}

/** A whole number in `min..max` (0 allowed where the range starts there, e.g. DIGEST_WEEKDAY=0 for Sunday). */
export function int(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined || raw.trim() === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}

/**
 * A switch: on, true, 1 or off, false, 0 (any case); unset or empty is the
 * default. Anything else stops the start: a typo in a switch that takes
 * something away must never leave it in place.
 */
export function parseSwitch(name: string, raw: string | undefined, fallback: boolean): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') {
    return fallback;
  }
  if (['on', 'true', '1'].includes(value)) {
    return true;
  }
  if (['off', 'false', '0'].includes(value)) {
    return false;
  }
  throw new Error(`${name} must be on or off (also true/false, 1/0), got "${raw}"`);
}

/** One of `allowed`; unset or empty is `fallback`; anything else stops the start. */
export function parseChoice<T extends string>(name: string, raw: string | undefined, allowed: readonly T[], fallback: T): T {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') {
    return fallback;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${raw}"`);
  }
  return value as T;
}

/** DIGEST: unset, empty or off for none, weekly for the weekly report. */
export function parseDigest(env: NodeJS.ProcessEnv): { weekday: number; hour: number } | null {
  if (parseChoice('DIGEST', env.DIGEST, ['off', 'weekly'], 'off') === 'off') {
    return null;
  }
  return { weekday: int('DIGEST_WEEKDAY', env.DIGEST_WEEKDAY, 1, 0, 6), hour: int('DIGEST_HOUR', env.DIGEST_HOUR, 9, 0, 23) };
}

function list(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
}

/**
 * Notifications leave the cluster: HTTPS, or plain HTTP only to a service
 * inside it (self-hosted ntfy as `http://ntfy.ntfy.svc`).
 */
export function checkNotifyUrl(name: string, raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} is not a URL`);
  }
  const internal = isInClusterHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && internal)) {
    throw new Error(`${name} must use https (plain http only for in-cluster *.svc hosts)`);
  }
  return raw;
}

/**
 * LANGUAGE: `en` (default) or `de`. glibc reads the same variable as a list
 * like `de_DE:en`, so a value in that form counts by its first entry; anything
 * else unknown falls back to English rather than stopping the start.
 */
export function parseLanguage(raw: string | undefined): Lang {
  const first = (raw ?? '').trim().toLowerCase().split(':')[0]!.split(/[_.@-]/)[0];
  return resolveLang(first, DEFAULT_LANG);
}

/**
 * DEMO: unset, '', '0', 'false' or 'off' is a real cluster; 'broken',
 * 'warning' or 'healthy' picks a demo scenario, '1' or 'true' the default
 * one. Anything else stops the start: a typo must never open the agent to
 * every device (DEMO lets any key in) nor quietly run a real one as a demo.
 */
export function parseDemo(raw: string | undefined): DemoScenario | null {
  const value = (raw ?? '').trim().toLowerCase();
  if (['', '0', 'false', 'off'].includes(value)) {
    return null;
  }
  if (value === 'broken' || value === 'warning' || value === 'healthy') {
    return value;
  }
  if (value === '1' || value === 'true') {
    return 'broken';
  }
  throw new Error(`DEMO must be off (unset, 0, false, off) or one of 1, true, broken, warning, healthy; got "${raw}"`);
}

/**
 * APP_PUSH: native push to the Kubernanny app through the relay. On by
 * default (unset, on, true, 1); off, false or 0 switches it off for good:
 * no push routes, no stored tokens, no push to the relay, and the app cannot
 * switch it back on. Anything else stops the start, as for DEMO.
 */
export function parseAppPush(raw: string | undefined): boolean {
  return parseSwitch('APP_PUSH', raw, true);
}

/**
 * DEADMAN: the dead man's switch (docs/NOTIFICATIONS.md, "When the agent
 * goes silent"). On by default; off, false or 0 deposits nothing with the
 * relay (and clears what an earlier run deposited), and the app shows it as
 * switched off.
 */
export function parseDeadman(raw: string | undefined): boolean {
  return parseSwitch('DEADMAN', raw, true);
}

/**
 * WIDGET_REFRESH_MINUTES: how often a device with a home-screen widget gets a
 * silent status push when nothing else was pushed to it (docs/NOTIFICATIONS.md,
 * "The home-screen widget"). Default 60; 0 switches these pushes off; below 30
 * stops the start (the relay allows two an hour per device, and iOS throttles
 * background pushes that come more often).
 */
export function parseWidgetRefreshMinutes(raw: string | undefined): number {
  const value = int('WIDGET_REFRESH_MINUTES', raw, 60, 0, 1440);
  if (value > 0 && value < 30) {
    throw new Error(`WIDGET_REFRESH_MINUTES must be 0 (off) or from 30 to 1440, got "${raw}"`);
  }
  return value;
}

/** A component of your own, recognised by image prefix: `{ "name": "Shop API", "images": ["ghcr.io/acme/shop-api"] }`. */
export interface CustomComponent {
  id: string;
  name: string;
  images: string[];
  category: string;
  icon: string;
  description?: string;
}

const CATEGORIES = ['storage', 'gitops', 'database', 'certificates', 'observability', 'networking', 'security', 'maintenance', 'backup', 'platform', 'apps'];

/** Parses CUSTOM_COMPONENTS (JSON array). Fails the start on anything malformed rather than silently ignoring it. */
export function parseCustomComponents(raw: string | undefined): CustomComponent[] {
  if (!raw) {
    return [];
  }
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    throw new Error('CUSTOM_COMPONENTS is not valid JSON');
  }
  if (!Array.isArray(list)) {
    throw new Error('CUSTOM_COMPONENTS must be a JSON array');
  }
  return list.map((item, i) => {
    const c = item as Partial<CustomComponent>;
    if (typeof c.name !== 'string' || !c.name.trim() || !Array.isArray(c.images) || c.images.length === 0 || !c.images.every((x) => typeof x === 'string' && x.length > 2)) {
      throw new Error(`CUSTOM_COMPONENTS[${i}] needs a name and a non-empty list of image prefixes`);
    }
    const category = c.category && CATEGORIES.includes(c.category) ? c.category : 'apps';
    return {
      id: `custom:${(c.id ?? c.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
      name: c.name.trim().slice(0, 60),
      images: c.images,
      category,
      icon: typeof c.icon === 'string' ? c.icon : 'cube-outline',
      // Without one, the app shows "Your own application" in its language.
      description: typeof c.description === 'string' && c.description.trim() ? c.description.slice(0, 160) : undefined,
    };
  });
}

export interface Config {
  port: number;
  clusterName: string;
  /** LANGUAGE: texts for requests that name no language, notifications, the weekly report and the pairing banner. */
  language: Lang;
  /** Unix socket of the internal API (end-to-end channel and admin CLI); never on the network. */
  internalSocket: string;
  /** DEMO mode (its scenario), or null: a made-up cluster, and every device counts as paired. The one source for the flag. */
  demo: DemoScenario | null;
  intervalSeconds: number;
  /** An issue must stay this long before it is pushed: kured reboots and rollouts heal on their own. */
  notifyAfterSeconds: number;
  ntfyUrl?: string;
  ntfyToken?: string;
  /** Overrides discovery; otherwise reached through the API server's service proxy. */
  alertmanagerUrl?: string;
  prometheusUrl?: string;
  /** The address the app reaches the agent at, for the pairing link. */
  publicUrl?: string;
  webhookUrl?: string;
  webhookFormat?: 'auto' | 'discord' | 'slack' | 'gotify' | 'json';
  /** Weekly report (DIGEST=weekly): weekday 0..6 (0 = Sunday) and hour in the agent's time zone (TZ). */
  digest: { weekday: number; hour: number } | null;
  /** full: titles and causes; minimal: only the cluster name and counts (for public services like ntfy.sh). */
  notifyDetail: 'full' | 'minimal';
  /** Port for Prometheus /metrics, kept off the ingress. 0 disables it. */
  metricsPort: number;
  /** Built web UI served at /. */
  webRoot?: string;
  namespace: string;
  certWarnDays: number;
  certCriticalDays: number;
  backupMaxAgeHours: number;
  /** Modules (core checks and integrations) switched off in the deployment; the app cannot switch them on. */
  disabledModules: string[];
  /** Action types switched off in the deployment (`rbac.allowActions: false` adds every write action, argocd-rollback included). */
  disabledActions: string[];
  /** Action types that stay locked until named here (`argocd-rollback`; Helm `actions.enabled`). `disabledActions` wins. */
  enabledActions?: string[];
  /** Modules that are off until switched on (vulnerabilities), switched on by default for this install (Helm `vulnerabilities.enabled`). */
  enabledModules: string[];
  /** OSV-compatible vulnerability database: api.osv.dev or a self-hosted mirror. Only the `vulnerabilities` module calls it. */
  vulnDbUrl: string;
  /** VULN_ACCEPT=off (Helm `vulnerabilities.allowAccept: false`): nobody can accept an advisory, stored acceptances are ignored. */
  vulnAcceptLocked?: boolean;
  /** Namespaces the security posture check leaves alone, on top of the built-in system namespaces. */
  securitySystemNamespaces: string[];
  customComponents: CustomComponent[];
  corsOrigins: string[];
  /** RELAY_URL (wss://…): the agent holds one outbound WebSocket there. Unset: no outbound connection at all. */
  relayUrl?: string;
  /** APP_PUSH: native push to the app through the relay (docs/NOTIFICATIONS.md). False: switched off in the deployment. */
  appPush: boolean;
  /** WIDGET_REFRESH_MINUTES: silent status push to devices with a widget when nothing else went to them for this long; 0 off. */
  widgetRefreshMinutes?: number;
  /** DEADMAN: deposit "agent silent" messages with the relay for devices that ask for them. Absent counts as on. */
  deadman?: boolean;
  /** UPTIME_KUMA_STATUS_PAGE: slug of a published Uptime Kuma status page whose monitors the `uptime-kuma` module reads. */
  uptimeKumaStatusPage?: string;
  /** PAIRING_LOG: print a pairing code and QR code to the log on start (default on). */
  pairingLog?: boolean;
  /**
   * POD_NAME (the chart sets it): the holder name in the Lease that decides
   * which pod sends notifications, runs actions and holds the relay during a
   * rolling update. Unset (outside a pod, demo): this agent is always in charge.
   */
  podName?: string;
  /** LEASE_NAME: the Lease in the agent's namespace (default kubernanny). */
  leaseName?: string;
  /** SHUTDOWN_DELAY_SECONDS: after SIGTERM, keep answering this long (unready) while the endpoints are removed (default 5). */
  shutdownDelaySeconds?: number;
  /** READY_TIMEOUT_SECONDS: /readyz turns ready after the first run, or after this long without one (default 90). */
  readyTimeoutSeconds?: number;
}

/** A status page slug goes into a URL path: letters, digits and dashes only, as Uptime Kuma itself allows. */
export function checkStatusPageSlug(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const slug = raw.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
    throw new Error('UPTIME_KUMA_STATUS_PAGE must be a status page slug (letters, digits, dashes)');
  }
  return slug;
}

export function loadConfig(): Config {
  if (process.env.PULSE_TOKEN) {
    throw new Error('PULSE_TOKEN is gone since 0.3: devices pair with their own keys now (docs/PROTOCOL.md). Remove the variable.');
  }
  const demo = parseDemo(process.env.DEMO);
  return {
    port: num('PORT', 8080),
    clusterName: process.env.CLUSTER_NAME ?? (demo ? 'homelab-demo' : 'cluster'),
    language: parseLanguage(process.env.LANGUAGE),
    internalSocket: process.env.INTERNAL_SOCKET || '/tmp/kubernanny.sock',
    demo,
    intervalSeconds: num('CHECK_INTERVAL_SECONDS', 60),
    notifyAfterSeconds: num('NOTIFY_AFTER_SECONDS', 300),
    ntfyUrl: checkNotifyUrl('NTFY_URL', process.env.NTFY_URL || undefined),
    ntfyToken: process.env.NTFY_TOKEN || undefined,
    alertmanagerUrl: process.env.ALERTMANAGER_URL || undefined,
    prometheusUrl: process.env.PROMETHEUS_URL || undefined,
    publicUrl: process.env.PUBLIC_URL?.replace(/\/+$/, '') || undefined,
    webhookUrl: checkNotifyUrl('WEBHOOK_URL', process.env.WEBHOOK_URL || undefined),
    notifyDetail: parseChoice('NOTIFY_DETAIL', process.env.NOTIFY_DETAIL, ['full', 'minimal'], 'full'),
    digest: parseDigest(process.env),
    webhookFormat: parseChoice<NonNullable<Config['webhookFormat']>>('WEBHOOK_FORMAT', process.env.WEBHOOK_FORMAT, ['auto', 'discord', 'slack', 'gotify', 'json'], 'auto'),
    metricsPort: int('METRICS_PORT', process.env.METRICS_PORT, 9100, 0, 65535),
    webRoot: process.env.WEB_ROOT || undefined,
    namespace: process.env.POD_NAMESPACE || 'kubernanny',
    certWarnDays: num('CERT_WARN_DAYS', 14),
    certCriticalDays: num('CERT_CRITICAL_DAYS', 3),
    backupMaxAgeHours: num('BACKUP_MAX_AGE_HOURS', 26),
    // DISABLED_CHECKS is the name before 0.3; both count.
    disabledModules: [...list('DISABLED_MODULES', []), ...list('DISABLED_CHECKS', [])],
    disabledActions: list('DISABLED_ACTIONS', []),
    enabledActions: list('ENABLED_ACTIONS', []),
    enabledModules: list('ENABLED_MODULES', []),
    vulnDbUrl: (checkNotifyUrl('VULN_DB_URL', process.env.VULN_DB_URL || undefined) ?? 'https://api.osv.dev').replace(/\/+$/, ''),
    vulnAcceptLocked: !parseSwitch('VULN_ACCEPT', process.env.VULN_ACCEPT, true),
    securitySystemNamespaces: list('SECURITY_SYSTEM_NAMESPACES', []),
    customComponents: parseCustomComponents(process.env.CUSTOM_COMPONENTS),
    // Capacitor's WebView origins plus `ionic serve`.
    corsOrigins: list('CORS_ORIGINS', [
      'capacitor://localhost',
      'ionic://localhost',
      'http://localhost',
      'https://localhost',
      'http://localhost:4200',
      'http://localhost:8100',
    ]),
    relayUrl: checkRelayUrl(process.env.RELAY_URL || undefined),
    appPush: parseAppPush(process.env.APP_PUSH),
    widgetRefreshMinutes: parseWidgetRefreshMinutes(process.env.WIDGET_REFRESH_MINUTES),
    deadman: parseDeadman(process.env.DEADMAN),
    // The demo cluster publishes a status page under this slug, so the module has something to show.
    uptimeKumaStatusPage: checkStatusPageSlug(process.env.UPTIME_KUMA_STATUS_PAGE || (demo ? 'homelab' : undefined)),
    pairingLog: parseSwitch('PAIRING_LOG', process.env.PAIRING_LOG, true),
    podName: demo ? undefined : process.env.POD_NAME || undefined,
    leaseName: process.env.LEASE_NAME || 'kubernanny',
    shutdownDelaySeconds: num('SHUTDOWN_DELAY_SECONDS', 5),
    readyTimeoutSeconds: num('READY_TIMEOUT_SECONDS', 90),
  };
}

export const CONFIG = Symbol('CONFIG');
