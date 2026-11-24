import { describe, expect, it } from 'vitest';
import { DemoKubeClient } from '../../demo/demo-cluster';
import { Detected } from '../../discovery/discovery';
import { emptyInventory } from '../../inventory/inventory';
import { KubeClient, KubeError } from '../../kube/kube-client';
import { en } from '../../testing/i18n';
import { ModuleContext } from '../types';
import { GatusIntegration } from './gatus';
import { UptimeKumaIntegration } from './uptime-kuma';

const ctx = (kube: KubeClient, slug?: string): ModuleContext => ({
  inv: emptyInventory(new Date()),
  kube,
  config: { uptimeKumaStatusPage: slug } as ModuleContext['config'],
  now: new Date(),
  prom: null,
  data: {},
});
const det = (id: string, name: string, port: number) =>
  ({
    entry: { id },
    services: [{ metadata: { name, namespace: 'monitoring' }, spec: { ports: [{ port, name: 'http' }] } }],
    workloads: [{ kind: 'Deployment', namespace: 'monitoring', name, ready: 1, desired: 1 }],
    links: [],
  }) as unknown as Detected;

class Refusing extends KubeClient {
  override get inCluster(): boolean {
    return false;
  }
  override async get<T>(): Promise<T> {
    throw new KubeError(401, 'Unauthorized');
  }
}

describe('Gatus and Uptime Kuma integrations', () => {
  it('Gatus: reads the statuses over the service and reports the down endpoint without actions', async () => {
    const r = en(await new GatusIntegration().run(ctx(new DemoKubeClient(undefined, 'broken')), det('gatus', 'gatus', 8080), () => true));
    expect(r.issues).toMatchObject([{ id: 'gatus/group/shop', severity: 'warning', actions: [] }]);
    expect(r.stats.map((s) => [s.label, s.value])).toEqual([
      ['Up', '4'],
      ['Down', '1'],
    ]);
  });

  it('Gatus behind a login: no issue, a stat that says so', async () => {
    const r = en(await new GatusIntegration().run(ctx(new Refusing()), det('gatus', 'gatus', 8080), () => true));
    expect(r).toMatchObject({ issues: [], summary: 'The API asks for a login, only the pods are checked' });
  });

  it('Uptime Kuma without a status page: only the pods, and how to set one up', async () => {
    const r = en(await new UptimeKumaIntegration().run(ctx(new DemoKubeClient(undefined, 'broken')), det('uptime-kuma', 'uptime-kuma', 3001), () => true));
    expect(r).toMatchObject({ issues: [], summary: '1 pod ready', stats: [{ label: 'Status page', value: 'not set up (UPTIME_KUMA_STATUS_PAGE)' }] });
  });

  it('Uptime Kuma with a status page: counts its monitors', async () => {
    const r = en(await new UptimeKumaIntegration().run(ctx(new DemoKubeClient(undefined, 'broken'), 'homelab'), det('uptime-kuma', 'uptime-kuma', 3001), () => true));
    expect(r.issues).toEqual([]);
    expect(r.stats.map((s) => [s.label, s.value])).toEqual([
      ['Status page', 'homelab'],
      ['Up', '5'],
      ['Down', '0'],
      ['No result', '1'],
    ]);
  });
});
