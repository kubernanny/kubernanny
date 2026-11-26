import { t } from '../i18n/text';
import { cpuMilli, Inventory, parseQuantity } from '../inventory/inventory';
import type { HistoryView, Series } from '../views/history';

/**
 * CPU and memory over the last week, from metrics-server, for clusters
 * without Prometheus: the agent reads `metrics.k8s.io` on every run anyway.
 * Per node and for the whole cluster, in 5-minute buckets (average and peak
 * of the runs in the bucket), as a share of what is allocatable.
 *
 * Size, so the ConfigMap `kubernanny-history` stays well under its 1 MiB:
 * one value is 12 bits in two base64url characters (0.1 % steps up to
 * 409.4 %), a bucket has four (CPU average and peak, memory average and
 * peak), a week has 2016 buckets: 4 x 2016 x 2 = 16 128 characters per
 * series, plus at most ~330 for the node name and the allocatable figures.
 * The cluster totals and the MAX_NODES = 20 busiest nodes are 21 series, at
 * most 21 x 16 461 = 345 681 bytes, under MAX_METRICS_BYTES (384 KiB); the
 * episode log has its own 384 KiB (history-store.ts), 768 KiB in all.
 */
export const BUCKET_MS = 5 * 60_000;
/** Seven days of 5-minute buckets. */
export const BUCKETS = (7 * 86_400_000) / BUCKET_MS;
/** Nodes stored (the busiest by average use over the week); the cluster totals always are. */
export const MAX_NODES = 20;
/** Nodes followed in memory: a node climbs into the stored ones only with a history of its own. */
export const MEMORY_NODES = 4 * MAX_NODES;
/** The `metrics` key of `kubernanny-history` at most. */
export const MAX_METRICS_BYTES = 384 * 1024;
/** About this many points per chart, whatever the range (as from Prometheus). */
const POINTS = 120;

const MISSING = 4095;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DIGIT = new Map([...ALPHABET].map((c, i) => [c, i]));
/** Order of the four values of a bucket. */
const CPU_AVG = 0;
const CPU_MAX = 1;
const MEM_AVG = 2;
const MEM_MAX = 3;

interface Acc {
  bucket: number;
  cpuN: number;
  memN: number;
  cpu: number;
  mem: number;
  cpuMax: number;
  memMax: number;
}

/** One series (a node or the cluster): a ring of the last BUCKETS buckets. */
class Ring {
  /** The bucket number (ms / BUCKET_MS) each slot holds, -1 for none. */
  readonly bucket = new Int32Array(BUCKETS).fill(-1);
  readonly values = new Uint16Array(4 * BUCKETS).fill(MISSING);
  cpuAllocMilli = 0;
  memAllocBytes = 0;
  /** The bucket under way: its runs so far, for a true average and peak. */
  private acc: Acc | null = null;

  get(b: number, which: number): number | null {
    const slot = b % BUCKETS;
    if (this.bucket[slot] !== b) {
      return null;
    }
    const v = this.values[slot * 4 + which]!;
    return v === MISSING ? null : v;
  }

  set(b: number, vals: readonly number[]): void {
    const slot = b % BUCKETS;
    this.bucket[slot] = b;
    for (let i = 0; i < 4; i++) {
      this.values[slot * 4 + i] = vals[i]!;
    }
  }

