import type { Config } from '../config';
import { raw, reviveText, Text } from '../i18n/text';
import { IncidentsService } from '../incidents/incidents.service';
import { KubeClient, KubeError } from '../kube/kube-client';
import { Logger } from '../logger';
import type { Episode } from '../notify/digest';
import { Serial } from '../util/serial';
import { MAX_METRICS_BYTES, MetricsRecorder } from './metrics-recorder';

/** Created empty by the chart and install.yaml, so `helm uninstall` removes it; the agent only reads and patches it. */
export const HISTORY_CONFIGMAP = 'kubernanny-history';
/** The episode log (the week of problems behind the overview's strip, `GET /incidents` and the weekly report). */
export const EPISODES_KEY = 'episodes';
/** The agent's own CPU and memory record (history/metrics-recorder.ts). */
export const METRICS_KEY = 'metrics';
/** The `episodes` key at most; with the metrics' 384 KiB the ConfigMap stays at 768 KiB, under its 1 MiB. */
export const MAX_EPISODES_BYTES = 384 * 1024;
/** At most one write a minute (plus the last one on SIGTERM). */
export const MIN_WRITE_GAP_MS = 60_000;
/** SIGTERM waits this long for the last write, then hands over anyway. */
const FLUSH_TIMEOUT_MS = 5_000;

interface StoredEpisode {
  /** Issue id. */
  i: string;
  /** The title as message key with parameters, so it reads in either language. */
  t: Text;
  s: 'w' | 'c';
  /** Module that reported it. */
  m: string;
  /** Start and end (ms); no `b` while open. */
  a: number;
  b?: number;
  /** Silenced at some point. */
  q?: 1;
}

interface StoredEpisodes {
  v: 1;
  /** When the agent first started watching this cluster (ms). */
  since: number;
  /** Oldest start first. */
  e: StoredEpisode[];
}

/**
 * Compact JSON of the episode log, oldest first, capped at MAX_EPISODES_BYTES
 * by dropping the oldest ended episodes; open ones go only if they alone are
 * too many (which the log's own cap of 5 000 makes all but impossible).
 */
export function serializeEpisodes(since: number, episodes: readonly Episode[]): string {
  const parts = episodes.map((e) => {
    const s: StoredEpisode = { i: e.id, t: e.title, s: e.severity === 'critical' ? 'c' : 'w', m: e.module, a: e.start };
    if (e.end !== null) {
      s.b = e.end;
    }
    if (e.silenced) {
      s.q = 1;
    }
    return { open: e.end === null, json: JSON.stringify(s) };
  });
  const head = `{"v":1,"since":${since},"e":[`;
  let size = head.length + 2 + parts.reduce((n, p) => n + p.json.length + 1, 0);
  const drop = new Set<number>();
  for (const pass of [false, true]) {
    for (let i = 0; i < parts.length && size > MAX_EPISODES_BYTES; i++) {
      if (!drop.has(i) && (pass || !parts[i]!.open)) {
        drop.add(i);
        size -= parts[i]!.json.length + 1;
      }
    }
  }
  return `${head}${parts
    .filter((_, i) => !drop.has(i))
    .map((p) => p.json)
    .join(',')}]}`;
}

/**
 * The stored log, or null when the text is not ours (bad JSON, another
 * version, too large). Single entries that do not parse are dropped; a title
 * whose message key this version no longer knows reads as the issue id.
 */
export function parseEpisodes(text: string): { since: number; episodes: Episode[] } | null {
  if (text.length > MAX_EPISODES_BYTES) {
    return null;
  }
  let stored: Partial<StoredEpisodes> | null;
  try {
    stored = JSON.parse(text) as Partial<StoredEpisodes> | null;
  } catch {
    return null;
  }
  if (stored?.v !== 1 || !Number.isFinite(stored.since) || !Array.isArray(stored.e)) {
    return null;
  }
  const episodes: Episode[] = [];
  for (const e of stored.e as Partial<StoredEpisode>[]) {
    if (
      typeof e?.i !== 'string' ||
      e.i.length > 512 ||
      typeof e.m !== 'string' ||
      e.m.length > 128 ||
      (e.s !== 'w' && e.s !== 'c') ||
      !Number.isFinite(e.a) ||
      (e.b !== undefined && !(Number.isFinite(e.b) && e.b! >= e.a!))
    ) {
      continue;
    }
    episodes.push({
      id: e.i,
      title: reviveText(e.t) ?? raw(e.i),
      severity: e.s === 'c' ? 'critical' : 'warning',
      module: e.m,
      start: e.a!,
      end: e.b ?? null,
      silenced: e.q === 1,
    });
  }
  return { since: stored.since!, episodes: episodes.sort((a, b) => a.start - b.start) };
}

