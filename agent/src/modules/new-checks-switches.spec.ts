import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { Agent } from '../agent';
import { loadConfig } from '../config';
import { DemoKubeClient } from '../demo/demo-cluster';
import { DemoRegistry } from '../demo/demo-registry';
import { KubeClient } from '../kube/kube-client';
import { rbacExport } from '../rbac/rules';
import { SettingsService } from '../settings/settings.service';
import { StatusService } from '../status/status.service';
import { CORE_CHECKS } from './core';
import { INTEGRATIONS } from './integrations';

/**
 * Every check added with Rook Ceph, the ingress error rates, the policy
 * engines, node clocks, image updates, Trivy Operator and the standard alerts can be switched off for good in
 * the deployment (`checks.disabled`), and then really is off: it does not
 * run, the app cannot switch it back on, its RBAC is not generated, and it
 * makes no request, to the cluster or out of it.
 */
const NEW = [
  'rook-ceph',
  'traefik',
  'ingress-nginx',
  'kyverno',
  'gatekeeper',
  'node-clocks',
  'image-updates',
  'trivy',
  'standard-alerts',
];
const who = { kind: 'device' as const, id: 'd1', name: 'Test' };

function config(env: Record<string, string>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const c = loadConfig();
  process.env = saved;
  return c;
}

/** The demo cluster, but not recognisable as the demo: default-off modules stay off and image updates would use the real registry client. */
class ClusterLike extends KubeClient {
  readonly demo = new DemoKubeClient(undefined, 'broken');
  readonly gets: string[] = [];
  override get inCluster(): boolean {
    return false;
  }
  override apiServerCertificate() {
    return this.demo.apiServerCertificate();
  }
  override list<T>(path: string) {
    return this.demo.list<T>(path);
  }
  override listPage<T>(path: string) {
    return this.demo.listPage<T>(path);
  }
  override get<T>(path: string) {
    this.gets.push(path);
    return this.demo.get<T>(path);
  }
  override text(path: string) {
    return this.demo.text(path);
  }
  override mergePatch(path: string, body: unknown) {
    return this.demo.mergePatch(path, body);
  }
  override create(path: string, body: unknown) {
    return this.demo.create(path, body);
  }
}

