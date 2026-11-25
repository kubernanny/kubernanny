import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { App } from '@capacitor/app';
import { AgentClient, describeError, isTransient } from './agent-client.service';
import { ClusterConfig, Snapshot } from './agent.model';
import { ClusterStore } from './cluster-store.service';
import { RELAY_INFO_EVERY_MS, adoptedRelay } from './relay-route';
import { LanguageService } from '../i18n/language.service';

export interface ClusterState {
  snapshot: Snapshot | null;
  error: string | null;
  loading: boolean;
}

const POLL_MS = 30_000;
/**
 * Quiet retries after a transient failure before the cluster is shown as
 * unreachable: a rolling update of the agent or a dropped relay connection
 * is over within seconds, and must not flash "offline".
 */
export const QUIET_RETRY_MS = [1500, 3000, 6000];
const EMPTY: ClusterState = { snapshot: null, error: null, loading: false };

/**
 * The last answer of every agent. Polls while the app is in the foreground;
 * in the background push (ntfy) takes over.
 */
@Injectable({ providedIn: 'root' })
export class StatusStore {
  private readonly client = inject(AgentClient);
  private readonly clusters = inject(ClusterStore);
  private readonly language = inject(LanguageService);
  private readonly state = signal<Record<string, ClusterState>>({});
  readonly states = this.state.asReadonly();
  private timer?: ReturnType<typeof setInterval>;
  /** When each cluster was last asked for its relay (see learnRelay). */
  private readonly relayAsked = new Map<string, number>();

  constructor() {
    // The agent writes its texts in the language the app asks for: ask again when it changes.
    let lang = this.language.lang();
    effect(() => {
      if (this.language.lang() !== lang) {
        lang = this.language.lang();
        void this.refreshAll();
      }
    });
    const onVisibility = () => (document.hidden ? this.stop() : this.start());
    document.addEventListener('visibilitychange', onVisibility);
    const resume = App.addListener('resume', () => this.start()).catch(() => undefined);
    const pause = App.addListener('pause', () => this.stop()).catch(() => undefined);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      void resume.then((h) => h?.remove());
      void pause.then((h) => h?.remove());
      this.stop();
    });
  }

  start(): void {
    this.stop();
    void this.refreshAll();
    this.timer = setInterval(() => void this.refreshAll(), POLL_MS);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async refreshAll(force = false): Promise<void> {
    await this.clusters.loaded;
    await Promise.all(this.clusters.clusters().map((c) => this.refresh(c, force)));
  }

  /** `force` asks the agent to run its checks now instead of answering from its last run. */
  async refresh(cluster: ClusterConfig, force = false): Promise<void> {
    this.patch(cluster.id, { loading: true });
    for (let attempt = 0; ; attempt++) {
      try {
        const snapshot = await this.client.status(cluster, force);
        this.patch(cluster.id, { snapshot, error: null, loading: false });
        void this.learnRelay(cluster);
        return;
      } catch (err) {
        if (attempt < QUIET_RETRY_MS.length && isTransient(err)) {
          // The last snapshot and its state stay as they are meanwhile.
          await new Promise((resolve) => setTimeout(resolve, QUIET_RETRY_MS[attempt]));
          continue;
        }
        // Keep the last snapshot: it is still the best we know, shown as stale.
        this.patch(cluster.id, { error: describeError(err, this.language.translator()), loading: false });
        return;
      }
    }
  }

  /**
   * A relay switched on (or off) at the agent after pairing reaches the app
   * here: the agent names it in its sealed /info, asked at most once an hour
   * per cluster after a good status. Failures are ignored; the next round asks again.
   */
  private async learnRelay(cluster: ClusterConfig): Promise<void> {
    const now = Date.now();
    if (cluster.demo || now - (this.relayAsked.get(cluster.id) ?? -Infinity) < RELAY_INFO_EVERY_MS) {
      return;
    }
    this.relayAsked.set(cluster.id, now);
    try {
      const info = await this.client.info(cluster);
      const current = this.clusters.find(cluster.id);
      const change = current ? adoptedRelay(current, info) : null;
      if (current && change) {
        await this.clusters.save({ ...current, ...change });
      }
    } catch {
      // not now
    }
  }

  forget(id: string): void {
    const { [id]: _, ...rest } = this.state();
    this.state.set(rest);
  }

  private patch(id: string, change: Partial<ClusterState>): void {
    const current = this.state()[id] ?? EMPTY;
    this.state.set({ ...this.state(), [id]: { ...current, ...change } });
  }
}
