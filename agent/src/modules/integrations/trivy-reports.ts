import { Issue, ageText } from '../../checks/types';
import { ingressUrls, servicesOf } from '../../discovery/discovery';
import { Inventory, PodSpecLite } from '../../inventory/inventory';
import { Text, t } from '../../i18n/text';
import { Acceptance, acceptanceKey, trivyComponentKey } from '../vulnerabilities/acceptance';
import { Finding, Level, LEVEL_RANK, issueSeverity, levelOfScore, scoreText } from '../vulnerabilities/evaluate';
import type { AcceptedAdvisory } from '../types';

/**
 * A VulnerabilityReport or ClusterVulnerabilityReport
 * (aquasecurity.github.io/v1alpha1), as Trivy Operator writes one per
 * container of a workload. Only the fields read here.
 */
export interface VulnerabilityReport {
  metadata: { name: string; namespace?: string; labels?: Record<string, string>; creationTimestamp?: string };
  report?: {
    updateTimestamp?: string;
    registry?: { server?: string };
    artifact?: { repository?: string; tag?: string; digest?: string };
    summary?: { criticalCount?: number; highCount?: number; mediumCount?: number; lowCount?: number; unknownCount?: number };
    vulnerabilities?: TrivyVulnerability[];
  };
}

export interface TrivyVulnerability {
  vulnerabilityID?: string;
  severity?: string;
  score?: number;
  fixedVersion?: string;
  installedVersion?: string;
  resource?: string;
}

/** Reports older than this are ignored: Trivy Operator rescans daily by default (`scannerReportTTL`). */
export const MAX_REPORT_AGE_DAYS = 14;
/** Advisories kept per workload: the worst ten, plus the worst ten with a fix (they decide the severity). */
export const KEEP = 10;

/** A finding from Trivy carries the package it is in. */
export interface TrivyFinding extends Finding {
  pkg: string;
}

export type ScannedKind = 'Deployment' | 'StatefulSet' | 'DaemonSet' | 'CronJob';

export interface TrivyWorkload {
  /** `<namespace>/<kind>/<name>`, as the pods and workloads issues name a workload. */
  key: string;
  namespace: string;
  kind: ScannedKind;
  name: string;
  /** Container name to the image it runs now. */
  containers: Map<string, string>;
  podLabels?: Record<string, string>;
}

const workloadKey = (namespace: string, kind: string, name: string) => `${namespace}/${kind}/${name}`;

function containersOf(spec: PodSpecLite | undefined): Map<string, string> {
  return new Map([...(spec?.containers ?? []), ...(spec?.initContainers ?? [])].map((c) => [c.name, c.image]));
}

/** The workloads Trivy Operator's reports can name, by key. */
export function workloadIndex(inv: Inventory): Map<string, TrivyWorkload> {
  const index = new Map<string, TrivyWorkload>();
  const add = (kind: ScannedKind, namespace: string | undefined, name: string, spec: PodSpecLite | undefined, podLabels: Record<string, string> | undefined) => {
    const ns = namespace ?? 'default';
    index.set(workloadKey(ns, kind, name), { key: workloadKey(ns, kind, name), namespace: ns, kind, name, containers: containersOf(spec), podLabels });
  };
  for (const w of inv.deployments) {
    add('Deployment', w.metadata.namespace, w.metadata.name, w.spec?.template?.spec, w.spec?.template?.metadata?.labels);
  }
  for (const w of inv.statefulsets) {
    add('StatefulSet', w.metadata.namespace, w.metadata.name, w.spec?.template?.spec, w.spec?.template?.metadata?.labels);
  }
  for (const w of inv.daemonsets) {
    add('DaemonSet', w.metadata.namespace, w.metadata.name, w.spec?.template?.spec, w.spec?.template?.metadata?.labels);
  }
  for (const c of inv.cronjobs) {
    add('CronJob', c.metadata.namespace, c.metadata.name, c.spec?.jobTemplate?.spec?.template?.spec, undefined);
  }
  return index;
}

