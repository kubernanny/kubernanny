import { effect, inject, Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

import { ClusterConfig } from '../agent.model';
import { ClusterStore } from '../cluster-store.service';
import { StatusStore } from '../status-store.service';
import { WidgetBridge } from './widget-bridge';
import { keepFresher, nextWidgetList, WidgetCluster } from './widget-summary';

const OFF_KEY = 'widgetsOff';

/**
 * Keeps the home-screen widgets' copy in step with the app: whenever a new
 * snapshot arrives, a cluster is renamed, removed or switched off, or the
 * widgets are switched off altogether, it writes the whole short list again
 * (docs/ARCHITECTURE.md, Widgets). The widget never talks to an agent and
 * holds no key; this list is all it knows (WidgetCluster).
 */
@Injectable({ providedIn: 'root' })
export class WidgetSync {
  private readonly bridge = inject(WidgetBridge);
  private readonly clusters = inject(ClusterStore);
  private readonly status = inject(StatusStore);
  private readonly off = signal(false);
  private readonly ready = signal(false);
  /** Switched off in the app: nothing is kept for any widget. */
  readonly allOff = this.off.asReadonly();
  readonly supported = this.bridge.supported;
  readonly loaded: Promise<void>;
  /** What was last handed to the bridge; the base for clusters without a fresh answer. */
  private written: WidgetCluster[] = [];
  private writtenJson: string | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor() {
    this.loaded = this.supported ? this.load() : Promise.resolve();
    effect(() => {
      if (this.ready()) {
        void this.sync();
      }
    });
  }

  /** The global switch. Off deletes every cluster from the widget storage before it resolves. */
  async setAllOff(off: boolean): Promise<void> {
    this.off.set(off);
    try {
      await Preferences.set({ key: OFF_KEY, value: off ? '1' : '0' });
    } catch {
      // Not persisted: the switch still holds for this session, and the data is deleted either way.
    }
    await this.sync();
  }

  /** The per-cluster switch. Off deletes that cluster from the widget storage before it resolves. */
  async setShown(cluster: ClusterConfig, shown: boolean): Promise<void> {
    await this.clusters.save({ ...cluster, widgetOff: !shown });
    await this.sync();
  }

  /** Writes when the list differs from what was written last; writes run one after another. */
  sync(): Promise<void> {
    if (!this.ready()) {
      return this.queue;
    }
    const next = nextWidgetList(
      this.written,
      this.clusters.clusters(),
      this.status.states(),
      this.off(),
    );
    const json = JSON.stringify(next);
    if (json === this.writtenJson) {
      return this.queue;
    }
    this.written = next;
    this.writtenJson = json;
    this.queue = this.queue.then(async () => {
      try {
        // A push may have stored a newer state since (push-written entries win, keepFresher).
        const stored = await this.bridge.read().catch(() => [] as WidgetCluster[]);
        const merged = keepFresher(next, stored);
        if (JSON.stringify(merged) !== json) {
          this.written = merged;
        }
        await this.bridge.write(merged);
      } catch {
        // Retry with the next change rather than believe a failed write.
        this.writtenJson = null;
      }
    });
    return this.queue;
  }

  private async load(): Promise<void> {
    try {
      const { value } = await Preferences.get({ key: OFF_KEY });
      this.off.set(value === '1');
    } catch {
      // Unreadable: on, the default.
    }
    try {
      this.written = await this.bridge.read();
      this.writtenJson = JSON.stringify(this.written);
    } catch {
      this.written = [];
    }
    await this.clusters.loaded;
    this.ready.set(true);
    // Something switched off while the app was closed (or an older list) is cleaned up now.
    await this.sync();
  }
}
