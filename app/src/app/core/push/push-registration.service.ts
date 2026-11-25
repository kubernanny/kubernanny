import { Injectable, inject } from '@angular/core';
import { generateKeyPair, pushKeyId, toBase64Url } from '@kubernanny/protocol';
import { AgentClient } from '../agent-client.service';
import { ClusterConfig } from '../agent.model';
import { ClusterStore } from '../cluster-store.service';
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
    await this.native.storeKey({ kid, secretKey: toBase64Url(keys.secretKey), publicKey: key, agentKey: cluster.agentKey, clusterId: cluster.id });
    try {
      await this.client.registerPush(cluster, { token, platform: status.platform, key });
    } catch (err) {
      await this.native.removeKey(kid);
      throw err;
    }
    if (cluster.push && cluster.push.kid !== kid) {
      await this.native.removeKey(cluster.push.kid);
    }
    const saved = await this.store.save({ ...cluster, push: { kid, key, token } });
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
   * On start: FCM may hand out a new token (app restored, data cleared,
   * token rotated). Each cluster with push registered gets the new one, with
   * the same push key. Quiet on failure; the next start tries again.
   */
  async refreshTokens(): Promise<void> {
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
    for (const cluster of clusters) {
      if (cluster.push!.token !== token) {
        try {
          await this.client.registerPush(cluster, { token, platform: status.platform, key: cluster.push!.key });
          await this.store.save({ ...cluster, push: { ...cluster.push!, token } });
        } catch {
          // Unreachable now, or push switched off at the agent: tried again next start.
        }
      }
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
