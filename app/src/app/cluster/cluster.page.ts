import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonRefresher,
  IonRefresherContent,
  IonSegment,
  IonSegmentButton,
  IonToolbar,
  ModalController,
  RefresherCustomEvent,
  ToastController,
} from '@ionic/angular/standalone';
import { shareText } from '../core/share';
import { TranslocoDirective } from '@jsverse/transloco';
import { AgentClient } from '../core/agent-client.service';
import { ClusterDataStore } from '../core/cluster-data.store';
import { ClusterStore } from '../core/cluster-store.service';
import { StatusStore } from '../core/status-store.service';
import { LanguageService } from '../i18n/language.service';
import { NannyEye } from '../ui/nanny-eye';
import { UsageBar } from '../ui/usage-bar';
import { buildClusterView, issueCards } from './cluster-view';
import { historyView } from './history-view';
import { statusReport } from './status-report';
import { BackupsTab } from './tabs/backups.tab';
import { ModuleSheet } from './module-sheet';
import { EventsTab } from './tabs/events.tab';
import { NetworkTab } from './tabs/network.tab';
import { NodesTab } from './tabs/nodes.tab';
import { OverviewTab } from './tabs/overview.tab';
import { ServicesTab } from './tabs/services.tab';
import { StorageTab } from './tabs/storage.tab';
import { WorkloadsTab } from './tabs/workloads.tab';

export type Tab = 'lage' | 'dienste' | 'nodes' | 'workloads' | 'speicher' | 'backups' | 'netzwerk' | 'ereignisse';

const NEEDS: Record<Tab, Parameters<ClusterDataStore['need']>> = {
  lage: ['history', 'incidents'],
  dienste: [],
  nodes: ['nodes', 'history'],
  workloads: ['workloads'],
  speicher: ['storage'],
  backups: ['backups'],
  netzwerk: ['network'],
  ereignisse: ['events'],
};

@Component({
  selector: 'app-cluster',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ClusterDataStore],
  imports: [
    TranslocoDirective,
    RouterLink,
    IonHeader,
    IonToolbar,
    IonButtons,
    IonButton,
    IonIcon,
    IonContent,
    IonRefresher,
    IonRefresherContent,
    IonSegment,
    IonSegmentButton,
    NannyEye,
    UsageBar,
    OverviewTab,
    ServicesTab,
    NodesTab,
    WorkloadsTab,
    StorageTab,
    NetworkTab,
    EventsTab,
    BackupsTab,
  ],
  templateUrl: './cluster.page.html',
  styleUrl: './cluster.page.scss',
})
export class ClusterPage {
  /** Route parameter. */
  readonly id = input.required<string>();

  private readonly clusters = inject(ClusterStore);
  private readonly status = inject(StatusStore);
  private readonly modals = inject(ModalController);
  private readonly toasts = inject(ToastController);
  private readonly router = inject(Router);
  readonly data = inject(ClusterDataStore);
  private readonly language = inject(LanguageService);

  readonly now = signal(new Date());
  readonly tab = signal<Tab>('lage');
  readonly cluster = computed(() => this.clusters.clusters().find((c) => c.id === this.id()) ?? null);
  readonly multiple = computed(() => this.clusters.clusters().length > 1);
  private readonly client = inject(AgentClient);
  /** The last call went through the relay: said small in the header, the data is just as private (docs/RELAY.md). */
  readonly viaRelay = computed(() => {
    const c = this.cluster();
    return c ? this.client.paths()[c.agentKey] === 'relay' : false;
  });
  private readonly state = computed(() => this.status.states()[this.id()] ?? null);
  readonly loading = computed(() => this.state()?.loading ?? false);
  readonly view = computed(() => buildClusterView(this.state()?.snapshot ?? null, this.state()?.error ?? null, this.now(), this.language.translator()));
  readonly stateLabel = computed(() => this.language.translator().t('cluster.stateLabel', { headline: this.view().headline }));
  readonly incidents = computed(() => {
    const value = this.data.incidents().value;
    return value ? historyView(value, this.state()?.snapshot?.modules ?? [], this.now(), this.language.translator()) : null;
  });
  /** Backups that need attention, once the tab has loaded them. */
  private readonly backupBadge = computed(() => this.data.backups().value?.rows.filter((r) => r.state !== 'ok').length || null);
  /** Something to report: the agent answered at least once. */
  readonly canShare = computed(() => Boolean(this.state()?.snapshot));
  readonly tabs = computed(() => {
    const v = this.view();
    const tr = this.language.translator();
    return [
      { id: 'lage' as Tab, label: tr.t('cluster.tabs.overview'), badge: v.issues.length || null },
      { id: 'dienste' as Tab, label: tr.t('cluster.tabs.services'), badge: v.attention.length || null },
      { id: 'nodes' as Tab, label: tr.t('cluster.tabs.nodes'), badge: null },
      { id: 'workloads' as Tab, label: tr.t('cluster.tabs.workloads'), badge: null },
      { id: 'speicher' as Tab, label: tr.t('cluster.tabs.storage'), badge: null },
      { id: 'backups' as Tab, label: tr.t('cluster.tabs.backups'), badge: this.backupBadge() },
      { id: 'netzwerk' as Tab, label: tr.t('cluster.tabs.network'), badge: null },
      { id: 'ereignisse' as Tab, label: tr.t('cluster.tabs.events'), badge: null },
    ];
  });

