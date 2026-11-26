import { describe, expect, it } from 'vitest';

import { de } from '../../testing/i18n';
import {
  cronJobTemplatePods,
  evaluateSecurity,
  podFindings,
  SecurityPod,
  SYSTEM_NAMESPACES,
  workloadOf,
} from './evaluate';
import { SecurityCheck } from './security.check';

const safe = { runAsNonRoot: true };
const limits = { limits: { memory: '256Mi' } };

function pod(
  name: string,
  ns: string,
  spec: SecurityPod['spec'],
  owner?: { kind: string; name: string },
  labels?: Record<string, string>,
): SecurityPod {
  return {
    metadata: { name, namespace: ns, ownerReferences: owner ? [owner] : undefined, labels },
    spec,
    status: { phase: 'Running' },
  };
}

const hardened = (image = 'ghcr.io/acme/app:1.2.3'): SecurityPod['spec'] => ({
  securityContext: safe,
  containers: [{ name: 'app', image, resources: limits }],
});

const input = (pods: SecurityPod[], hostLevel: string[] = [], cronOfJob = new Map<string, string>()) => ({
  pods,
  cronOfJob,
  systemNamespaces: new Set(SYSTEM_NAMESPACES),
  hostLevel: new Set(hostLevel),
});

describe('pod findings', () => {
  it('finds nothing in a hardened pod', () => {
    expect(podFindings(pod('a', 'apps', hardened()))).toEqual([]);
  });

  it('treats a digest as pinned and latest or no tag as mutable', () => {
    expect(podFindings(pod('a', 'apps', hardened('nginx@sha256:abc')))).toEqual([]);
    expect(podFindings(pod('a', 'apps', hardened('nginx:latest')))).toEqual([
      { type: 'mutable-image', detail: 'nginx:latest' },
    ]);
    expect(podFindings(pod('a', 'apps', hardened('ghcr.io/acme/app')))).toEqual([
      { type: 'mutable-image', detail: 'app' },
    ]);
  });

  it('reads root from pod and container settings, the container winning', () => {
    const at = (podCtx: object | undefined, containerCtx: object | undefined) =>
      podFindings(
        pod('a', 'apps', {
          securityContext: podCtx,
          containers: [{ name: 'c', image: 'x:1', securityContext: containerCtx, resources: limits }],
        }),
      ).map((f) => f.type);
    expect(at(undefined, undefined)).toEqual(['root']);
    expect(at({ runAsUser: 1000 }, undefined)).toEqual([]);
    expect(at({ runAsNonRoot: true }, { runAsUser: 0 })).toEqual(['root']);
    expect(at(undefined, { runAsNonRoot: true })).toEqual([]);
    expect(at({ runAsUser: 0 }, undefined)).toEqual(['root']);
  });

  it('finds privileged containers, host access and missing memory limits', () => {
    const f = podFindings(
      pod('a', 'apps', {
        hostNetwork: true,
        securityContext: safe,
        containers: [
          { name: 'c', image: 'x:1', securityContext: { privileged: true }, resources: { limits: { cpu: '1' } } },
        ],
        volumes: [{ name: 'h', hostPath: { path: '/var/run' } }],
      }),
    );
    expect(f).toEqual([
      { type: 'privileged' },
      { type: 'host-access', detail: 'hostNetwork, hostPath' },
      { type: 'no-memory-limit' },
    ]);
  });
});

describe('workload of a pod', () => {
  it('resolves Deployments, CronJobs, operators and bare pods', () => {
    const cron = new Map([['apps/backup-29402640', 'backup']]);
    expect(
      workloadOf(
        pod('web-5d9f8-abcde', 'apps', {}, { kind: 'ReplicaSet', name: 'web-5d9f8' }, { 'pod-template-hash': '5d9f8' }),
        cron,
      ),
    ).toEqual({ key: 'apps/Deployment/web', label: 'web' });
    expect(workloadOf(pod('backup-29402640-x', 'apps', {}, { kind: 'Job', name: 'backup-29402640' }), cron)).toEqual({
      key: 'apps/CronJob/backup',
      label: 'backup',
    });
    expect(workloadOf(pod('pg-1', 'db', {}, { kind: 'Cluster', name: 'pg' }), cron)).toEqual({
      key: 'db/Cluster/pg',
      label: 'pg',
    });
    expect(workloadOf(pod('debug', 'apps', {}), cron)).toEqual({ key: 'apps/Pod/debug', label: 'debug' });
  });
});