  add(b: number, cpu: number | null, mem: number | null): void {
    if (this.acc?.bucket !== b) {
      // A bucket read back from the store counts as one run, so a restart within it keeps what it had.
      const cpu0 = this.get(b, CPU_AVG);
      const mem0 = this.get(b, MEM_AVG);
      this.acc = {
        bucket: b,
        cpuN: cpu0 === null ? 0 : 1,
        memN: mem0 === null ? 0 : 1,
        cpu: cpu0 ?? 0,
        mem: mem0 ?? 0,
        cpuMax: this.get(b, CPU_MAX) ?? -1,
        memMax: this.get(b, MEM_MAX) ?? -1,
      };
    }
    const a = this.acc;
    if (cpu !== null) {
      a.cpuN++;
      a.cpu += cpu;
      a.cpuMax = Math.max(a.cpuMax, cpu);
    }
    if (mem !== null) {
      a.memN++;
      a.mem += mem;
      a.memMax = Math.max(a.memMax, mem);
    }
    this.set(b, [
      a.cpuN ? Math.round(a.cpu / a.cpuN) : MISSING,
      a.cpuMax < 0 ? MISSING : a.cpuMax,
      a.memN ? Math.round(a.mem / a.memN) : MISSING,
      a.memMax < 0 ? MISSING : a.memMax,
    ]);
  }

  /** Average use (CPU and memory together) over the buckets of the window; -1 without any. */
  score(current: number): number {
    let sum = 0;
    let n = 0;
    for (let b = current - BUCKETS + 1; b <= current; b++) {
      const c = this.get(b, CPU_AVG);
      const m = this.get(b, MEM_AVG);
      if (c !== null || m !== null) {
        sum += ((c ?? 0) + (m ?? 0)) / 2;
        n++;
      }
    }
    return n ? sum / n : -1;
  }

  encode(current: number): string {
    let out = '';
    for (let which = 0; which < 4; which++) {
      for (let b = current - BUCKETS + 1; b <= current; b++) {
        const v = this.get(b, which) ?? MISSING;
        out += ALPHABET[v >> 6]! + ALPHABET[v & 63]!;
      }
    }
    return out;
  }

  /** Fills the buckets this ring does not have from an encoded week ending at `end`; false when it does not decode. */
  decodeInto(text: string, end: number, current: number): boolean {
    if (text.length !== 8 * BUCKETS || /[^A-Za-z0-9_-]/.test(text)) {
      return false;
    }
    for (let i = 0; i < BUCKETS; i++) {
      const b = end - BUCKETS + 1 + i;
      if (b <= current - BUCKETS || b > current || this.get(b, CPU_AVG) !== null || this.get(b, MEM_AVG) !== null) {
        continue;
      }
      const vals = [0, 1, 2, 3].map((which) => {
        const at = (which * BUCKETS + i) * 2;
        return DIGIT.get(text[at]!)! * 64 + DIGIT.get(text[at + 1]!)!;
      });
      if (vals.some((v) => v !== MISSING)) {
        this.set(b, vals);
      }
    }
    return true;
  }
}

/** A share (0.42) as stored: tenths of a percent, capped below the missing mark. */
function quantize(ratio: number): number {
  return Math.min(MISSING - 1, Math.max(0, Math.round(ratio * 1000)));
}

interface StoredSeries {
  /** Node name; '' for the cluster totals. */
  n: string;
  /** Allocatable CPU (millicores) and memory (bytes) at the last run. */
  c: number;
  m: number;
  /** CPU average, CPU peak, memory average, memory peak: BUCKETS values each, two characters per value. */
  d: string;
}

interface Stored {
  v: 1;
  /** Bucket length in seconds. */
  step: number;
  /** The bucket number (ms / BUCKET_MS) of the last bucket of every series. */
  end: number;
  s: StoredSeries[];
}

export class MetricsRecorder {
  private readonly cluster = new Ring();
  private readonly nodes = new Map<string, Ring>();

