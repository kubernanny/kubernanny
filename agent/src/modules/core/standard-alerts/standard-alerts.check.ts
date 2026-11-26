import { Issue, IssueSeverity } from '../../../checks/types';
import { raw, t, Text } from '../../../i18n/text';
import { cpuMilli, Inventory } from '../../../inventory/inventory';
import { listSection, sections } from '../../details';
import { CoreCheck } from '../../module';
import { ACCEPT_ANNOTATION, mergeAccept } from '../../security/accept-annotation';
import { AcceptedFinding, SecurityPod, workloadOf } from '../../security/evaluate';
import { cronOfJobs, workloadAcceptAnnotations } from '../../security/workload-accept';
import { Prometheus, PromSample } from '../../service-proxy';
import { DetailRow, DetailSection, ModuleContext, ModuleResult, Stat, Tone } from '../../types';
import { nodeOf } from '../node-clocks';
import { AlertMatch, recordAlertMatches } from './alertmanager-dedupe';
import {
  evaluateOvercommit,
  evaluatePodCapacity,
  evaluateVersions,
  Overcommit,
  overcommit,
  spare,
} from './inventory-rules';
import { Area, ETCD_PEER_RTT_WARNING_S, Finding, label, Names, PROM_RULES, PromRule, WorkloadRef } from './rules';

const ID = 'standard-alerts';
/** Queries in flight at once: a run asks some 40, and Prometheus need not see them all together. */
const PARALLEL = 6;
/** Overcommit, pods per node, version skew: judged from the inventory, with or without Prometheus. */
const INVENTORY_RULES = 3;

export type RuleState =
  | { rule: PromRule; state: 'checked' }
  | { rule: PromRule; state: 'missing' | 'failed' | 'no-prometheus' | 'not-applicable' };

export interface PromOutcome {
  issues: Issue[];
  matches: AlertMatch[];
  states: RuleState[];
  /** etcd peer round trips: from node, to node, p99 now (s). */
  peers: { from: string; to: string; p99: number }[];
  /** Hints the workload accepts in its `kubernanny.io/accept` annotation: in no issue, listed on the sheet. */
  accepted: AcceptedFinding[];
}

async function pool<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length) }, worker));
  return results;
}

const keyOf = (labels: Record<string, string>, by: readonly string[]) => by.map((l) => labels[l] ?? '').join('\u0000');

/** A series' `namespace`/`pod` as its workload, from the pods the run read. */
function workloadsOf(inv: Inventory): Names['workload'] {
  let pods: Map<string, SecurityPod> | null = null;
  let cronOfJob: Map<string, string> | null = null;
  return (labels) => {
    pods ??= new Map(
      inv.pods.map((p) => [`${p.metadata.namespace ?? 'default'}/${p.metadata.name}`, p as SecurityPod]),
    );
    cronOfJob ??= cronOfJobs(inv);
    const pod = pods.get(`${labels.namespace ?? ''}/${labels.pod ?? ''}`);
    if (!pod) {
      return undefined;
    }
    const w = workloadOf(pod, cronOfJob);
    const [namespace, kind, ...rest] = w.key.split('/');
    const limit = pod.spec?.containers?.find((c) => c.name === labels.container)?.resources?.limits?.cpu;
    const ref: WorkloadRef = { key: w.key, namespace: namespace!, kind: kind!, name: rest.join('/') || w.label };
    const podAccept = pod.metadata.annotations?.[ACCEPT_ANNOTATION];
    return {
      ...ref,
      ...(podAccept ? { podAccept } : {}),
      ...(limit ? { cpuLimit: cpuMilli(limit) } : {}),
    };
  };
}

/** Instance labels, node labels and etcd member ids as node names. */
function namesFor(inv: Inventory, members: PromSample[]): Names {
  const node = (labels: Record<string, string>) =>
    labels.node
      ? label(labels, 'node')
      : (nodeOf(inv, { metric: labels, value: 0 }) ??
        (labels.instance ?? labels.pod ?? '?').replace(/:\d+$/, '').slice(0, 120));
  const byId = new Map(members.map((m) => [m.metric.server_id, m.metric]));
  return {
    node,
    etcdMember: (id) => {
      const m = byId.get(id);
      return m ? node(m) : id.slice(0, 32);
    },
    workload: workloadsOf(inv),
  };
}