describe('security posture', () => {
  it('aggregates one issue per finding type and namespace, not per pod', () => {
    const replicas = [1, 2, 3].map((i) =>
      pod(
        `web-5d9f8-${i}`,
        'apps',
        { containers: [{ name: 'c', image: 'x:1' }] },
        { kind: 'ReplicaSet', name: 'web-5d9f8' },
        { 'pod-template-hash': '5d9f8' },
      ),
    );
    const other = pod(
      'api-0',
      'apps',
      { containers: [{ name: 'c', image: 'y:1' }] },
      { kind: 'StatefulSet', name: 'api' },
    );
    const issues = de(evaluateSecurity(input([...replicas, other])));
    expect(issues.map((i) => [i.id, i.severity, i.title])).toEqual([
      ['security/apps/root', 'info', 'apps: 2 Workloads laufen womöglich als root'],
      ['security/apps/no-memory-limit', 'info', 'apps: 2 Workloads ohne Speicherlimit'],
    ]);
    expect(issues[0].cause).toBe(
      'Weder runAsNonRoot noch eine runAsUser über 0 ist gesetzt, also entscheidet das Image, und viele Images laufen als root. Betroffen: api, web. securityContext.runAsNonRoot: true setzen, dazu runAsUser, falls das Image keinen eigenen Nutzer hat.',
    );
  });

  it('warns about privileged containers outside system namespaces, and only hints otherwise', () => {
    const priv = (ns: string) =>
      pod(
        'p',
        ns,
        {
          securityContext: safe,
          containers: [{ name: 'c', image: 'x:1', securityContext: { privileged: true }, resources: limits }],
        },
        { kind: 'DaemonSet', name: 'agent' },
      );
    const issues = de(evaluateSecurity(input([priv('apps'), priv('kube-system'), priv('longhorn-system')])));
    expect(issues.map((i) => [i.id, i.severity])).toEqual([['security/apps/privileged', 'warning']]);
    expect(issues[0].cause).toContain('securityContext.privileged entfernen');
  });

  it('leaves host-level components alone for host access, privileges and root, but not for limits', () => {
    const exporter = pod(
      'node-exporter-x',
      'monitoring',
      {
        hostNetwork: true,
        hostPID: true,
        containers: [{ name: 'c', image: 'quay.io/prometheus/node-exporter:v1.9.1' }],
      },
      { kind: 'DaemonSet', name: 'node-exporter' },
    );
    const issues = de(evaluateSecurity(input([exporter], ['monitoring/DaemonSet/node-exporter'])));
    expect(issues.map((i) => i.id)).toEqual(['security/monitoring/no-memory-limit']);
  });

  it('shortens long lists and names what is mutable', () => {
    const pods = Array.from({ length: 7 }, (_, i) =>
      pod(`w${i}`, 'apps', hardened(`app${i}:latest`), { kind: 'StatefulSet', name: `w${i}` }),
    );
    const [issue] = de(evaluateSecurity(input(pods)));
    expect(issue.title).toBe('apps: 7 Workloads mit Image ohne feste Version');
    expect(issue.cause).toContain(
      'Betroffen: w0 (app0:latest), w1 (app1:latest), w2 (app2:latest), w3 (app3:latest), w4 (app4:latest) und 2 weitere.',
    );
  });

  it('judges CronJobs by their template, running or not, and once with their running pod', () => {
    const template = { containers: [{ name: 'c', image: 'curl:latest' }] };
    const cron = (name: string, suspend?: boolean) => ({
      metadata: { name, namespace: 'apps' },
      spec: { suspend, jobTemplate: { spec: { template: { spec: template } } } },
    });
    const running = pod('compact-29402640-x', 'apps', template, { kind: 'Job', name: 'compact-29402640' });
    const pods = [running, ...cronJobTemplatePods([cron('compact'), cron('cleanup'), cron('paused', true)])];
    const issues = de(evaluateSecurity(input(pods, [], new Map([['apps/compact-29402640', 'compact']]))));
    expect(issues.map((i) => [i.id, i.title])).toEqual([
      ['security/apps/root', 'apps: 2 Workloads laufen womöglich als root'],
      ['security/apps/no-memory-limit', 'apps: 2 Workloads ohne Speicherlimit'],
      ['security/apps/mutable-image', 'apps: 2 Workloads mit Image ohne feste Version'],
    ]);
    expect(issues[2].cause).toContain('Betroffen: cleanup (curl:latest), compact (curl:latest).');
  });

  it('ignores finished pods', () => {
    const done = {
      ...pod('job-x', 'apps', { containers: [{ name: 'c', image: 'x' }] }),
      status: { phase: 'Succeeded' },
    };
    expect(de(evaluateSecurity(input([done])))).toEqual([]);
  });

  it('is on by default, reads nothing new and needs no network', () => {
    const check = new SecurityCheck();
    expect(check.defaultOff).toBe(false);
    expect(check.reads).toEqual([]);
    expect(check.privacy({} as never)).toBeUndefined();
  });
});
