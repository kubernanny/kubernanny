import {
  Category,
  CheckStatus,
  Issue,
  IssueAction,
  IssueActionType,
  Light,
  ModuleView,
  Overview,
  PendingSync,
  Snapshot,
  Tone,
} from '../core/agent.model';
import {
  bytes,
  cores,
  duration,
  LIGHT_TONE,
  percent,
  ratio,
  relativeTime,
  sinceText,
  STATUS_TONE,
  untilText,
} from '../core/format';
import { KNOWN_AGENT_VERSION, olderThan, UPGRADE_COMMAND } from '../core/version';
import { TranslationKey } from '../i18n/dictionary';
import { Translator } from '../i18n/translator';
import { resourceBarView, ResourceInput } from '../ui/resource-bar';
import { maintenanceView, MaintenanceVM } from './maintenance-view';
import { acceptComponentOf, ACCEPTING_MODULES } from './vulnerability-acceptance';

export interface ActionButton {
  type: IssueActionType;
  /** Position among this issue's actions of the same type (the agent's `index`). */
  index: number;
  label: string;
  icon: string;
  /** Question to confirm before running; null runs at once. */
  confirm: string | null;
  /** primary: what to do first (filled). secondary: a second choice, quieter, with `hint` under the row. */
  emphasis: 'primary' | 'normal' | 'secondary';
  /** One sentence on when this action helps, shown under the buttons (the crash loop's restart). */
  hint: string | null;
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
  /** CPU and RAM: use, requests and limits against what there is, as a loading bar. */
  bar?: ResourceInput;
}

export interface NodeResourceRow {
  name: string;
  cpu: ResourceInput;
  memory: ResourceInput;
}

/** One node in the rail's per-node comparison: a thin bar, its percentage, problem nodes first. */
export interface RailNode {
  name: string;
  bar: ResourceInput;
  pct: string;
  tone: Tone;
  problem: boolean;
}

export interface RailResource {
  key: 'cpu' | 'memory';
  label: string;
  /** Null from agents without requests: the figure is shown as text only. */
  bar: ResourceInput | null;
  value: string;
  note: string;
  tone: Tone;
  nodes: RailNode[];
}

