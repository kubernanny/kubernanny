import { Injectable, inject } from '@angular/core';
import { generateKeyPair, pushKeyId, toBase64Url } from '@kubernanny/protocol';
import { AgentClient } from '../agent-client.service';
import { ClusterConfig } from '../agent.model';
import { ClusterStore } from '../cluster-store.service';
import { WidgetBridge } from '../widget/widget-bridge';
import { PushNative } from './push-native';

export type EnableOutcome = 'enabled' | 'denied' | 'unavailable';

/**
 * "Push to this device" (docs/NOTIFICATIONS.md, "Native push"): asks for the
 * notification permission only when someone taps it, makes a push key pair
 * for this one cluster, keeps its secret half natively and registers the
 * FCM token with the public half at the agent, sealed like every call.
 *
 * The push key is not the device key: the code that opens pushes without
 * the app (iOS extension, Android service) holds only push keys, which can
 * open pushes and do nothing else (decisions/0007-native-push.md).
 */
@Injectable({ providedIn: 'root' })
export class PushRegistration {
  private readonly native = inject(PushNative);
  private readonly client = inject(AgentClient);
  private readonly store = inject(ClusterStore);
  private readonly widgets = inject(WidgetBridge);
  private refreshing: Promise<void> | null = null;

  async enable(cluster: ClusterConfig): Promise<EnableOutcome> {
    const status = await this.native.status();
    if (!status.available || !status.platform) {
      return 'unavailable';
    }
    if (!(await this.native.requestPermission())) {
      return 'denied';
    }
    const token = await this.native.token();
    const keys = generateKeyPair();
    const kid = pushKeyId(keys.publicKey);
    const key = toBase64Url(keys.publicKey);
    const widget = (await this.widgetClusters()).has(cluster.id);
    await this.native.storeKey({ kid, secretKey: toBase64Url(keys.secretKey), publicKey: key, agentKey: cluster.agentKey, clusterId: cluster.id });
    try {
      await this.client.registerPush(cluster, { token, platform: status.platform, key, widget });
    } catch (err) {
      await this.native.removeKey(kid);
      throw err;
    }
    if (cluster.push && cluster.push.kid !== kid) {
      await this.native.removeKey(cluster.push.kid);
    }
    const saved = await this.store.save({ ...cluster, push: { kid, key, token, ...(widget ? { widget: true as const } : {}) } });
    void this.client.testPush(saved).catch(() => undefined);
    return 'enabled';
  }

  /** Off at the agent first (so it stops sending), then the key goes. */
  async disable(cluster: ClusterConfig): Promise<void> {
    await this.client.unregisterPush(cluster);
    await this.drop(cluster);
  }

  /** The cluster is removed from this device: best effort at the agent, the key goes in any case. */
  async forget(cluster: ClusterConfig): Promise<void> {
    if (!cluster.push) {
      return;
    }
    await this.client.unregisterPush(cluster).catch(() => undefined);
    await this.native.removeKey(cluster.push.kid);
  }

  /**
   * On start and whenever the app comes back to the front: FCM may hand out
   * a new token (app restored, data cleared, token rotated), and a widget may
   * have been placed or removed meanwhile. Each cluster with push registered
   * whose token or widget flag changed is registered again, with the same
   * push key; the agent then sends the widget's hourly status push, or stops
   * (docs/NOTIFICATIONS.md, "The home-screen widget"). Quiet on failure; the
   * next start or resume tries again. Runs one at a time.
   */
  refreshRegistrations(): Promise<void> {
    this.refreshing ??= this.refresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async refresh(): Promise<void> {
    const clusters = this.store.clusters().filter((c) => c.push && !c.demo);
    if (clusters.length === 0) {
      return;
    }
    const status = await this.native.status();
    if (!status.available || !status.platform) {
      return;
    }
    let token: string;
    try {
      token = await this.native.token();
    } catch {
      return;
    }
    const shown = await this.widgetClusters();
    for (const cluster of clusters) {
      const widget = shown.has(cluster.id);
      if (cluster.push!.token !== token || (cluster.push!.widget === true) !== widget) {
        try {
          await this.client.registerPush(cluster, { token, platform: status.platform, key: cluster.push!.key, widget });
          const { widget: _before, ...push } = cluster.push!;
          await this.store.save({ ...cluster, push: { ...push, token, ...(widget ? { widget: true as const } : {}) } });
        } catch {
          // Unreachable now, or push switched off at the agent: tried again next start.
        }
      }
    }
  }

  /**
   * The clusters a placed widget shows: those in the widget's list (the app
   * leaves out clusters switched off for the widget, and all of them when
   * widgets are off), once any widget is placed. Empty without widgets.
   */
  private async widgetClusters(): Promise<Set<string>> {
    try {
      if (!(await this.widgets.placed())) {
        return new Set();
      }
      return new Set((await this.widgets.read()).map((c) => c.id));
    } catch {
      return new Set();
    }
  }

  private async drop(cluster: ClusterConfig): Promise<void> {
    if (cluster.push) {
      await this.native.removeKey(cluster.push.kid);
      const rest: ClusterConfig = { ...cluster };
      delete rest.push;
      await this.store.save(rest);
    }
  }
}