/**
 * Keeps the problem history and the agent's own CPU and memory record in the
 * ConfigMap `kubernanny-history`, so a restart or a rollout continues the
 * week instead of starting it again (`history.persist`, HISTORY_PERSIST).
 *
 * - Every pod reads it at start, before it serves anything.
 * - Only the pod in charge (the lease holder) writes: at most once a minute,
 *   after a run, and once more on SIGTERM before it releases the lease.
 * - On a takeover the new pod reads it again and merges what the previous
 *   pod wrote last.
 * - What does not parse, or is too large, is logged once and replaced; a read
 *   that fails for another reason is retried before the first write, so a
 *   short API outage never overwrites a week with an empty one.
 */
export class HistoryStore {
  private readonly logger = new Logger('history');
  private readonly writes = new Serial();
  private readonly warned = new Set<string>();
  /** True once the store was read (or found missing or unreadable as ours): writing cannot lose anything then. */
  private loaded = false;
  private lastWritten: Record<string, string> = {};
  private lastWriteAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly config: Config,
    private readonly kube: KubeClient,
    private readonly incidents: IncidentsService,
    private readonly metrics: MetricsRecorder,
    /** The pod in charge: holds the lease and has current state. */
    private readonly isLeader: () => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  get enabled(): boolean {
    return this.config.historyPersist !== false && !this.config.demo;
  }

  private get path(): string {
    return `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}/configmaps/${HISTORY_CONFIGMAP}`;
  }

  /** Reads and merges the stored history. Never throws. */
  async load(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    let data: Record<string, string> | undefined;
    try {
      data = (await this.kube.get<{ data?: Record<string, string> | null }>(this.path)).data ?? undefined;
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) {
        this.warnOnce('missing', `ConfigMap ${HISTORY_CONFIGMAP} not found: the history is kept in memory only`);
        this.loaded = true;
      } else {
        this.warnOnce('read', `cannot read the stored history (${errorMessage(err)}); trying again before writing`);
      }
      return;
    }
    this.loaded = true;
    const now = this.now();
    const episodes = data?.[EPISODES_KEY];
    if (episodes) {
      const parsed = parseEpisodes(episodes);
      if (parsed) {
        this.incidents.merge(parsed, now);
      } else {
        this.warnOnce(
          'episodes',
          `stored problem history unreadable or too large (${episodes.length} bytes): starting fresh`,
        );
      }
    }
    const metrics = data?.[METRICS_KEY];
    if (metrics) {
      if (metrics.length > MAX_METRICS_BYTES || !this.metrics.restore(metrics, now)) {
        this.warnOnce(
          'metrics',
          `stored CPU and memory record unreadable or too large (${metrics.length} bytes): starting fresh`,
        );
      }
    }
  }

  /** After a run: writes within the minute when this pod is in charge and something changed. */
  schedule(): void {
    if (!this.enabled || this.stopped || this.timer || !this.isLeader()) {
      return;
    }
    const wait = Math.max(0, this.lastWriteAt + MIN_WRITE_GAP_MS - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.save();
    }, wait);
    this.timer.unref?.();
  }

  /** SIGTERM: the last write, while this pod still holds the lease (at most FLUSH_TIMEOUT_MS). */
  async flush(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.enabled) {
      return;
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.save(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, FLUSH_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
    clearTimeout(timeout);
  }

  /** Writes what changed. Only the pod in charge; never throws. */
  save(): Promise<void> {
    return this.writes.run(async () => {
      if (!this.enabled || !this.isLeader()) {
        return;
      }
      if (!this.loaded) {
        await this.load();
        if (!this.loaded) {
          return;
        }
      }
      const now = this.now();
      const data: Record<string, string> = {
        [EPISODES_KEY]: serializeEpisodes(this.incidents.since, this.incidents.all()),
        [METRICS_KEY]: this.metrics.serialize(now),
      };
      const changed = Object.fromEntries(Object.entries(data).filter(([k, v]) => this.lastWritten[k] !== v));
      this.lastWriteAt = now;
      if (Object.keys(changed).length === 0) {
        return;
      }
      try {
        await this.kube.mergePatch(this.path, { data: changed });
        this.lastWritten = { ...this.lastWritten, ...changed };
        this.warned.delete('write');
      } catch (err) {
        if (err instanceof KubeError && err.status === 404) {
          this.warnOnce('missing', `ConfigMap ${HISTORY_CONFIGMAP} not found: the history is kept in memory only`);
        } else {
          this.warnOnce('write', `cannot store the history (${errorMessage(err)})`);
        }
      }
    });
  }

  /** In charge after a handover: what the previous pod wrote last joins this pod's own record. */
  async takeOver(): Promise<void> {
    this.loaded = false;
    this.lastWritten = {};
    await this.writes.run(() => this.load());
  }

  private warnOnce(key: string, message: string): void {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