/** The cluster's figures as a rail: the small counts in one row, CPU and RAM across the width with a bar per node. */
export interface RailView {
  small: Kpi[];
  resources: RailResource[];
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
  rail: RailView;
  /** Manual Argo CD apps with a change waiting: one calm card, no issue. */
  pendingSyncs: PendingSync[];
  /** "3 Apps bereit zum Sync", empty without any. */
  pendingLabel: string;
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

const CATEGORY_ORDER: Category[] = [
  'core',
  'storage',
  'database',
  'gitops',
  'certificates',
  'observability',
  'networking',
  'security',
  'backup',
  'maintenance',
  'platform',
  'apps',
];

const STATUS_KEY: Record<CheckStatus, TranslationKey> = {
  ok: 'status.ok',
  warning: 'status.warning',
  critical: 'status.critical',
  error: 'status.error',
  skipped: 'status.skipped',
};

type ButtonBase = Omit<ActionButton, 'emphasis' | 'hint'> & { secondary?: boolean; hint?: string };

const FLUX_KINDS = new Set(['Kustomization', 'HelmRelease']);

function buttonBase(action: IssueAction, index: number, tr: Translator): ButtonBase {
  const target =
    'namespace' in action && 'name' in action ? `${action.namespace}/${action.name}` : '';
  switch (action.type) {
    case 'argocd-sync':
      return {
        type: action.type,
        index,
        label: tr.t('actions.sync'),
        icon: 'sync-outline',
        confirm: tr.t('actions.syncConfirm', { app: action.app }),
      };
    case 'argocd-refresh':
      return {
        type: action.type,
        index,
        label: tr.t('actions.hardRefresh'),
        icon: 'refresh-outline',
        confirm: null,
      };
    case 'restart':
      return {
        type: action.type,
        index,
        label: tr.t('actions.restart', { name: action.name }),
        icon: 'reload-outline',
        confirm: action.changed
          ? tr.t('actions.restartConfirmChanged', {
              kind: action.kind,
              target,
              configMap: action.changed.name,
            })
          : tr.t('actions.restartConfirm', { kind: action.kind, target }),
        ...(action.secondary ? { secondary: true, hint: tr.t('actions.restartHint') } : {}),
      };
    case 'logs':
      return {
        type: action.type,
        index,
        label: tr.t(action.previous ? 'actions.logsBeforeCrash' : 'actions.logs'),
        icon: 'document-text-outline',
        confirm: null,
      };
    case 'cnpg-backup':
      return {
        type: action.type,
        index,
        label: tr.t('actions.backup'),
        icon: 'save-outline',
        confirm: tr.t('actions.backupConfirm', { cluster: action.cluster }),
      };
    case 'longhorn-backup':
      return {
        type: action.type,
        index,
        label: tr.t('actions.backup'),
        icon: 'save-outline',
        confirm: tr.t('actions.longhornBackupConfirm', { volume: action.label }),
      };
    case 'velero-backup':
      return {
        type: action.type,
        index,
        label: tr.t('actions.backup'),
        icon: 'save-outline',
        confirm: tr.t('actions.veleroBackupConfirm', { schedule: action.schedule }),
      };
    case 'uncordon':
      return {
        type: action.type,
        index,
        label: tr.t('actions.uncordon'),
        icon: 'lock-open-outline',
        confirm: tr.t('actions.uncordonConfirm', { node: action.node }),
      };
    case 'job-rerun':
      return {
        type: action.type,
        index,
        label: tr.t('actions.rerun'),
        icon: 'play-outline',
        confirm: tr.t(
          action.from === 'CronJob' ? 'actions.rerunCronConfirm' : 'actions.rerunJobConfirm',
          { target },
        ),
      };
    case 'reconcile-now':
      if (action.kind === 'Certificate') {
        return {
          type: action.type,
          index,
          label: tr.t('actions.renew'),
          icon: 'ribbon-outline',
          confirm: tr.t('actions.renewConfirm', { target }),
        };
      }
      return {
        type: action.type,
        index,
        label: tr.t('actions.reconcile'),
        icon: 'git-pull-request-outline',
        confirm: FLUX_KINDS.has(action.kind)
          ? tr.t('actions.reconcileFluxConfirm', { kind: action.kind, target })
          : tr.t(
              action.kind === 'ExternalSecret'
                ? 'actions.reconcileExternalSecretConfirm'
                : 'actions.reconcileInfisicalConfirm',
              { target },
            ),
      };
    case 'cleanup-pods':
      return {
        type: action.type,
        index,
        label: tr.t('actions.cleanup'),
        icon: 'trash-outline',
        confirm: tr.n('actions.cleanupConfirm', action.pods.length, {
          namespace: action.namespace,
        }),
      };
    case 'force-delete-terminating':
      return {
        type: action.type,
        index,
        label: tr.t('actions.forceDelete'),
        icon: 'close-circle-outline',
        confirm: action.statefulSet
          ? tr.t('actions.forceDeleteConfirmStatefulSet', {
              target: `${action.namespace}/${action.pod}`,
              node: action.node,
              statefulSet: action.statefulSet,
            })
          : tr.t('actions.forceDeleteConfirm', {
              target: `${action.namespace}/${action.pod}`,
              node: action.node,
            }),
      };
    case 'argocd-terminate-op':
      return {
        type: action.type,
        index,
        label: tr.t('actions.terminate'),
        icon: 'stop-circle-outline',
        confirm: tr.t('actions.terminateConfirm', { app: action.app }),
      };
    case 'pvc-expand':
      return {
        type: action.type,
        index,
        label: tr.t('actions.expand', { size: action.to }),
        icon: 'resize-outline',
        confirm: action.template
          ? tr.t('actions.expandConfirmTemplate', {
              target,
              from: action.from,
              to: action.to,
              template: action.template,
            })
          : tr.t('actions.expandConfirm', { target, from: action.from, to: action.to }),
      };
  }
}

/**
 * One button. `first`: the issue's first action, what to try first, drawn
 * filled; a secondary one (the restart of a crash loop) is drawn quiet and
 * explains under the row when it helps.
 */
export function actionButton(
  action: IssueAction,
  index: number,
  tr: Translator,
  first = false,
): ActionButton {
  const { secondary, hint, ...base } = buttonBase(action, index, tr);
  return {
    ...base,
    emphasis: secondary ? 'secondary' : first ? 'primary' : 'normal',
    hint: hint ?? null,
  };
}

function buttonsFor(issue: Issue, tr: Translator): ActionButton[] {
  const seen = new Map<IssueActionType, number>();
  return issue.actions.map((action, i) => {
    const index = seen.get(action.type) ?? 0;
    seen.set(action.type, index + 1);
    return actionButton(action, index, tr, i === 0);
  });
}

export function issueCards(
  issues: Issue[],
  modules: ModuleView[],
  now: Date,
  tr: Translator,
): IssueCard[] {
  const names = new Map(modules.map((m) => [m.id, m.name]));
  const canAccept = modules.some((m) => ACCEPTING_MODULES.includes(m.id) && m.canAccept === true);
  return issues.map((issue) => ({
    issue,
    tone: issue.severity === 'info' ? 'muted' : issue.severity,
    icon:
      issue.severity === 'critical'
        ? 'alert-circle'
        : issue.severity === 'warning'
          ? 'warning'
          : 'information-circle-outline',
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
  return (ids ?? [])
    .filter((id) => /^[A-Za-z0-9][A-Za-z0-9._:-]{1,80}$/.test(id))
    .map((id) => ({ id, url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}` }));
}

export function moduleRow(m: ModuleView, tr: Translator): ModuleRow {
  // A component installed several times (Redis per app) names how often, not the first copy's namespace.
  const copies = m.instances?.length ?? 0;
  const versions = new Set((m.instances ?? []).map((x) => x.version).filter(Boolean));
  const meta =
    copies > 1
      ? [
          tr.n('services.instances', copies),
          versions.size > 1 ? tr.t('services.versionsDiffer') : m.version,
        ]
          .filter(Boolean)
          .join(', ')
      : [m.version, m.namespace].filter(Boolean).join(', ');
  return { module: m, tone: STATUS_TONE[m.status], statusLabel: tr.t(STATUS_KEY[m.status]), meta };
}

/** The headline of a cluster: what someone needs to know, in one sentence. */
export function headline(
  light: Light,
  critical: number,
  warning: number,
  tr: Translator,
  error?: string,
): string {
  if (error) {
    return tr.t('cluster.headline.noConnection');
  }
  if (light === 'unknown') {
    return tr.t('cluster.headline.checking');
  }
  if (critical === 0 && warning === 0) {
    return tr.t(
      light === 'yellow' ? 'cluster.headline.partlyCheckable' : 'cluster.headline.allGood',
    );
  }
  const outages = tr.n('cluster.headline.outages', critical);
  const warnings = tr.n('cluster.headline.warnings', warning);
  if (critical > 0 && warning > 0) {
    return tr.t('cluster.headline.both', { outages, warnings });
  }
  return critical > 0 ? outages : warnings;
}

export function buildClusterView(
  snapshot: Snapshot | null,
  error: string | null,
  now: Date,
  tr: Translator,
): ClusterView {
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
    k8s
      ? `${k8s.distribution} ${k8s.version?.replace(/^v/, '').replace(/\+.*$/, '') ?? ''}`.trim()
      : null,
    o ? tr.n('cluster.subline.nodes', o.nodes.total) : null,
    o ? tr.n('cluster.subline.components', o.components) : null,
  ]
    .filter(Boolean)
    .join(', ')
    // Which Kubernanny runs there: the image tag CI baked in, else the version.
    .concat(
      s ? ` · ${tr.t('cluster.subline.agent', { version: s.agentBuild ?? s.agentVersion })}` : '',
    );

  const cpu = o?.cpu ? ratio(o.cpu.usedMilli, o.cpu.allocatableMilli) : null;
  const mem = o?.memory ? ratio(o.memory.used, o.memory.allocatable) : null;
  const withoutLimit = (o?.perNode ?? []).reduce(
    (a, n) => ({
      cpu: a.cpu + n.podsWithoutLimit.cpu,
      memory: a.memory + n.podsWithoutLimit.memory,
    }),
    { cpu: 0, memory: 0 },
  );
  const toneFor = (r: number | null): Tone =>
    r === null ? 'muted' : r >= 0.9 ? 'critical' : r >= 0.8 ? 'warning' : 'ok';
  const kpis: Kpi[] = o
    ? [
        {
          label: tr.t('cluster.kpi.nodesReady'),
          value: `${o.nodes.ready}/${o.nodes.total}`,
          note:
            o.nodes.ready === o.nodes.total
              ? tr.t('cluster.kpi.allThere')
              : tr.n('cluster.kpi.missing', o.nodes.total - o.nodes.ready),
          tone: o.nodes.ready === o.nodes.total ? 'ok' : 'critical',
        },
        {
          label: tr.t('cluster.kpi.cpu'),
          value: percent(cpu, lang),
          note: o.cpu
            ? tr.t('resources.cores', {
                used: cores(o.cpu.usedMilli, lang),
                total: cores(o.cpu.allocatableMilli, lang),
              })
            : tr.t('cluster.kpi.noMetrics'),
          tone: toneFor(cpu),
          ...(o.cpu?.requestedMilli !== undefined
            ? {
                bar: {
                  kind: 'cpu',
                  used: o.cpu.usedMilli,
                  capacity: o.cpu.allocatableMilli,
                  requested: o.cpu.requestedMilli,
                  limit: o.cpu.limitMilli,
                  withoutLimit: withoutLimit.cpu,
                },
              }
            : {}),
        },
        {
          label: tr.t('cluster.kpi.ram'),
          value: percent(mem, lang),
          note: o.memory
            ? tr.t('resources.of', {
                used: bytes(o.memory.used, lang),
                total: bytes(o.memory.allocatable, lang),
              })
            : tr.t('cluster.kpi.noMetrics'),
          tone: toneFor(mem),
          ...(o.memory?.requested !== undefined
            ? {
                bar: {
                  kind: 'memory',
                  used: o.memory.used,
                  capacity: o.memory.allocatable,
                  requested: o.memory.requested,
                  limit: o.memory.limit,
                  withoutLimit: withoutLimit.memory,
                },
              }
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
          note:
            o.volumes.bound === o.volumes.total
              ? tr.t('cluster.kpi.allBound')
              : tr.n('cluster.kpi.waiting', o.volumes.total - o.volumes.bound),
          tone: o.volumes.bound === o.volumes.total ? 'ok' : 'warning',
        },
        {
          label: tr.t('cluster.kpi.ingresses'),
          value: String(o.ingresses),
          note: tr.t('cluster.kpi.publicAddresses'),
          tone: 'muted',
        },
      ]
    : [];

  const rows = (s?.modules ?? [])
    .filter((m) => m.status !== 'skipped')
    .map((m) => moduleRow(m, tr));
  const rank: Record<Tone, number> = { critical: 0, warning: 1, muted: 2, ok: 3 };
  const groups = CATEGORY_ORDER.map((category) => ({
    category,
    label: tr.t(CATEGORY_KEY[category]),
    rows: rows
      .filter((r) => r.module.category === category)
      .sort((a, b) => rank[a.tone] - rank[b.tone] || a.module.name.localeCompare(b.module.name)),
  })).filter((g) => g.rows.length > 0);

  return {
    light,
    tone: LIGHT_TONE[light],
    headline: headline(
      s ? s.light : 'unknown',
      critical,
      warning,
      tr,
      stale ? (error ?? undefined) : s?.error,
    ),
    subline,
    checked: stale
      ? (error ?? '')
      : s?.failingSince
        ? tr.t('cluster.failing', {
            since: duration(s.failingSince, now, lang) ?? tr.t('cluster.failingMoment'),
            when: relativeTime(s.checkedAt, now, lang),
          })
        : s?.checkedAt
          ? s.durationMs !== null
            ? tr.t('cluster.checkedIn', {
                when: relativeTime(s.checkedAt, now, lang),
                ms: s.durationMs,
              })
            : tr.t('cluster.checked', { when: relativeTime(s.checkedAt, now, lang) })
          : tr.t('cluster.connecting'),
    stale,
    issues: issueCards(issues, s?.modules ?? [], now, tr),
    hints: issueCards(hints, s?.modules ?? [], now, tr),
    silenced: issueCards(
      all.filter((i) => i.silencedUntil),
      s?.modules ?? [],
      now,
      tr,
    ),
    update:
      s?.agentVersion && olderThan(s.agentVersion, KNOWN_AGENT_VERSION)
        ? {
            text: tr.t('cluster.update', { agent: s.agentVersion, app: KNOWN_AGENT_VERSION }),
            command: UPGRADE_COMMAND,
          }
        : null,
    critical,
    warning,
    kpis,
    rail: buildRail(kpis, o?.perNode ?? [], tr),
    pendingSyncs: stale ? [] : (s?.modules ?? []).flatMap((m) => m.pendingSyncs ?? []),
    pendingLabel: stale
      ? ''
      : ((n) => (n ? tr.n('pendingSync.card', n) : ''))(
          (s?.modules ?? []).reduce((c, m) => c + (m.pendingSyncs?.length ?? 0), 0),
        ),
    perNode: (o?.perNode ?? []).map((n) => ({
      name: n.name,
      cpu: {
        kind: 'cpu',
        used: n.cpu.usedMilli,
        capacity: n.cpu.allocatableMilli,
        requested: n.cpu.requestedMilli,
        limit: n.cpu.limitMilli,
        withoutLimit: n.podsWithoutLimit.cpu,
      },
      memory: {
        kind: 'memory',
        used: n.memory.used,
        capacity: n.memory.allocatable,
        requested: n.memory.requested,
        limit: n.memory.limit,
        withoutLimit: n.podsWithoutLimit.memory,
      },
    })),
    groups,
    attention: rows.filter(
      (r) => r.tone === 'critical' || r.tone === 'warning' || r.module.status === 'error',
    ),
    hasPrometheus: o?.prometheus ?? false,
    maintenance: maintenanceView(s?.maintenanceUntil, now, tr),
  };
}

/** The rail from the figures: nodes, pods, volumes and addresses small; CPU and RAM with their per-node bars. */
export function buildRail(
  kpis: Kpi[],
  perNode: NonNullable<Overview['perNode']>,
  tr: Translator,
): RailView {
  const rank: Record<Tone, number> = { critical: 0, warning: 1, muted: 2, ok: 3 };
  const resource = (key: 'cpu' | 'memory', kpi: Kpi | undefined): RailResource | null => {
    if (!kpi) {
      return null;
    }
    const nodes = perNode
      .map((n): RailNode => {
        const bar: ResourceInput =
          key === 'cpu'
            ? {
                kind: 'cpu',
                used: n.cpu.usedMilli,
                capacity: n.cpu.allocatableMilli,
                requested: n.cpu.requestedMilli,
                limit: n.cpu.limitMilli,
                withoutLimit: n.podsWithoutLimit.cpu,
              }
            : {
                kind: 'memory',
                used: n.memory.used,
                capacity: n.memory.allocatable,
                requested: n.memory.requested,
                limit: n.memory.limit,
                withoutLimit: n.podsWithoutLimit.memory,
              };
        const v = resourceBarView(bar, n.name, tr);
        return {
          name: n.name,
          bar,
          pct: v.pct,
          tone: v.tone,
          problem: v.tone === 'warning' || v.tone === 'critical',
        };
      })
      .sort((a, b) => rank[a.tone] - rank[b.tone] || a.name.localeCompare(b.name));
    return {
      key,
      label: kpi.label,
      bar: kpi.bar ?? null,
      value: kpi.value,
      note: kpi.note,
      tone: kpi.tone,
      nodes,
    };
  };
  const [nodes, cpu, ram, pods, volumes, addresses] = kpis;
  return {
    small: [nodes, pods, volumes, addresses].filter((k): k is Kpi => k !== undefined),
    resources: [resource('cpu', cpu), resource('memory', ram)].filter(
      (r): r is RailResource => r !== null,
    ),
  };
}