/**
 * The workload a report belongs to, from Trivy Operator's labels. A
 * Deployment is scanned through its ReplicaSet (`<deployment>-<pod template
 * hash>`). Bare pods, Jobs and anything no longer in the cluster: null.
 */
export function workloadOf(labels: Record<string, string> | undefined, index: Map<string, TrivyWorkload>): TrivyWorkload | null {
  const kind = labels?.['trivy-operator.resource.kind'];
  const name = labels?.['trivy-operator.resource.name'];
  const ns = labels?.['trivy-operator.resource.namespace'];
  if (!kind || !name || !ns) {
    return null;
  }
  if (kind === 'ReplicaSet') {
    const cut = name.lastIndexOf('-');
    return cut > 0 ? (index.get(workloadKey(ns, 'Deployment', name.slice(0, cut))) ?? null) : null;
  }
  return index.get(workloadKey(ns, kind, name)) ?? null;
}

/** "nginx:1.29" -> registry index.docker.io, repository library/nginx, tag 1.29. */
export function parseImage(image: string): { registry: string; repository: string; tag?: string; digest?: string } {
  const [ref, digest] = image.split('@');
  const slash = ref.indexOf('/');
  const first = slash > 0 ? ref.slice(0, slash) : '';
  const hasHost = first.includes('.') || first.includes(':') || first === 'localhost';
  let registry = hasHost ? first : 'index.docker.io';
  let rest = hasHost ? ref.slice(slash + 1) : ref;
  const colon = rest.lastIndexOf(':');
  const tag = colon > rest.lastIndexOf('/') ? rest.slice(colon + 1) : undefined;
  rest = tag !== undefined ? rest.slice(0, colon) : rest;
  if (registry === 'docker.io') {
    registry = 'index.docker.io';
  }
  const repository = registry === 'index.docker.io' && !rest.includes('/') ? `library/${rest}` : rest;
  return { registry, repository, ...(tag !== undefined ? { tag } : {}), ...(digest ? { digest } : {}) };
}

/**
 * Whether a report describes the image the container runs now: same
 * repository, and the same digest where both have one, else the same tag.
 * A report of an older image (the workload was updated since) is stale.
 * The registry host is not compared: a registry mirror in Trivy's settings
 * changes it.
 */
export function sameImage(running: string, artifact: { repository?: string; tag?: string; digest?: string } | undefined): boolean {
  if (!artifact?.repository) {
    return false;
  }
  const img = parseImage(running);
  const repo = artifact.repository.replace(/^docker\.io\//, '');
  if (img.repository !== repo && img.repository !== `library/${repo}`) {
    return false;
  }
  if (img.digest && artifact.digest) {
    return img.digest === artifact.digest;
  }
  return (img.tag ?? 'latest') === (artifact.tag || (img.digest ? undefined : 'latest'));
}

/** Trivy's own label; a score only where it says UNKNOWN. */
export function levelOfTrivy(v: TrivyVulnerability): Level {
  const s = v.severity?.toUpperCase();
  if (s === 'CRITICAL' || s === 'HIGH' || s === 'MEDIUM' || s === 'LOW') {
    return s.toLowerCase() as Level;
  }
  return typeof v.score === 'number' ? levelOfScore(v.score) : 'unknown';
}

/** Worst first; among equals the fixable one first, since a fix decides the severity. */
const order = (a: TrivyFinding, b: TrivyFinding) =>
  LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || Number(b.fixed !== null) - Number(a.fixed !== null) || (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id);

/** The worst KEEP findings, plus the worst KEEP with a fix: enough to judge and to show, never the whole list. */
export function keepTop(findings: TrivyFinding[]): TrivyFinding[] {
  const byId = new Map<string, TrivyFinding>();
  for (const f of findings) {
    const seen = byId.get(f.id);
    if (!seen || order(f, seen) < 0) {
      byId.set(f.id, f);
    }
  }
  const sorted = [...byId.values()].sort(order);
  const kept = new Set([...sorted.slice(0, KEEP), ...sorted.filter((f) => f.fixed !== null).slice(0, KEEP)]);
  return sorted.filter((f) => kept.has(f));
}

export type Counts = Record<Level, number>;
const zero = (): Counts => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });

