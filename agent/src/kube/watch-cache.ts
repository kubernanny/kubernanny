import { Logger } from '../logger';
import { KubeError } from './kube-client';

/** What a watch cache needs from the API: a list (with its resourceVersion) and a watch stream. */
export interface WatchApi {
  get<T>(path: string): Promise<T>;
  watch(path: string, signal: AbortSignal): Promise<Response>;
}

export type WatchEventType = 'ADDED' | 'MODIFIED' | 'DELETED';

export interface Keyed {
  metadata: { name: string; namespace?: string; resourceVersion?: string };
}

export interface WatchCacheOptions<T extends Keyed> {
  /** Name in logs and in the inventory ("pods"). */
  kind: string;
  /** The collection, optionally with a selector: `/api/v1/events?fieldSelector=type%3DWarning`. */
  path: string;
  /** Keeps only what the checks read (managedFields, most annotations, env … go). */
  strip(obj: unknown): T;
  /** False drops the object (events past their age). Checked on every write and on every read. */
  keep?(obj: T, now: number): boolean;
  /** At most this many objects; past it the oldest by `age` go first. */
  maxItems?: number;
  /** Larger is newer; used for `maxItems`. */
  age?(obj: T): number;
  /** Every change after the first list, also the differences a relist finds. */
  onChange?(type: WatchEventType, prev: T | undefined, next: T | undefined): void;
  /** Full relist as a safety net against missed events (default 15 min). */
  resyncMs?: number;
  /** Server-side end of one watch request (default about 5 min, with jitter). */
  watchTimeoutSeconds?: number;
  pageSize?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  now?(): number;
}

/**
 * - `starting`: the first list has not finished.
 * - `synced`: a complete list is in memory and kept current by the watch.
 * - `absent`: the API answered 404 (the resource does not exist here): empty, and that is the truth.
 * - `failed`: the list failed, or the watch failed several times in a row:
 *   the objects in memory (if any) are the last known, not the current state.
 */
export type CacheState = 'starting' | 'synced' | 'absent' | 'failed';

/** A watch event that says the resourceVersion is too old to resume from (410 Gone): relist. */
class Gone extends Error {}

const MAX_LINE = 16 * 1024 * 1024;
/** Consecutive watch failures before the cache stops vouching for its contents. */
const FAILURES_BEFORE_UNUSABLE = 3;

interface ListBody {
  metadata?: { resourceVersion?: string; continue?: string };
  items?: unknown[];
}

/**
 * One kind of object, kept current by list + watch (an informer without a
 * client library): list (paged) to get everything and a resourceVersion,
 * then watch from that version with bookmarks; reconnect with backoff,
 * relist on 410 Gone, and relist everything every `resyncMs` anyway.
 * Objects are stripped to the fields the checks read before they are stored,
 * so memory follows the cluster's size, not its objects' verbosity.
 */
export class WatchCache<T extends Keyed> {
  state: CacheState = 'starting';
  lastError: string | null = null;
  resourceVersion: string | undefined;
  /** Counters for tests and diagnostics. */
  readonly stats = { lists: 0, watches: 0, events: 0, relistsAfterGone: 0 };

  private readonly logger: Logger;
  private readonly store = new Map<string, T>();
  private view: T[] | null = null;
  private stopped = true;
  private listedOnce = false;
  private needList = true;
  private failures = 0;
  private abort: AbortController | null = null;
  private resyncTimer: ReturnType<typeof setInterval> | null = null;
  private wakeUp: (() => void) | null = null;
  private firstList: Promise<void>;
  private firstListDone!: () => void;

  constructor(
    private readonly api: WatchApi,
    private readonly options: WatchCacheOptions<T>,
  ) {
    this.logger = new Logger(`watch ${options.kind}`);
    this.firstList = new Promise((resolve) => (this.firstListDone = resolve));
  }

  /** True when the contents are the cluster's current state (or the resource does not exist). */
  get usable(): boolean {
    return this.state === 'synced' || this.state === 'absent';
  }

