import { effect, inject, Injectable, signal } from '@angular/core';

import { LanguageService } from '../i18n/language.service';
import {
  BackupsView,
  ClusterConfig,
  EventView,
  HistoryView,
  IncidentsView,
  NetworkView,
  NodeView,
  StorageView,
  WorkloadView,
} from './agent.model';
import { AgentClient, describeError } from './agent-client.service';

export interface Loadable<T> {
  value: T | null;
  error: string | null;
  loading: boolean;
}

const idle = <T>(): Loadable<T> => ({ value: null, error: null, loading: false });

type Key =
  'nodes' | 'workloads' | 'storage' | 'network' | 'events' | 'history' | 'incidents' | 'backups';

/**
 * The detail views of one cluster, loaded when a tab first needs them and
 * reloaded with every status poll while they are open. Provided per cluster
 * page, so leaving it drops the data.
 */
@Injectable()
export class ClusterDataStore {
  private readonly client = inject(AgentClient);
  private readonly language = inject(LanguageService);
  private cluster: ClusterConfig | null = null;
  private readonly wanted = new Set<Key>();

  readonly nodes = signal<Loadable<NodeView[]>>(idle());
  readonly workloads = signal<Loadable<WorkloadView[]>>(idle());
  readonly storage = signal<Loadable<StorageView>>(idle());
  readonly network = signal<Loadable<NetworkView>>(idle());
  readonly events = signal<Loadable<EventView[]>>(idle());
  readonly history = signal<Loadable<HistoryView>>(idle());
  readonly incidents = signal<Loadable<IncidentsView>>(idle());
  readonly backups = signal<Loadable<BackupsView>>(idle());
  readonly hours = signal(6);

  constructor() {
    // Node, workload and event texts come from the agent in the UI language.
    let lang = this.language.lang();
    effect(() => {
      if (this.language.lang() !== lang) {
        lang = this.language.lang();
        void this.reloadAll();
      }
    });
  }

  use(cluster: ClusterConfig): void {
    if (this.cluster?.id !== cluster.id) {
      for (const s of [
        this.nodes,
        this.workloads,
        this.storage,
        this.network,
        this.events,
        this.history,
        this.incidents,
        this.backups,
      ]) {
        (s as ReturnType<typeof signal<Loadable<unknown>>>).set(idle());
      }
      this.wanted.clear();
    }
    this.cluster = cluster;
  }

  /** Loads what a tab shows, once; later polls keep it fresh. */
  need(...keys: Key[]): void {
    for (const key of keys) {
      if (!this.wanted.has(key)) {
        this.wanted.add(key);
        void this.load(key);
      }
    }
  }

  reloadAll(): Promise<void> {
    return Promise.all([...this.wanted].map((k) => this.load(k))).then(() => undefined);
  }

  setHours(hours: number): void {
    this.hours.set(hours);
    void this.load('history');
  }

  private async load(key: Key): Promise<void> {
    const cluster = this.cluster;
    if (!cluster) {
      return;
    }
    const target = this[key] as ReturnType<typeof signal<Loadable<unknown>>>;
    target.update((s) => ({ ...s, loading: true }));
    try {
      const value = await this.fetch(cluster, key);
      if (this.cluster?.id === cluster.id) {
        target.set({ value, error: null, loading: false });
      }
    } catch (err) {
      // Keep the last value: it is still the best we know.
      target.update((s) => ({
        ...s,
        error: describeError(err, this.language.translator()),
        loading: false,
      }));
    }
  }

  private fetch(cluster: ClusterConfig, key: Key): Promise<unknown> {
    switch (key) {
      case 'nodes':
        return this.client.nodes(cluster);
      case 'workloads':
        return this.client.workloads(cluster);
      case 'storage':
        return this.client.storage(cluster);
      case 'network':
        return this.client.network(cluster);
      case 'events':
        return this.client.events(cluster);
      case 'history':
        return this.client.history(cluster, this.hours());
      case 'incidents':
        return this.client.incidents(cluster, 7);
      case 'backups':
        return this.client.backups(cluster);
    }
  }
}
