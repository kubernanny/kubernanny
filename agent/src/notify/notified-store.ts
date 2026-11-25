import { Logger } from '../logger';
import type { Config } from '../config';
import { Text, reviveText } from '../i18n/text';
import { KubeClient, KubeError } from '../kube/kube-client';
import { Serial } from '../util/serial';
import { upsertConfigMapData } from '../kube/configmap';
import type { Pushed } from './notifier';

/** SETTINGS_CONFIGMAP of settings.service, spelled out: importing it would close a cycle through the notifier (checked in the spec). */
export const SETTINGS_CONFIGMAP = 'kubernanny-settings';
/** The key in `kubernanny-settings`, next to `settings` and `silenced`. */
export const NOTIFIED_KEY = 'notified';
/** Issues remembered at most; past it the oldest go first (a resolution for them is then not sent after a restart). */
export const MAX_NOTIFIED = 300;
/** A ConfigMap holds 1 MiB in all; this key keeps well below a tenth of it. */
export const MAX_NOTIFIED_BYTES = 96 * 1024;

interface Stored {
  v: 1;
  /** Issue id -> severity (w, c) and the title it was sent with. Oldest first. */
  issues: Record<string, { s: 'w' | 'c'; t: Text }>;
}

/**
 * Compact JSON of the issues already sent, oldest first; capped in entries
 * and bytes by dropping the oldest. Titles are message keys with their
 * parameters, so a restart in another LANGUAGE still says "resolved" right.
 */
export function serializeNotified(pushed: ReadonlyMap<string, Pushed>): string {
  let entries = [...pushed].slice(-MAX_NOTIFIED);
  for (;;) {
    const stored: Stored = { v: 1, issues: Object.fromEntries(entries.map(([id, p]) => [id, { s: p.severity === 'critical' ? 'c' : 'w', t: p.title }])) };
    const text = JSON.stringify(stored);
    if (text.length <= MAX_NOTIFIED_BYTES || entries.length === 0) {
      return text;
    }
    entries = entries.slice(Math.ceil(entries.length / 10));
  }
}

/** Whatever does not parse is dropped: at worst an issue is sent once more, never a wrong text. */
export function parseNotified(text: string | undefined): Map<string, Pushed> {
  const out = new Map<string, Pushed>();
  try {
    const stored = JSON.parse(text ?? '') as Partial<Stored> | null;
    if (stored?.v !== 1 || typeof stored.issues !== 'object' || stored.issues === null) {
      return out;
    }
    for (const [id, entry] of Object.entries(stored.issues).slice(-MAX_NOTIFIED)) {
      const title = entry && (entry.s === 'w' || entry.s === 'c') ? reviveText(entry.t) : null;
      if (typeof id === 'string' && id.length <= 512 && title) {
        out.set(id, { title, severity: entry.s === 'c' ? 'critical' : 'warning' });
      }
    }
  } catch {
    // Not there yet, or not ours.
  }
  return out;
}

/**
 * Which issues were already pushed, kept in the ConfigMap `kubernanny-settings`
 * (key `notified`), so a restart neither sends "opened" again for an issue
 * that is still there nor forgets to send "resolved" for one that healed
 * while the agent was away.
 */
export class NotifiedStore {
  private readonly logger = new Logger('notify');
  private readonly writes = new Serial();
  private lastWritten: string | null = null;

  constructor(
    private readonly config: Config,
    private readonly kube: KubeClient,
  ) {}

  private get path(): string {
    return `/api/v1/namespaces/${encodeURIComponent(this.config.namespace)}/configmaps`;
  }

  async load(): Promise<Map<string, Pushed>> {
    try {
      const cm = await this.kube.get<{ data?: Record<string, string> }>(`${this.path}/${SETTINGS_CONFIGMAP}`);
      this.lastWritten = cm.data?.[NOTIFIED_KEY] ?? null;
      return parseNotified(cm.data?.[NOTIFIED_KEY]);
    } catch (err) {
      if (!(err instanceof KubeError && err.status === 404)) {
        this.logger.warn(`cannot read what was already sent (${err instanceof Error ? err.message : err}); a restart may repeat a message`);
      }
      return new Map();
    }
  }

  /** Writes the current state; skipped when it did not change. Never throws: losing it costs a repeated message at most. */
  save(pushed: ReadonlyMap<string, Pushed>): Promise<void> {
    const text = serializeNotified(pushed);
    return this.writes.run(async () => {
      if (text === this.lastWritten) {
        return;
      }
      try {
        await this.write({ [NOTIFIED_KEY]: text });
        this.lastWritten = text;
      } catch (err) {
        this.logger.warn(`cannot store what was sent (${err instanceof Error ? err.message : err})`);
      }
    });
  }

  private write(data: Record<string, string>): Promise<void> {
    return upsertConfigMapData(this.kube, this.config.namespace, SETTINGS_CONFIGMAP, data);
  }
}