  /** Resolves once the first list finished, successfully or not. */
  ready(): Promise<void> {
    return this.firstList;
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    const resync = this.options.resyncMs ?? 15 * 60_000;
    this.resyncTimer = setInterval(() => this.resync(), resync);
    this.resyncTimer.unref?.();
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.resyncTimer) {
      clearInterval(this.resyncTimer);
    }
    this.abort?.abort();
    this.wakeUp?.();
    this.firstListDone();
  }

  /** Relists on the next turn (the periodic safety net, or a caller that doubts the contents). */
  resync(): void {
    this.needList = true;
    this.abort?.abort();
    this.wakeUp?.();
  }

  items(): T[] {
    if (!this.view) {
      const now = this.now();
      const keep = this.options.keep;
      this.view = [...this.store.values()].filter((o) => !keep || keep(o, now));
    }
    return this.view;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async loop(): Promise<void> {
    let backoff = this.options.minBackoffMs ?? 1000;
    const maxBackoff = this.options.maxBackoffMs ?? 30_000;
    while (!this.stopped) {
      if (this.needList) {
        try {
          await this.list();
          this.needList = false;
          this.failures = 0;
          backoff = this.options.minBackoffMs ?? 1000;
        } catch (err) {
          if (err instanceof KubeError && err.status === 404) {
            this.replace([], undefined);
            this.state = 'absent';
            this.lastError = null;
            this.firstListDone();
            // It may be installed later: look again with the resync.
            await this.sleep(this.options.resyncMs ?? 15 * 60_000);
            continue;
          }
          this.fail(err);
          this.firstListDone();
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, maxBackoff);
          continue;
        }
        this.firstListDone();
      }
      const opened = Date.now();
      const eventsBefore = this.stats.events;
      try {
        await this.watchOnce();
        if (this.stats.events === eventsBefore && Date.now() - opened < 1000) {
          // Ended at once with nothing in it: not a timeout, a server that will not watch. Back off.
          await this.sleep(backoff);
          backoff = Math.min(backoff * 2, maxBackoff);
          continue;
        }
        // The server ended the watch (timeoutSeconds): resume at once from the last version.
        this.failures = 0;
        backoff = this.options.minBackoffMs ?? 1000;
      } catch (err) {
        if (this.stopped) {
          break;
        }
        if (err instanceof Gone) {
          this.stats.relistsAfterGone++;
          this.needList = true;
          if (this.stats.events - eventsBefore <= 1) {
            // Gone right after a fresh list: do not spin on a server that keeps saying so.
            await this.sleep(backoff);
            backoff = Math.min(backoff * 2, maxBackoff);
          }
          continue;
        }
        if (this.needList) {
          continue; // aborted for a resync
        }
        this.failures++;
        if (this.failures >= FAILURES_BEFORE_UNUSABLE) {
          this.fail(err);
        } else {
          this.logger.debug(`watch interrupted: ${message(err)}`);
        }
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, maxBackoff);
      }
    }
  }

  private fail(err: unknown): void {
    if (this.state !== 'failed') {
      this.logger.warn(`${this.store.size ? 'keeping the last known objects' : 'nothing read yet'}: ${message(err)}`);
    }
    this.state = 'failed';
    this.lastError = message(err);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const jitter = Math.round(ms * 0.2 * Math.random());
      const timer = setTimeout(done, ms + jitter);
      timer.unref?.();
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wakeUp = () => {
        this.wakeUp = null;
        done();
      };
    });
  }

  private async list(): Promise<void> {
    this.stats.lists++;
    const sep = this.options.path.includes('?') ? '&' : '?';
    const limit = this.options.pageSize ?? 500;
    const items: T[] = [];
    let token: string | undefined;
    let version: string | undefined;
    do {
      const page = await this.api.get<ListBody>(
        `${this.options.path}${sep}limit=${limit}${token ? `&continue=${encodeURIComponent(token)}` : ''}`,
      );
      for (const raw of page.items ?? []) {
        items.push(this.options.strip(raw));
      }
      // The version of a paged list is the one of its first page's snapshot; every page carries it.
      version = page.metadata?.resourceVersion ?? version;
      token = page.metadata?.continue || undefined;
    } while (token);
    this.replace(items, version);
    this.state = 'synced';
    this.lastError = null;
  }

  /** Swaps the contents for a fresh list, telling `onChange` what differs. */
  private replace(items: T[], version: string | undefined): void {
    const before = new Map(this.store);
    const wasSynced = this.listedOnce;
    this.listedOnce = true;
    this.store.clear();
    const now = this.now();
    for (const item of items) {
      if (this.options.keep && !this.options.keep(item, now)) {
        continue;
      }
      this.store.set(keyOf(item), item);
    }
    this.cap();
    this.resourceVersion = version;
    this.view = null;
    const onChange = this.options.onChange;
    if (onChange && wasSynced) {
      for (const [key, next] of this.store) {
        const prev = before.get(key);
        if (!prev) {
          onChange('ADDED', undefined, next);
        } else if (prev.metadata.resourceVersion !== next.metadata.resourceVersion) {
          onChange('MODIFIED', prev, next);
        }
      }
      for (const [key, prev] of before) {
        if (!this.store.has(key)) {
          onChange('DELETED', prev, undefined);
        }
      }
    }
  }

  private cap(): void {
    const max = this.options.maxItems;
    if (!max || this.store.size <= max) {
      return;
    }
    const age = this.options.age ?? (() => 0);
    const oldest = [...this.store.entries()].sort((a, b) => age(a[1]) - age(b[1]));
    for (const [key] of oldest.slice(0, this.store.size - max)) {
      this.store.delete(key);
    }
  }

  private async watchOnce(): Promise<void> {
    this.stats.watches++;
    const abort = new AbortController();
    this.abort = abort;
    const sep = this.options.path.includes('?') ? '&' : '?';
    const timeout = this.options.watchTimeoutSeconds ?? 240 + Math.floor(Math.random() * 120);
    const rv = this.resourceVersion ? `&resourceVersion=${encodeURIComponent(this.resourceVersion)}` : '';
    try {
      const res = await this.api.watch(
        `${this.options.path}${sep}watch=1&allowWatchBookmarks=true&timeoutSeconds=${timeout}${rv}`,
        abort.signal,
      );
      if (res.status === 410) {
        throw new Gone('410 Gone');
      }
      if (!res.ok || !res.body) {
        throw new KubeError(res.status, `${res.status} on watch ${this.options.kind}`);
      }
      // The stream is open: the cache is current again.
      if (this.state === 'failed' && this.resourceVersion !== undefined) {
        this.state = 'synced';
        this.lastError = null;
      }
      this.failures = 0;
      await this.read(res.body);
    } finally {
      abort.abort();
      if (this.abort === abort) {
        this.abort = null;
      }
    }
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > MAX_LINE) {
        throw new Error('watch event too large');
      }
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          this.apply(JSON.parse(line) as { type: string; object: unknown });
        }
      }
    }
  }

  private apply(event: { type: string; object: unknown }): void {
    this.stats.events++;
    const object = event.object as
      { metadata?: { resourceVersion?: string }; code?: number; message?: string } | undefined;
    if (event.type === 'ERROR') {
      if (object?.code === 410) {
        throw new Gone(object.message ?? '410 Gone');
      }
      throw new KubeError(object?.code ?? 500, `watch ${this.options.kind}: ${object?.message ?? 'error event'}`);
    }
    if (event.type === 'BOOKMARK') {
      this.resourceVersion = object?.metadata?.resourceVersion ?? this.resourceVersion;
      return;
    }
    if (event.type !== 'ADDED' && event.type !== 'MODIFIED' && event.type !== 'DELETED') {
      return;
    }
    const next = this.options.strip(object);
    const key = keyOf(next);
    const prev = this.store.get(key);
    this.resourceVersion = next.metadata.resourceVersion ?? this.resourceVersion;
    if (event.type === 'DELETED' || (this.options.keep && !this.options.keep(next, this.now()))) {
      if (prev) {
        this.store.delete(key);
        this.view = null;
        this.options.onChange?.('DELETED', prev, undefined);
      }
      return;
    }
    this.store.set(key, next);
    this.cap();
    this.view = null;
    this.options.onChange?.(prev ? 'MODIFIED' : 'ADDED', prev, next);
  }
}

function keyOf(o: Keyed): string {
  return o.metadata.namespace ? `${o.metadata.namespace}/${o.metadata.name}` : o.metadata.name;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