  constructor() {
    const tick = setInterval(() => this.now.set(new Date()), 20_000);
    inject(DestroyRef).onDestroy(() => clearInterval(tick));

    effect(() => {
      const cluster = this.cluster();
      if (cluster) {
        this.data.use(cluster);
        this.data.need(...NEEDS[this.tab()]);
      }
    });
    // Every new status answer also refreshes the open detail views.
    let lastChecked: string | null = null;
    effect(() => {
      const checked = this.state()?.snapshot?.checkedAt ?? null;
      if (checked && lastChecked && checked !== lastChecked) {
        void this.data.reloadAll();
      }
      lastChecked = checked;
    });
  }

  ionViewWillEnter(): void {
    if (!this.cluster()) {
      void this.clusters.loaded.then(() => {
        if (!this.cluster()) {
          void this.router.navigateByUrl('/');
        }
      });
    }
    this.status.start();
  }

  ionViewDidLeave(): void {
    this.status.stop();
  }

  selectTab(value: unknown): void {
    this.tab.set(value as Tab);
  }

  async refresh(): Promise<void> {
    const cluster = this.cluster();
    if (cluster) {
      await this.status.refresh(cluster, true);
      this.now.set(new Date());
    }
  }

  async pullToRefresh(event: RefresherCustomEvent): Promise<void> {
    await this.refresh();
    await event.target.complete();
  }

  /** The state as plain text, through the system share sheet where there is one, else to the clipboard. */
  async share(): Promise<void> {
    const cluster = this.cluster();
    const state = this.state();
    if (!cluster || !state?.snapshot) {
      return;
    }
    const tr = this.language.translator();
    const text = statusReport(
      { name: cluster.name, view: this.view(), checkedAt: state.snapshot.checkedAt ?? null, agentVersion: state.snapshot.agentVersion ?? null, error: state.error },
      tr,
    );
    const outcome = await shareText(text, tr.t('cluster.shareTitle', { cluster: cluster.name }));
    if (outcome !== 'shared') {
      const toast = await this.toasts.create({ message: tr.t(outcome === 'copied' ? 'cluster.copiedReport' : 'cluster.shareFailed'), duration: 2500, position: 'bottom' });
      await toast.present();
    }
  }

  async openModule(id: string): Promise<void> {
    const snapshot = this.state()?.snapshot;
    const module = snapshot?.modules.find((m) => m.id === id);
    if (!module || !snapshot) {
      return;
    }
    const related = snapshot.issues.filter((i) => module.issueIds.includes(i.id));
    const modal = await this.modals.create({
      component: ModuleSheet,
      cssClass: 'sheet',
      breakpoints: [0, 0.6, 1],
      initialBreakpoint: 1,
      componentProps: { module, cluster: this.cluster(), issueCards: issueCards(related, snapshot.modules, this.now(), this.language.translator()) },
    });
    await modal.present();
    const { data } = await modal.onDidDismiss<{ changed: boolean }>();
    if (data?.changed) {
      void this.refresh();
    }
  }
}