/** Runs every Prometheus rule: one query for which metrics exist, then each rule's own. */
export async function runPromRules(
  prom: Prometheus,
  inv: Inventory,
  env: { alertmanager: boolean },
  rules: readonly PromRule[] = PROM_RULES,
): Promise<PromOutcome> {
  const applicable = rules.filter((r) => !r.when || r.when(env));
  const names = [...new Set(applicable.flatMap((r) => r.needs))];
  const present = new Set(
    (await prom.query(`group by (__name__) ({__name__=~"${names.join('|')}"})`)).map((s) => s.metric['__name__']),
  );
  const runnable = applicable.filter((r) => r.needs.every((n) => present.has(n)));
  const peerRule = runnable.some((r) => r.key === 'etcd-peer-rtt');
  const [members, results] = await Promise.all([
    peerRule ? prom.query('max by (server_id, instance, pod) (etcd_server_id)').catch(() => []) : Promise.resolve([]),
    pool(runnable, async (rule) => {
      try {
        const [main, ...extras] = await Promise.all([
          prom.query(rule.query),
          ...Object.values(rule.extra ?? {}).map((q) => prom.query(q)),
        ]);
        return { rule, main: main as PromSample[] | null, extras };
      } catch {
        return { rule, main: null, extras: [] as PromSample[][] };
      }
    }),
  ]);
  const n = namesFor(inv, members);
  let workloadAccept: Map<string, string> | null = null;
  const out: PromOutcome = { issues: [], matches: [], states: [], peers: [], accepted: [] };
  for (const rule of rules) {
    if (!applicable.includes(rule)) {
      out.states.push({ rule, state: 'not-applicable' });
    } else if (!runnable.includes(rule)) {
      out.states.push({ rule, state: 'missing' });
    }
  }
  for (const { rule, main, extras } of results) {
    if (main === null) {
      out.states.push({ rule, state: 'failed' });
      continue;
    }
    out.states.push({ rule, state: 'checked' });
    const extraNames = Object.keys(rule.extra ?? {});
    const extraBy = extraNames.map((_, i) => new Map(extras[i]!.map((s) => [keyOf(s.metric, rule.by), s.value])));
    const findings: Finding[] = main.map((s) => {
      const key = keyOf(s.metric, rule.by);
      return {
        labels: Object.fromEntries(rule.by.filter((l) => s.metric[l] !== undefined).map((l) => [l, s.metric[l]!])),
        value: s.value,
        extra: Object.fromEntries(extraNames.map((name, i) => [name, extraBy[i]!.get(key)])),
      };
    });
    if (rule.key === 'etcd-peer-rtt') {
      // The current p99 of every pair, for the sheet; the window's value where there is no current one.
      out.peers = findings.map((f) => ({
        from: n.node(f.labels),
        to: n.etcdMember(label(f.labels, 'To')),
        p99: f.extra.now ?? f.value,
      }));
    }
    if (rule.worstFirst) {
      findings.sort((a, b) => b.value - a.value);
    }
    const seen = new Set<string>();
    for (const f of findings) {
      const severity = rule.judge(f);
      if (!severity) {
        continue;
      }
      const d = rule.describe(f, n, severity);
      if (!d) {
        continue;
      }
      const id = `${ID}/${rule.key}/${d.where}`;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      let cause = d.cause;
      if (rule.accept && d.workload && severity === 'info') {
        // A hint the workload accepts in Git counts nowhere; one that can be accepted says how (as the security hints).
        workloadAccept ??= workloadAcceptAnnotations(inv);
        const w = d.workload;
        const accept = mergeAccept(workloadAccept.get(w.key), w.podAccept);
        const reason = accept.accepted.get(rule.accept);
        if (reason !== undefined) {
          out.accepted.push({
            key: rule.accept,
            finding: d.short ?? d.title,
            namespace: w.namespace,
            kind: w.kind,
            name: w.name,
            reason,
            source: accept.source.get(rule.accept) ?? 'workload',
          });
          continue;
        }
        cause = t('common.sentences', {
          parts: [
            cause,
            accept.missingReason.has(rule.accept)
              ? t('security.accept.noReason', { names: w.name, key: rule.accept })
              : t('security.accept.how', { key: rule.accept }),
          ],
        });
      }
      out.issues.push({ id, check: ID, severity, title: d.title, cause, actions: [] });
      const labels = Object.fromEntries(
        (rule.match ?? rule.by).filter((l) => f.labels[l] !== undefined).map((l) => [l, f.labels[l]!]),
      );
      out.matches.push({ issueId: id, alerts: rule.alerts, labels });
    }
  }
  return out;
}

const REASON: Record<Exclude<RuleState['state'], 'checked'>, Text> = {
  missing: t('std.reason.missing'),
  failed: t('std.reason.failed'),
  'no-prometheus': t('std.reason.noPrometheus'),
  'not-applicable': t('std.reason.notApplicable'),
};

const AREA: Record<Area, Text> = {
  etcd: t('std.area.etcd'),
  nodes: t('std.area.nodes'),
  kubernetes: t('std.area.kubernetes'),
  dns: t('std.area.dns'),
  prometheus: t('std.area.prometheus'),
};

const RANK: Record<IssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** A rule whose metric is missing for a reason of the cluster's setup (no RAID, no quotas): not applying, not a gap. */
const notApplying = (s: RuleState) => s.state === 'missing' && !!s.rule.absent;

function ruleRows(states: RuleState[], issues: Issue[]): DetailRow[] {
  return states.map(({ rule, state }) => {
    const own = issues
      .filter((i) => i.id.startsWith(`${ID}/${rule.key}/`))
      .sort((a, b) => RANK[a.severity] - RANK[b.severity]);
    const tone: Tone =
      state !== 'checked'
        ? 'muted'
        : own[0]?.severity === 'critical'
          ? 'critical'
          : own[0]?.severity === 'warning'
            ? 'warning'
            : 'ok';
    return {
      // Upstream's alert names are the same in every language.
      name: rule.alerts.join(' / '),
      sub: AREA[rule.area],
      tone,
      value:
        state === 'checked'
          ? own.length
            ? t('std.rule.fires', { n: own.length })
            : t('std.rule.ok')
          : state === 'missing' && rule.absent
            ? rule.absent
            : REASON[state],
    };
  });
}

