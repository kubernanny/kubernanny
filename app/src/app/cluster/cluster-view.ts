import { Category, CheckStatus, Issue, IssueAction, IssueActionType, Light, ModuleView, Snapshot, Tone } from '../core/agent.model';
import { KNOWN_AGENT_VERSION, UPGRADE_COMMAND, olderThan } from '../core/version';
import { LIGHT_TONE, STATUS_TONE, bytes, cores, duration, percent, ratio, relativeTime, sinceText, untilText } from '../core/format';
import { nodeResourceNote, resourceNote } from '../core/resources-text';
import { TranslationKey } from '../i18n/dictionary';
import { Translator } from '../i18n/translator';
import { MaintenanceVM, maintenanceView } from './maintenance-view';
import { ACCEPTING_MODULES, acceptComponentOf } from './vulnerability-acceptance';

export interface ActionButton {
  type: IssueActionType;
  /** Position among this issue's actions of the same type (the agent's `index`). */
  index: number;
  label: string;
  icon: string;
  /** Question to confirm before running; null runs at once. */
  confirm: string | null;
}

export interface IssueCard {
  issue: Issue;
  tone: Tone;
  icon: string;
  area: string;
  sinceText: string;
  buttons: ActionButton[];
  /** "stumm bis 18:30" / "silenced until 6:30 PM" while silenced, else null. */
  silencedText: string | null;
  /** Critical and warning issues can be silenced; hints never notify anyway. */
  canSilence: boolean;
  /** Advisories of a known vulnerability, each a link to its osv.dev page. */
  advisoryLinks: { id: string; url: string }[];
  /** The component whose advisories can be marked as not applicable here; null when the agent does not allow it. */
  acceptComponent: string | null;
}

export interface Kpi {
  label: string;
  value: string;
  note: string;
  tone: Tone;
  /** CPU and RAM: use, requests and limits as shares of what there is, with requests and limits in numbers. */
  bar?: { used: number | null; reserved: number | null; limit: number | null; note: string };
}

export interface NodeResourceBar {
  used: number | null;
  reserved: number | null;
  limit: number | null;
  text: string;
  note: string;
}

export interface NodeResourceRow {
  name: string;
  cpu: NodeResourceBar;
  memory: NodeResourceBar;
}

export interface ModuleRow {
  module: ModuleView;
  tone: Tone;
  statusLabel: string;
  meta: string;
}

export interface CategoryGroup {
  category: Category;
  label: string;
  rows: ModuleRow[];
}

export interface ClusterView {
  light: Light;
  tone: Tone;
  headline: string;
  /** "RKE2 1.33.4, 3 Nodes, 31 Komponenten erkannt" / "RKE2 1.33.4, 3 nodes, 31 components detected" */
  subline: string;
  checked: string;
  stale: boolean;
  /** Critical and warning: what needs someone. */
  issues: IssueCard[];
  /** Info: worth knowing, not a problem (e.g. a manual Argo CD sync waiting). */
  hints: IssueCard[];
  /** Silenced for a while: shown apart, not counted. */
  silenced: IssueCard[];
  /** Set when the agent is older than the version this app was built for. */
  update: { text: string; command: string } | null;
  critical: number;
  warning: number;
  kpis: Kpi[];
  /** Use, requests and limits per node, under the cluster's figures. */
  perNode: NodeResourceRow[];
  groups: CategoryGroup[];
  attention: ModuleRow[];
  hasPrometheus: boolean;
  /** A maintenance window holding back notifications. */
  maintenance: MaintenanceVM;
}

/** Translation keys of the categories and the module states. */
export const CATEGORY_KEY: Record<Category, TranslationKey> = {
  core: 'categories.core',
  storage: 'categories.storage',
  gitops: 'categories.gitops',
  database: 'categories.database',
  certificates: 'categories.certificates',
  observability: 'categories.observability',
  networking: 'categories.networking',
  security: 'categories.security',
  maintenance: 'categories.maintenance',
  backup: 'categories.backup',
  platform: 'categories.platform',
  apps: 'categories.apps',
};