async function run(kube: KubeClient, env: Record<string, string>) {
  const saved = { ...process.env };
  Object.assign(process.env, { CHECK_INTERVAL_SECONDS: '3600', ...env });
  try {
    const moduleRef = new Agent({ kube: kube });
    const status = moduleRef.get(StatusService);
    await status.refresh();
    const snapshot = status.snapshot();
    await moduleRef.close();
    return snapshot;
  } finally {
    process.env = saved;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the new checks, switched off in the deployment', () => {
  it.each(NEW)('%s is locked: the app cannot switch it back on', async (id) => {
    const s = new SettingsService(config({ DISABLED_MODULES: id, ENABLED_MODULES: id }), new DemoKubeClient());
    await s.onModuleInit();
    expect(s.moduleState(id)).toBe('locked');
    await expect(s.update({ modules: { [id]: true } }, who)).rejects.toMatchObject({ status: 403 });
  });

  it('lose every RBAC rule: the chart grants a module its reads only while checks.disabled does not name it', () => {
    const generated = rbacExport();
    const modules = [...INTEGRATIONS, ...CORE_CHECKS].filter((m) => NEW.includes(m.id));
    expect(modules.map((m) => m.id).sort()).toEqual([...NEW].sort());
    for (const m of modules) {
      // Keyed by the module id, which is what the chart's `has $id $disabledModules` drops.
      expect(generated.modules[m.id] ?? [], m.id).toEqual(m.reads.length ? expect.any(Array) : []);
      const granted = Object.entries(generated.modules)
        .filter(([id]) => id !== m.id)
        .flatMap(([, rules]) => rules.flatMap((r) => r.resources.map((res) => `${r.group}/${res}`)));
      for (const read of m.reads) {
        expect(granted, `${read.group}/${read.resource} is also granted to another module`).not.toContain(
          `${read.group}/${read.resource}`,
        );
      }
    }
    // No action permission is tied to them either.
    expect(
      Object.values(generated.actions)
        .flatMap((a) => a.modules)
        .filter((id) => NEW.includes(id)),
    ).toEqual([]);
  });

  it('do not run and make no request: no CRD list, no Prometheus query, no registry', async () => {
    const kube = new DemoKubeClient(undefined, 'broken');
    const gets = vi.spyOn(kube, 'get');
    const registry = vi.spyOn(DemoRegistry.prototype, 'tags');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const s = await run(kube, { DISABLED_MODULES: NEW.join(',') });
    expect(s.modules.filter((m) => NEW.includes(m.id))).toEqual([]);
    expect(s.issues.filter((i) => NEW.some((id) => i.id.startsWith(`${id}/`)))).toEqual([]);
    expect(
      kube.lists.filter((p) =>
        /ceph\.rook\.io|wgpolicyk8s\.io|kyverno\.io|gatekeeper\.sh|aquasecurity\.github\.io/.test(p),
      ),
    ).toEqual([]);
    const queries = gets.mock.calls.map(([p]) => decodeURIComponent(String(p)));
    expect(
      queries.filter((q) =>
        /traefik_|nginx_ingress|node_timex|node_ntp|etcd_network_peer|coredns_|node_nf_conntrack|group by \(__name__\)/.test(
          q,
        ),
      ),
    ).toEqual([]);
    expect(registry).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('run when on (so the test above proves something)', async () => {
    const registry = vi.spyOn(DemoRegistry.prototype, 'tags');
    const s = await run(new DemoKubeClient(undefined, 'broken'), {});
    expect(
      s.modules
        .filter((m) => NEW.includes(m.id))
        .map((m) => m.id)
        .sort(),
    ).toEqual([
      'gatekeeper',
      'image-updates',
      'kyverno',
      'node-clocks',
      'rook-ceph',
      'standard-alerts',
      'traefik',
      'trivy',
    ]);
    expect(registry).toHaveBeenCalled();
  });
});

describe('image updates on a real cluster', () => {
  const answer = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ tags: [] }));

  it('stays off by default: no registry is contacted', async () => {
    const fetchSpy = answer();
    const s = await run(new ClusterLike(), {});
    expect(s.modules.map((m) => m.id)).not.toContain('image-updates');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('asks the registries once switched on (ENABLED_MODULES, Helm imageUpdates.enabled)', async () => {
    const fetchSpy = answer();
    const s = await run(new ClusterLike(), { ENABLED_MODULES: 'image-updates' });
    expect(s.modules.map((m) => m.id)).toContain('image-updates');
    expect(fetchSpy).toHaveBeenCalled();
    expect(
      fetchSpy.mock.calls.every(([url]) =>
        /^https:\/\/(registry-1\.docker\.io|ghcr\.io|quay\.io|registry\.k8s\.io)\/v2\//.test(String(url)),
      ),
    ).toBe(true);
  });

  it('contacts nothing when enabled and locked off at the same time', async () => {
    const fetchSpy = answer();
    const s = await run(new ClusterLike(), { ENABLED_MODULES: 'image-updates', DISABLED_MODULES: 'image-updates' });
    expect(s.modules.map((m) => m.id)).not.toContain('image-updates');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('the chart for image updates', () => {
  const chart = (file: string) => readFileSync(join(__dirname, '../../../deploy/helm/kubernanny', file), 'utf8');

  it('is off by default and opens registry egress only while enabled and not in checks.disabled', () => {
    expect(chart('values.yaml')).toMatch(/^imageUpdates:\n(?:\s*#.*\n)*\s+enabled: false$/m);
    const policy = chart('templates/networkpolicy.yaml');
    const block = policy.slice(policy.indexOf('(.Values.imageUpdates).enabled'));
    expect(block.split('\n')[0]).toContain('(not (has "image-updates" .Values.checks.disabled))');
    expect(block.slice(0, block.indexOf('{{- end }}'))).toContain('port: 443');
    expect(chart('templates/deployment.yaml')).toContain('$enabledModules = append $enabledModules "image-updates"');
  });
});