function overcommitStats(values: Overcommit[]): Stat[] {
  return values
    .filter((o) => o.nodes > 1 && spare(o) > 0)
    .map((o) => {
      const share = Math.round((o.requested / spare(o)) * 100);
      return {
        label: t(o.resource === 'cpu' ? 'std.stat.cpuWithoutLargest' : 'std.stat.memoryWithoutLargest'),
        value: `${share} %`,
        tone: share > 100 ? ('warning' as const) : ('ok' as const),
      };
    });
}

/**
 * The generally valid alerts of the community rule sets (etcd, node-exporter,
 * kubernetes, CoreDNS, Prometheus mixins), built in: they work in every cluster
 * without anyone writing alerting rules. Most need Prometheus; the requests
 * against capacity, pods per node and version skew come from the objects the
 * run reads anyway. docs/CHECKS.md lists every rule and the upstream alerts
 * left to other modules or out.
 */
export class StandardAlertsCheck extends CoreCheck {
  readonly id = ID;
  readonly name = t('module.standardAlerts.name');
  readonly icon = 'notifications-outline';
  readonly description = t('module.standardAlerts.description');
  readonly reads = [];

  protected async check(ctx: ModuleContext): Promise<ModuleResult> {
    const values = overcommit(ctx.inv);
    const local = [evaluateOvercommit(values), evaluatePodCapacity(ctx.inv), evaluateVersions(ctx.inv)];
    const alertmanager = !!ctx.config.alertmanagerUrl || !!ctx.detected?.some((d) => d.entry.id === 'alertmanager');
    const prom: PromOutcome = ctx.prom
      ? await runPromRules(ctx.prom, ctx.inv, { alertmanager })
      : {
          issues: [],
          matches: [],
          peers: [],
          accepted: [],
          states: PROM_RULES.map((rule) => ({ rule, state: 'no-prometheus' as const })),
        };
    // A flapping node that someone cordoned is being worked on (kured, upgrades): not reported, as upstream.
    const cordoned = new Set(ctx.inv.nodes.filter((n) => n.spec?.unschedulable).map((n) => n.metadata.name));
    const flapping = (i: Issue) =>
      i.id.startsWith(`${ID}/node-flapping/`) && cordoned.has(i.id.slice(`${ID}/node-flapping/`.length));
    const issues = [...local.flatMap((l) => l.issues), ...prom.issues.filter((i) => !flapping(i))];
    recordAlertMatches(ctx.data, [...local.flatMap((l) => l.matches), ...prom.matches]);

    const checked = prom.states.filter((s) => s.state === 'checked').length;
    const stats: Stat[] = [];
    if (prom.peers.length) {
      const worst = Math.max(...prom.peers.map((p) => p.p99));
      stats.push({
        label: t('std.stat.etcdPeerRtt'),
        value: `${Math.round(worst * 1000)} ms`,
        tone: worst > ETCD_PEER_RTT_WARNING_S ? 'warning' : 'ok',
      });
    }
    stats.push(...overcommitStats(values));
    stats.push(
      ctx.prom
        ? {
            label: t('std.stat.rules'),
            value: `${checked + INVENTORY_RULES}/${PROM_RULES.length + INVENTORY_RULES}`,
            tone: checked === PROM_RULES.length ? 'ok' : 'muted',
          }
        : { label: t('std.stat.rules'), value: t('std.needsPrometheus'), tone: 'muted' },
    );
    const peerSection: DetailSection | null = prom.peers.length
      ? {
          title: t('std.detail.peers'),
          kind: 'table',
          columns: [t('std.detail.from'), t('std.detail.to'), raw('p99')],
          rows: [...prom.peers]
            .sort((a, b) => b.p99 - a.p99)
            .map((p) => ({
              cells: [p.from, p.to, `${Math.round(p.p99 * 1000)} ms`],
              tone: p.p99 > ETCD_PEER_RTT_WARNING_S ? ('warning' as const) : ('ok' as const),
            })),
        }
      : null;
    const summary =
      (issues.find((i) => i.severity === 'critical') ?? issues.find((i) => i.severity === 'warning'))?.title ??
      (ctx.prom ? t('std.summary.ok', { n: checked + INVENTORY_RULES }) : t('std.summary.noPrometheus'));
    const details = sections(
      peerSection,
      listSection(
        t('std.detail.rules'),
        ruleRows(
          prom.states.filter((st) => !notApplying(st)),
          issues,
        ),
        false,
      ),
      listSection(t('std.detail.notApplying'), ruleRows(prom.states.filter(notApplying), issues), false),
    );
    const accepted = [...prom.accepted].sort(
      (a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name),
    );
    return { issues, stats, details, summary, ...(accepted.length ? { acceptedFindings: accepted } : {}) };
  }
}