  /** One run's metrics-server reading; a run without one adds nothing. */
  sample(now: number, inv: Inventory): void {
    const usage = inv.nodeUsage;
    if (!usage || usage.size === 0) {
      return;
    }
    const b = Math.floor(now / BUCKET_MS);
    let cpuAlloc = 0;
    let memAlloc = 0;
    let cpuUsed = 0;
    let memUsed = 0;
    const readings: { name: string; cpu: number | null; mem: number | null; c: number; m: number }[] = [];
    for (const n of inv.nodes) {
      // The same sums as the overview's figures (snapshot.ts buildOverview).
      const c = cpuMilli(n.status?.allocatable?.cpu);
      const m = parseQuantity(n.status?.allocatable?.memory);
      const u = usage.get(n.metadata.name);
      cpuAlloc += c;
      memAlloc += m;
      cpuUsed += u?.cpuMilli ?? 0;
      memUsed += u?.memBytes ?? 0;
      if (u) {
        readings.push({
          name: n.metadata.name,
          cpu: c > 0 ? quantize(u.cpuMilli / c) : null,
          mem: m > 0 ? quantize(u.memBytes / m) : null,
          c,
          m,
        });
      }
    }
    this.cluster.cpuAllocMilli = cpuAlloc;
    this.cluster.memAllocBytes = memAlloc;
    this.cluster.add(
      b,
      cpuAlloc > 0 ? quantize(cpuUsed / cpuAlloc) : null,
      memAlloc > 0 ? quantize(memUsed / memAlloc) : null,
    );
    this.admit(readings, b);
    for (const r of readings) {
      const ring = this.nodes.get(r.name);
      if (ring) {
        ring.cpuAllocMilli = r.c;
        ring.memAllocBytes = r.m;
        ring.add(b, r.cpu, r.mem);
      }
    }
    this.prune(b);
  }

  /**
   * Keeps at most MEMORY_NODES nodes in memory: the ones followed already and
   * the busiest new ones, ranked by their week (a new node by this reading).
   */
  private admit(readings: { name: string; cpu: number | null; mem: number | null }[], b: number): void {
    const fresh = readings.filter((r) => !this.nodes.has(r.name));
    if (fresh.length === 0) {
      return;
    }
    const now = (r: { cpu: number | null; mem: number | null }) => ((r.cpu ?? 0) + (r.mem ?? 0)) / 2;
    if (this.nodes.size + fresh.length <= MEMORY_NODES) {
      for (const r of fresh) {
        this.nodes.set(r.name, new Ring());
      }
      return;
    }
    const candidates = [
      ...[...this.nodes].map(([name, ring]) => ({ name, score: ring.score(b), ring })),
      ...fresh
        .sort((x, y) => now(y) - now(x))
        .slice(0, MEMORY_NODES)
        .map((r) => ({ name: r.name, score: now(r), ring: null })),
    ].sort((x, y) => y.score - x.score);
    const keep = candidates.slice(0, MEMORY_NODES);
    this.nodes.clear();
    for (const c of keep) {
      this.nodes.set(c.name, c.ring ?? new Ring());
    }
  }

  /** Forgets nodes with nothing left in the week (removed from the cluster a week ago). */
  private prune(b: number): void {
    for (const [name, ring] of this.nodes) {
      if (ring.score(b) < 0) {
        this.nodes.delete(name);
      }
    }
  }

  /** The nodes followed in memory (tests). */
  nodeNames(): string[] {
    return [...this.nodes.keys()];
  }

