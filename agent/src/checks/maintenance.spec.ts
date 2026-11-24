import { describe, expect, it } from 'vitest';
import { de } from '../testing/i18n';
import { parseCustomComponents } from '../config';
import { discover, hostsInMatch } from '../discovery/discovery';
import { emptyInventory } from '../inventory/inventory';
import { evaluateApiServerCertificate, evaluateEtcdSnapshots, evaluateHpas, evaluateLonghornBackups, evaluatePdbs } from './maintenance.check';

const NOW = new Date('2026-11-24T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe('PodDisruptionBudgets', () => {
  it('flags a budget that allows no disruption while healthy, because drains then hang', () => {
    const issues = de(evaluatePdbs([
      { metadata: { name: 'single', namespace: 'a' }, spec: { minAvailable: 1 }, status: { expectedPods: 1, currentHealthy: 1, desiredHealthy: 1, disruptionsAllowed: 0 } },
      { metadata: { name: 'fine', namespace: 'a' }, spec: { minAvailable: 1 }, status: { expectedPods: 2, currentHealthy: 2, desiredHealthy: 1, disruptionsAllowed: 1 } },
      // Unhealthy pods are the Workloads check's business.
      { metadata: { name: 'sick', namespace: 'a' }, spec: { minAvailable: 2 }, status: { expectedPods: 2, currentHealthy: 1, desiredHealthy: 2, disruptionsAllowed: 0 } },
      { metadata: { name: 'empty', namespace: 'a' }, status: { expectedPods: 0, disruptionsAllowed: 0 } },
    ]));
    expect(issues.map((i) => i.id)).toEqual(['pdb/a/single']);
    expect(issues[0].cause).toContain('kured');
  });
});

describe('HorizontalPodAutoscalers', () => {
  const hpa = (conditions: { type: string; status: string; reason?: string; message?: string }[], current = 2, max = 4) => ({
    metadata: { name: 'web', namespace: 'a' },
    spec: { maxReplicas: max, scaleTargetRef: { name: 'web' } },
    status: { currentReplicas: current, desiredReplicas: current + 1, conditions },
  });

  it('flags a blind autoscaler, one that cannot scale, and one stuck at its maximum', () => {
    expect(de(evaluateHpas([hpa([{ type: 'ScalingActive', status: 'False', message: 'failed to get cpu utilization' }])]))[0].title).toContain('misst nichts');
    expect(de(evaluateHpas([hpa([{ type: 'AbleToScale', status: 'False', message: 'no target' }])]))[0].title).toContain('kann nicht skalieren');
    expect(de(evaluateHpas([hpa([{ type: 'ScalingLimited', status: 'True', reason: 'TooManyReplicas' }], 4, 4)]))[0].title).toContain('am Maximum');
    expect(de(evaluateHpas([hpa([{ type: 'ScalingLimited', status: 'True', reason: 'TooFewReplicas' }], 1, 4)]))).toEqual([]);
  });
});

describe('etcd snapshots', () => {
  const snap = (h: number, extra: object = {}) => ({ metadata: { name: `s${h}` }, spec: { nodeName: 'n1' }, status: { creationTime: hoursAgo(h), readyToUse: true, ...extra } });

  it('is quiet with a fresh snapshot and warns, then alarms, as it ages', () => {
    expect(de(evaluateEtcdSnapshots([snap(3), snap(15)], NOW, 26))).toEqual([]);
    expect(de(evaluateEtcdSnapshots([snap(30)], NOW, 26))[0]).toMatchObject({ severity: 'warning', title: 'Letzter gültiger etcd-Snapshot vor 30 h' });
    expect(de(evaluateEtcdSnapshots([snap(60)], NOW, 26))[0].severity).toBe('critical');
  });

  it('reports a failed newest snapshot and a cluster without any', () => {
    const ids = de(evaluateEtcdSnapshots([snap(1, { readyToUse: false, error: { message: 'S3 access denied' } }), snap(13)], NOW, 26)).map((i) => i.id);
    expect(ids).toEqual(['etcd/snapshot-failed']);
    expect(de(evaluateEtcdSnapshots([], NOW, 26))[0].id).toBe('etcd/snapshots');
  });
});

describe('API server certificate', () => {
  it('warns 30 days ahead and alarms within a week', () => {
    expect(de(evaluateApiServerCertificate(new Date(NOW.getTime() + 90 * 86_400_000), NOW))).toEqual([]);
    expect(de(evaluateApiServerCertificate(new Date(NOW.getTime() + 20 * 86_400_000), NOW))[0].severity).toBe('warning');
    expect(de(evaluateApiServerCertificate(new Date(NOW.getTime() + 3 * 86_400_000), NOW))[0].severity).toBe('critical');
    expect(de(evaluateApiServerCertificate(null, NOW))).toEqual([]);
  });
});