/** What is kept of one container's report: counts and a few advisories, never the report. */
export interface ContainerScan {
  container: string;
  image: string;
  scannedAt: number;
  counts: Counts;
  findings: TrivyFinding[];
}

export function digestReport(r: VulnerabilityReport, container: string, scannedAt: number): ContainerScan {
  const s = r.report?.summary;
  const counts: Counts = { critical: s?.criticalCount ?? 0, high: s?.highCount ?? 0, medium: s?.mediumCount ?? 0, low: s?.lowCount ?? 0, unknown: s?.unknownCount ?? 0 };
  const findings = keepTop(
    (r.report?.vulnerabilities ?? [])
      .filter((v) => typeof v.vulnerabilityID === 'string' && v.vulnerabilityID.length > 0)
      .map((v) => ({
        id: v.vulnerabilityID!.slice(0, 80),
        level: levelOfTrivy(v),
        ...(typeof v.score === 'number' ? { score: v.score } : {}),
        fixed: v.fixedVersion?.trim() ? v.fixedVersion.trim().slice(0, 60) : null,
        pkg: (v.resource ?? '').slice(0, 60),
      })),
  );
  const a = r.report?.artifact;
  const image = `${a?.repository ?? '?'}${a?.tag ? `:${a.tag}` : a?.digest ? `@${a.digest.slice(0, 19)}` : ''}`;
  // Text from a resource anyone with write access to it could set: capped like Kyverno's messages.
  return { container, image: image.slice(0, 160), scannedAt, counts, findings };
}

/** One workload with its fresh container scans. */
export interface WorkloadScan {
  workload: TrivyWorkload;
  containers: Map<string, ContainerScan>;
}

export interface Collected {
  workloads: Map<string, WorkloadScan>;
  /** Too old, or of an image the workload no longer runs. */
  stale: number;
  /** Naming nothing Kubernanny can attach them to (bare pods, Jobs, cluster-scoped resources). */
  unmatched: number;
}

/**
 * Collects reports page by page: each one is digested at once and dropped,
 * so a cluster with thousands of reports costs a few advisories per
 * workload in memory, not the reports.
 */
export class TrivyCollector {
  private readonly result: Collected = { workloads: new Map(), stale: 0, unmatched: 0 };

  constructor(
    private readonly index: Map<string, TrivyWorkload>,
    private readonly now: Date,
  ) {}

  add(reports: VulnerabilityReport[]): void {
    for (const r of reports) {
      this.addOne(r);
    }
  }

  private addOne(r: VulnerabilityReport): void {
    const workload = workloadOf(r.metadata.labels, this.index);
    const container = r.metadata.labels?.['trivy-operator.container.name'];
    if (!workload || !container) {
      this.result.unmatched++;
      return;
    }
    const scannedAt = Date.parse(r.report?.updateTimestamp ?? r.metadata.creationTimestamp ?? '');
    const running = workload.containers.get(container);
    const fresh = Number.isFinite(scannedAt) && this.now.getTime() - scannedAt <= MAX_REPORT_AGE_DAYS * 86_400_000;
    if (!fresh || !running || !sameImage(running, r.report?.artifact)) {
      this.result.stale++;
      return;
    }
    const scan = this.result.workloads.get(workload.key) ?? { workload, containers: new Map() };
    const earlier = scan.containers.get(container);
    if (earlier && earlier.scannedAt >= scannedAt) {
      this.result.stale++;
      return;
    }
    if (earlier) {
      this.result.stale++;
    }
    scan.containers.set(container, digestReport(r, container, scannedAt));
    this.result.workloads.set(workload.key, scan);
  }

  collected(): Collected {
    return this.result;
  }
}

/** One workload's advisories, ready to judge: counts summed over its containers, findings merged. */
export interface WorkloadFindings {
  workload: TrivyWorkload;
  /** The acceptance component: `trivy:<namespace>:<kind>:<name>`. */
  component: string;
  reachable: boolean;
  counts: Counts;
  findings: TrivyFinding[];
  images: string[];
  scannedAt: number;
  accepted?: number;
}