  /**
   * The charts for the last `hours` (at most a week): the cluster's CPU and
   * memory and each node's, ~120 points, each the average of its buckets
   * (`max` the peak). Series without data are left out.
   */
  view(hours: number, now: number): HistoryView {
    const h = Math.min(Math.max(hours, 1), 168);
    const current = Math.floor(now / BUCKET_MS);
    const first = current - Math.ceil((h * 3_600_000) / BUCKET_MS) + 1;
    const per = Math.max(1, Math.ceil((h * 3_600_000) / POINTS / BUCKET_MS));
    const lines = (ring: Ring, avg: number, max: number): { points: [number, number][]; max: [number, number][] } => {
      const points: [number, number][] = [];
      const peaks: [number, number][] = [];
      // Groups aligned to whole multiples of `per` buckets, so a chart does not shift between two loads.
      for (let g = Math.floor(first / per) * per; g <= current; g += per) {
        let sum = 0;
        let n = 0;
        let peak = -1;
        for (let b = Math.max(g, first); b < g + per && b <= current; b++) {
          const a = ring.get(b, avg);
          if (a !== null) {
            sum += a;
            n++;
          }
          peak = Math.max(peak, ring.get(b, max) ?? -1);
        }
        if (n > 0) {
          const at = Math.min(now, (g + per) * BUCKET_MS);
          points.push([at, sum / n / 1000]);
          peaks.push([at, Math.max(peak, sum / n) / 1000]);
        }
      }
      return { points, max: peaks };
    };
    const series: Series[] = [];
    const push = (id: string, label: Series['label'], ring: Ring, avg: number, max: number) => {
      const l = lines(ring, avg, max);
      if (l.points.length) {
        series.push({ id, label, unit: 'ratio', points: l.points, max: l.max });
      }
    };
    push('cpu', t('history.cpu'), this.cluster, CPU_AVG, CPU_MAX);
    push('memory', t('history.memory'), this.cluster, MEM_AVG, MEM_MAX);
    for (const [name, ring] of this.nodes) {
      push(`node-cpu:${name}`, t('history.cpu'), ring, CPU_AVG, CPU_MAX);
      push(`node-memory:${name}`, t('history.memory'), ring, MEM_AVG, MEM_MAX);
    }
    return { source: 'agent', hours: h, stepSeconds: (per * BUCKET_MS) / 1000, series };
  }

  /** Compact JSON for the ConfigMap: the cluster totals and the busiest MAX_NODES nodes, under MAX_METRICS_BYTES. */
  serialize(now: number): string {
    const current = Math.floor(now / BUCKET_MS);
    const ranked = [...this.nodes]
      .map(([name, ring]) => ({ name, ring, score: ring.score(current) }))
      .filter((n) => n.score >= 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, MAX_NODES);
    const one = (name: string, ring: Ring): StoredSeries => ({
      n: name,
      c: ring.cpuAllocMilli,
      m: ring.memAllocBytes,
      d: ring.encode(current),
    });
    const series = [
      ...(this.cluster.score(current) >= 0 ? [one('', this.cluster)] : []),
      ...ranked.map((n) => one(n.name, n.ring)),
    ];
    for (;;) {
      const text = JSON.stringify({ v: 1, step: BUCKET_MS / 1000, end: current, s: series } satisfies Stored);
      if (text.length <= MAX_METRICS_BYTES || series.length <= 1) {
        return text;
      }
      series.pop();
    }
  }

  /**
   * Takes in a stored week: buckets this recorder has are kept, the others
   * come from the store. Returns false when the text is not ours (then
   * nothing is taken over).
   */
  restore(text: string, now: number): boolean {
    let stored: Partial<Stored> | null;
    try {
      stored = JSON.parse(text) as Partial<Stored> | null;
    } catch {
      return false;
    }
    if (
      stored?.v !== 1 ||
      stored.step !== BUCKET_MS / 1000 ||
      !Number.isInteger(stored.end) ||
      !Array.isArray(stored.s) ||
      stored.s.length > MAX_NODES + 1
    ) {
      return false;
    }
    const current = Math.floor(now / BUCKET_MS);
    const end = stored.end!;
    let ok = true;
    for (const s of stored.s) {
      if (
        typeof s?.n !== 'string' ||
        s.n.length > 253 ||
        typeof s.d !== 'string' ||
        !Number.isFinite(s.c) ||
        !Number.isFinite(s.m)
      ) {
        ok = false;
        continue;
      }
      let ring = s.n === '' ? this.cluster : this.nodes.get(s.n);
      const added = !ring;
      ring ??= new Ring();
      if (!ring.decodeInto(s.d, end, current)) {
        ok = false;
        continue;
      }
      if (!ring.cpuAllocMilli) {
        ring.cpuAllocMilli = s.c;
        ring.memAllocBytes = s.m;
      }
      if (added && this.nodes.size < MEMORY_NODES && ring.score(current) >= 0) {
        this.nodes.set(s.n, ring);
      }
    }
    return ok;
  }
}