const CATEGORY_ORDER: Category[] = ['core', 'storage', 'database', 'gitops', 'certificates', 'observability', 'networking', 'security', 'backup', 'maintenance', 'platform', 'apps'];

const STATUS_KEY: Record<CheckStatus, TranslationKey> = {
  ok: 'status.ok',
  warning: 'status.warning',
  critical: 'status.critical',
  error: 'status.error',
  skipped: 'status.skipped',
};

export function actionButton(action: IssueAction, index: number, tr: Translator): ActionButton {
  switch (action.type) {
    case 'argocd-sync':
      return { type: action.type, index, label: tr.t('actions.sync'), icon: 'sync-outline', confirm: tr.t('actions.syncConfirm', { app: action.app }) };
    case 'argocd-refresh':
      return { type: action.type, index, label: tr.t('actions.hardRefresh'), icon: 'refresh-outline', confirm: null };
    case 'restart':
      return {
        type: action.type,
        index,
        label: tr.t('actions.restart', { name: action.name }),
        icon: 'reload-outline',
        confirm: tr.t('actions.restartConfirm', { kind: action.kind, target: `${action.namespace}/${action.name}` }),
      };
    case 'logs':
      return { type: action.type, index, label: tr.t(action.previous ? 'actions.logsBeforeCrash' : 'actions.logs'), icon: 'document-text-outline', confirm: null };
    case 'cnpg-backup':
      return { type: action.type, index, label: tr.t('actions.backup'), icon: 'save-outline', confirm: tr.t('actions.backupConfirm', { cluster: action.cluster }) };
  }
}

function buttonsFor(issue: Issue, tr: Translator): ActionButton[] {
  const seen = new Map<IssueActionType, number>();
  return issue.actions.map((action) => {
    const index = seen.get(action.type) ?? 0;
    seen.set(action.type, index + 1);
    return actionButton(action, index, tr);
  });
}

export function issueCards(issues: Issue[], modules: ModuleView[], now: Date, tr: Translator): IssueCard[] {
  const names = new Map(modules.map((m) => [m.id, m.name]));
  const canAccept = modules.some((m) => ACCEPTING_MODULES.includes(m.id) && m.canAccept === true);
  return issues.map((issue) => ({
    issue,
    tone: issue.severity === 'info' ? 'muted' : issue.severity,
    icon: issue.severity === 'critical' ? 'alert-circle' : issue.severity === 'warning' ? 'warning' : 'information-circle-outline',
    area: names.get(issue.module) ?? issue.module,
    sinceText: sinceText(issue.since, now, tr.lang),
    buttons: buttonsFor(issue, tr),
    silencedText: issue.silencedUntil ? untilText(issue.silencedUntil, now, tr.lang) : null,
    canSilence: issue.severity !== 'info' && !issue.silencedUntil,
    advisoryLinks: advisoryLinks(issue.advisories),
    acceptComponent: acceptComponentOf(issue, canAccept),
  }));
}

/**
 * The osv.dev page of each advisory. The ids come from an external database
 * through the agent, so only well-formed ones become links, and the app
 * builds the URL itself: an agent can never make it open another site.
 */