/** Has a Service an Ingress, HTTPRoute or IngressRoute points at: reachable from outside the cluster network. */
export function reachable(inv: Inventory, w: TrivyWorkload): boolean {
  return w.podLabels !== undefined && ingressUrls(inv, servicesOf(inv, w.namespace, w.podLabels)).length > 0;
}

export function workloadFindings(inv: Inventory, scan: WorkloadScan): WorkloadFindings {
  const containers = [...scan.containers.values()];
  const counts = zero();
  for (const c of containers) {
    for (const level of Object.keys(counts) as Level[]) {
      counts[level] += c.counts[level];
    }
  }
  const w = scan.workload;
  return {
    workload: w,
    component: trivyComponentKey(w.namespace, w.kind, w.name),
    reachable: reachable(inv, w),
    counts,
    findings: keepTop(containers.flatMap((c) => c.findings)),
    images: [...new Set(containers.map((c) => c.image))],
    scannedAt: Math.min(...containers.map((c) => c.scannedAt)),
  };
}

/** Takes accepted advisories out, like the built-in lookup: they stop counting for the issue, the light and the stats. */
export function acceptTrivy(items: WorkloadFindings[], accepted: ReadonlyMap<string, Acceptance>): { items: WorkloadFindings[]; accepted: AcceptedAdvisory[] } {
  const list: AcceptedAdvisory[] = [];
  const kept = items.map((w) => {
    const remaining = w.findings.filter((f) => !accepted.has(acceptanceKey(w.component, f.id)));
    if (remaining.length === w.findings.length) {
      return w;
    }
    const counts = { ...w.counts };
    for (const f of w.findings.filter((x) => !remaining.includes(x))) {
      const a = accepted.get(acceptanceKey(w.component, f.id))!;
      counts[f.level] = Math.max(0, counts[f.level] - 1);
      list.push({ component: w.component, name: w.workload.name, advisory: f.id, until: new Date(a.until).toISOString(), by: a.by, ...(a.reason ? { reason: a.reason } : {}) });
    }
    return { ...w, counts, findings: remaining, accepted: w.findings.length - remaining.length };
  });
  return { items: kept, accepted: list };
}

export const total = (c: Counts) => c.critical + c.high + c.medium + c.low + c.unknown;

/** One issue per workload with advisories, judged by the built-in lookup's rules (`issueSeverity`). */
export function trivyIssue(w: WorkloadFindings, now: Date): Issue | null {
  const n = Math.max(total(w.counts), w.findings.length);
  if (n === 0) {
    return null;
  }
  const severity = issueSeverity(w.findings, w.reachable);
  const parts: Text[] = [];
  const worst = w.findings.slice(0, 3).map((f) => t('vulnerabilities.advisory', { id: f.id, rating: scoreText(f) }));
  if (worst.length) {
    parts.push(n === 1 ? t('vulnerabilities.worst.one', { advisories: worst }) : t('vulnerabilities.worst.many', { advisories: worst }));
  }
  const fixable = w.findings.filter((f) => f.fixed !== null);
  const packages = [...new Set(fixable.map((f) => (f.pkg ? `${f.pkg} ${f.fixed}` : f.fixed!)))].slice(0, 3);
  if (packages.length === 0) {
    parts.push(t('vulnerabilities.noFix'));
  } else {
    parts.push(fixable.length === w.findings.length ? t('trivy.fixed', { packages }) : t('trivy.fixedSome', { packages }));
  }
  if (severity === 'critical') {
    parts.push(t('vulnerabilities.exposed'));
  }
  parts.push(t('trivy.scanned', { images: w.images.slice(0, 2), age: ageText(now.getTime() - w.scannedAt) }));
  if (w.accepted) {
    parts.push(t('vulnerabilities.acceptedNote', { n: w.accepted }));
  }
  const { namespace, kind, name } = w.workload;
  return {
    id: `trivy/${namespace}/${kind}/${name}`,
    check: 'trivy',
    severity,
    title: t('trivy.title', { kind, name, namespace, n }),
    cause: t('common.sentences', { parts }),
    actions: [],
    advisories: w.findings.slice(0, 20).map((f) => f.id),
  };
}