describe('Longhorn backups', () => {
  const backup = (volume: string, h: number, state: string, error?: string) => ({ metadata: { name: `${volume}-${h}` }, status: { volumeName: volume, state, backupCreatedAt: hoursAgo(h), error } });

  it('alarms when the backup target is unreachable', () => {
    const [issue] = de(evaluateLonghornBackups([{ metadata: { name: 'default' }, spec: { backupTargetURL: 's3://b' }, status: { available: false } }], [], NOW, 26));
    expect(issue).toMatchObject({ severity: 'critical', title: 'Longhorn erreicht das Backup-Ziel nicht' });
  });

  it('reports a failed newest backup and a volume whose backups stopped', () => {
    const issues = de(evaluateLonghornBackups([], [backup('a', 34, 'Completed'), backup('a', 10, 'Error', 'S3 timeout'), backup('b', 40, 'Completed'), backup('c', 5, 'Completed')], NOW, 26));
    expect(issues.map((i) => [i.id, i.severity])).toEqual([
      ['longhorn/backup/a', 'warning'],
      ['longhorn/backup/b', 'warning'],
    ]);
    expect(issues[0].cause).toBe('S3 timeout');
  });
});

describe('discovery extensions', () => {
  it('recognises components that only run as CronJobs', () => {
    const inv = emptyInventory(NOW);
    inv.cronjobs = [
      { metadata: { name: 'descheduler', namespace: 'kube-system' }, spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: 'd', image: 'registry.k8s.io/descheduler/descheduler:v0.33.0' }] } } } } } },
    ];
    const [det] = discover(inv);
    expect(det).toMatchObject({ entry: { id: 'descheduler' }, version: '0.33.0' });
    expect(det.workloads[0].kind).toBe('CronJob');
  });

  it('recognises your own components by image prefix, before the catalog', () => {
    const custom = parseCustomComponents(JSON.stringify([{ name: 'Shop API', images: ['ghcr.io/acme/shop-api'], category: 'apps', icon: 'server-outline' }]));
    const inv = emptyInventory(NOW);
    inv.deployments = [
      { metadata: { name: 'shop-api-chart', namespace: 'default' }, spec: { replicas: 2, template: { spec: { containers: [{ name: 'api', image: 'ghcr.io/acme/shop-api:2026-11-24-412' }] } } }, status: { readyReplicas: 2 } },
      { metadata: { name: 'other', namespace: 'default' }, spec: { template: { spec: { containers: [{ name: 'x', image: 'ghcr.io/acme/shop-api-evil:1' }] } } } },
    ];
    const found = discover(inv, custom);
    expect(found[0]).toMatchObject({ entry: { id: 'custom:shop-api', name: 'Shop API', custom: true }, version: '2026-11-24-412' });
    // The prefix ends at a boundary, so a look-alike image is not taken for it.
    expect(found[0].workloads.map((w) => w.name)).toEqual(['shop-api-chart']);
    expect(found).toHaveLength(1);
  });

  it('treats a prefix ending in a slash as a whole registry path', () => {
    const custom = parseCustomComponents(JSON.stringify([{ name: 'Shop', images: ['ghcr.io/acme/'] }]));
    const inv = emptyInventory(NOW);
    inv.deployments = [{ metadata: { name: 'web', namespace: 'd' }, spec: { template: { spec: { containers: [{ name: 'w', image: 'ghcr.io/acme/shop-web-app:1' }] } } } }];
    expect(discover(inv, custom)[0].entry.name).toBe('Shop');
  });

  it('refuses malformed custom components at start', () => {
    expect(() => parseCustomComponents('{')).toThrow(/JSON/);
    expect(() => parseCustomComponents('[{"name":"x"}]')).toThrow(/image prefixes/);
    expect(parseCustomComponents(undefined)).toEqual([]);
  });

  it('reads hosts from Traefik match rules', () => {
    expect(hostsInMatch('Host(`a.example`) || (Host(`b.example`, `c.example`) && PathPrefix(`/api`))')).toEqual(['a.example', 'b.example', 'c.example']);
    expect(hostsInMatch(undefined)).toEqual([]);
  });

  it('links a component to its HTTPRoute and IngressRoute hosts', () => {
    const inv = emptyInventory(NOW);
    inv.deployments = [{ metadata: { name: 'grafana', namespace: 'mon' }, spec: { template: { metadata: { labels: { app: 'g' } }, spec: { containers: [{ name: 'g', image: 'grafana/grafana:12.1.0' }] } } }, status: { readyReplicas: 1 } }];
    inv.services = [{ metadata: { name: 'grafana', namespace: 'mon' }, spec: { selector: { app: 'g' }, ports: [{ port: 80 }] } }];
    inv.httpRoutes = [{ metadata: { name: 'r', namespace: 'mon' }, spec: { hostnames: ['grafana.example'], rules: [{ backendRefs: [{ name: 'grafana', port: 80 }] }] } }];
    inv.ingressRoutes = [{ metadata: { name: 'ir', namespace: 'mon' }, spec: { routes: [{ match: 'Host(`g.example`)', services: [{ name: 'grafana', port: 80 }] }], tls: {} } }];
    expect(discover(inv)[0].links.map((l) => l.url)).toEqual(['https://grafana.example', 'https://g.example']);
  });
});