export function advisoryLinks(ids: string[] | undefined): { id: string; url: string }[] {
  return (ids ?? []).filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/.test(id)).map((id) => ({ id, url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}` }));
}

export function moduleRow(m: ModuleView, tr: Translator): ModuleRow {
  // A component installed several times (Redis per app) names how often, not the first copy's namespace.
  const copies = m.instances?.length ?? 0;
  const versions = new Set((m.instances ?? []).map((x) => x.version).filter(Boolean));
  const meta =
    copies > 1
      ? [tr.n('services.instances', copies), versions.size > 1 ? tr.t('services.versionsDiffer') : m.version].filter(Boolean).join(', ')
      : [m.version, m.namespace].filter(Boolean).join(', ');
  return { module: m, tone: STATUS_TONE[m.status], statusLabel: tr.t(STATUS_KEY[m.status]), meta };
}

/** The headline of a cluster: what someone needs to know, in one sentence. */
export function headline(light: Light, critical: number, warning: number, tr: Translator, error?: string): string {
  if (error) {
    return tr.t('cluster.headline.noConnection');
  }
  if (light === 'unknown') {
    return tr.t('cluster.headline.checking');
  }
  if (critical === 0 && warning === 0) {
    return tr.t(light === 'yellow' ? 'cluster.headline.partlyCheckable' : 'cluster.headline.allGood');
  }
  const outages = tr.n('cluster.headline.outages', critical);
  const warnings = tr.n('cluster.headline.warnings', warning);
  if (critical > 0 && warning > 0) {
    return tr.t('cluster.headline.both', { outages, warnings });
  }
  return critical > 0 ? outages : warnings;
}

export function buildClusterView(snapshot: Snapshot | null, error: string | null, now: Date, tr: Translator): ClusterView {
  const lang = tr.lang;
  const s = snapshot;
  const stale = Boolean(error);
  const light: Light = s && !stale ? s.light : 'unknown';
  const all = s?.issues ?? [];
  const audible = all.filter((i) => !i.silencedUntil);
  const issues = audible.filter((i) => i.severity !== 'info');
  const hints = audible.filter((i) => i.severity === 'info');
  const critical = issues.filter((i) => i.severity === 'critical').length;
  const warning = issues.length - critical;
  const o = s?.overview;
  const k8s = s?.kubernetes;
  const subline = [
    k8s ? `${k8s.distribution} ${k8s.version?.replace(/^v/, '').replace(/\+.*$/, '') ?? ''}`.trim() : null,
    o ? tr.n('cluster.subline.nodes', o.nodes.total) : null,
    o ? tr.n('cluster.subline.components', o.components) : null,
  ]
    .filter(Boolean)
    .join(', ');

  const cpu = o?.cpu ? ratio(o.cpu.usedMilli, o.cpu.allocatableMilli) : null;
  const mem = o?.memory ? ratio(o.memory.used, o.memory.allocatable) : null;
  const toneFor = (r: number | null): Tone => (r === null ? 'muted' : r >= 0.9 ? 'critical' : r >= 0.8 ? 'warning' : 'ok');
  const kpis: Kpi[] = o
    ? [
        {
          label: tr.t('cluster.kpi.nodesReady'),
          value: `${o.nodes.ready}/${o.nodes.total}`,
          note: o.nodes.ready === o.nodes.total ? tr.t('cluster.kpi.allThere') : tr.n('cluster.kpi.missing', o.nodes.total - o.nodes.ready),
          tone: o.nodes.ready === o.nodes.total ? 'ok' : 'critical',
        },
        {
          label: tr.t('cluster.kpi.cpu'),
          value: percent(cpu, lang),
          note: o.cpu ? tr.t('resources.cores', { used: cores(o.cpu.usedMilli, lang), total: cores(o.cpu.allocatableMilli, lang) }) : tr.t('cluster.kpi.noMetrics'),
          tone: toneFor(cpu),
          ...(o.cpu?.requestedMilli !== undefined
            ? { bar: { used: cpu, reserved: ratio(o.cpu.requestedMilli, o.cpu.allocatableMilli), limit: ratio(o.cpu.limitMilli, o.cpu.allocatableMilli), note: resourceNote('cpu', o.cpu.requestedMilli, o.cpu.limitMilli, 0, tr) } }
            : {}),
        },
        {
          label: tr.t('cluster.kpi.ram'),
          value: percent(mem, lang),
          note: o.memory ? tr.t('resources.of', { used: bytes(o.memory.used, lang), total: bytes(o.memory.allocatable, lang) }) : tr.t('cluster.kpi.noMetrics'),
          tone: toneFor(mem),
          ...(o.memory?.requested !== undefined
            ? { bar: { used: mem, reserved: ratio(o.memory.requested, o.memory.allocatable), limit: ratio(o.memory.limit, o.memory.allocatable), note: resourceNote('memory', o.memory.requested, o.memory.limit, 0, tr) } }
            : {}),
        },
        {
          label: tr.t('cluster.kpi.podsRunning'),
          value: `${o.pods.running}/${o.pods.total}`,
          note: tr.t('cluster.kpi.podsNote', { workloads: o.workloads, namespaces: o.namespaces }),
          tone: o.pods.running === o.pods.total ? 'ok' : 'warning',
        },
        {
          label: tr.t('cluster.kpi.volumesBound'),
          value: `${o.volumes.bound}/${o.volumes.total}`,
          note: o.volumes.bound === o.volumes.total ? tr.t('cluster.kpi.allBound') : tr.n('cluster.kpi.waiting', o.volumes.total - o.volumes.bound),
          tone: o.volumes.bound === o.volumes.total ? 'ok' : 'warning',
        },
        { label: tr.t('cluster.kpi.ingresses'), value: String(o.ingresses), note: tr.t('cluster.kpi.publicAddresses'), tone: 'muted' },
      ]
    : [];

  const rows = (s?.modules ?? []).filter((m) => m.status !== 'skipped').map((m) => moduleRow(m, tr));
  const rank: Record<Tone, number> = { critical: 0, warning: 1, muted: 2, ok: 3 };
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    label: tr.t(CATEGORY_KEY[category]),
    rows: rows.filter((r) => r.module.category === category).sort((a, b) => rank[a.tone] - rank[b.tone] || a.module.name.localeCompare(b.module.name)),
  })).filter((g) => g.rows.length > 0);

  return {
    light,
    tone: LIGHT_TONE[light],
    headline: headline(s ? s.light : 'unknown', critical, warning, tr, stale ? (error ?? undefined) : s?.error),
    subline,
    checked: stale
      ? (error ?? '')
      : s?.failingSince
        ? tr.t('cluster.failing', { since: duration(s.failingSince, now, lang) ?? tr.t('cluster.failingMoment'), when: relativeTime(s.checkedAt, now, lang) })
        : s?.checkedAt
        ? s.durationMs !== null
          ? tr.t('cluster.checkedIn', { when: relativeTime(s.checkedAt, now, lang), ms: s.durationMs })
          : tr.t('cluster.checked', { when: relativeTime(s.checkedAt, now, lang) })
        : tr.t('cluster.connecting'),
    stale,
    issues: issueCards(issues, s?.modules ?? [], now, tr),
    hints: issueCards(hints, s?.modules ?? [], now, tr),
    silenced: issueCards(all.filter((i) => i.silencedUntil), s?.modules ?? [], now, tr),
    update:
      s?.agentVersion && olderThan(s.agentVersion, KNOWN_AGENT_VERSION)
        ? { text: tr.t('cluster.update', { agent: s.agentVersion, app: KNOWN_AGENT_VERSION }), command: UPGRADE_COMMAND }
        : null,
    critical,
    warning,
    kpis,
    perNode: (o?.perNode ?? []).map((n) => ({
      name: n.name,
      cpu: {
        used: ratio(n.cpu.usedMilli, n.cpu.allocatableMilli),
        reserved: ratio(n.cpu.requestedMilli, n.cpu.allocatableMilli),
        limit: ratio(n.cpu.limitMilli, n.cpu.allocatableMilli),
        text: tr.t('resources.cores', { used: cores(n.cpu.usedMilli, lang), total: cores(n.cpu.allocatableMilli, lang) }),
        note: nodeResourceNote('cpu', n.cpu.requestedMilli, n.cpu.limitMilli, n.cpu.allocatableMilli, n.podsWithoutLimit.cpu, tr),
      },
      memory: {
        used: ratio(n.memory.used, n.memory.allocatable),
        reserved: ratio(n.memory.requested, n.memory.allocatable),
        limit: ratio(n.memory.limit, n.memory.allocatable),
        text: tr.t('resources.of', { used: bytes(n.memory.used, lang), total: bytes(n.memory.allocatable, lang) }),
        note: nodeResourceNote('memory', n.memory.requested, n.memory.limit, n.memory.allocatable, n.podsWithoutLimit.memory, tr),
      },
    })),
    groups,
    attention: rows.filter((r) => r.tone === 'critical' || r.tone === 'warning' || r.module.status === 'error'),
    hasPrometheus: o?.prometheus ?? false,
    maintenance: maintenanceView(s?.maintenanceUntil, now, tr),
  };
}
