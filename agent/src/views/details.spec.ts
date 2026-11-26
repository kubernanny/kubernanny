import { describe, expect, it } from 'vitest';

import { emptyInventory, FullNode, FullPod, Service, Workload } from '../inventory/inventory';
import { buildOverview } from '../status/snapshot';
import { buildEvents } from './events';
import { buildNetwork } from './network';
import { buildNodes } from './nodes';
import { buildWorkloads } from './workloads';

const deployment = (name: string, labels: Record<string, string>): Workload => ({
  metadata: { name, namespace: 'apps' },
  spec: { replicas: 1, template: { metadata: { labels } } },
  status: { replicas: 1, readyReplicas: 1 },
});

function pod(
  name: string,
  owner: string,
  opts: { limits?: Record<string, string>; requests?: Record<string, string>; restarts?: number; last?: object } = {},
): FullPod {
  return {
    metadata: {
      name,
      namespace: 'apps',
      labels: { 'pod-template-hash': 'abc12' },
      ownerReferences: [{ kind: 'ReplicaSet', name: `${owner}-abc12` }],
    },
    spec: {
      nodeName: 'n1',
      containers: [{ name: 'app', image: 'app:1', resources: { requests: opts.requests, limits: opts.limits } }],
    },
    status: {
      phase: 'Running',
      conditions: [{ type: 'Ready', status: 'True' }],
      containerStatuses: [
        {
          name: 'app',
          ready: true,
          restartCount: opts.restarts ?? 0,
          ...(opts.last ? { lastState: { terminated: opts.last } } : {}),
        },
      ],
    },
  } as FullPod;
}

describe('detail fields of the views', () => {
  it('workloads: requests, limits and the last restart with its reason, the memory limit next to an OOMKill', () => {
    const inv = emptyInventory(new Date('2026-11-25T10:00:00Z'));
    inv.deployments = [deployment('api', { app: 'api' })];
    inv.pods = [
      pod('api-abc12-x', 'api', {
        requests: { cpu: '250m', memory: '256Mi' },
        limits: { memory: '512Mi' },
        restarts: 3,
        last: { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-11-25T07:00:00Z' },
      }),
      pod('api-abc12-y', 'api', {
        requests: { cpu: '250m', memory: '256Mi' },
        restarts: 1,
        last: { reason: 'Error', exitCode: 1, finishedAt: '2026-11-25T09:00:00Z' },
      }),
    ];
    const [w] = buildWorkloads(inv, []);
    expect(w!.resources).toEqual({
      cpuRequestMilli: 500,
      cpuLimitMilli: null,
      memRequest: 512 * 2 ** 20,
      memLimit: 512 * 2 ** 20,
      cpuUnlimited: 2,
      memUnlimited: 1,
    });
    expect(w!.lastRestart).toEqual({
      reason: 'Error',
      exitCode: 1,
      finishedAt: '2026-11-25T09:00:00Z',
      pod: 'api-abc12-y',
      container: 'app',
    });
    expect(w!.pods[0]!.containers[0]!.lastTermination).toEqual({
      reason: 'OOMKilled',
      exitCode: 137,
      finishedAt: '2026-11-25T07:00:00Z',
      memLimit: 512 * 2 ** 20,
    });
  });

  it('nodes and the overview: requests and limits of the scheduled pods next to the use', () => {
    const inv = emptyInventory(new Date());
    inv.nodes = [
      {
        metadata: { name: 'n1' },
        status: {
          allocatable: { cpu: '4', memory: '8Gi' },
          conditions: [
            { type: 'Ready', status: 'True' },
            { type: 'MemoryPressure', status: 'True', lastTransitionTime: '2026-11-25T08:00:00Z' },
          ],
        },
      } as FullNode,
    ];
    inv.nodeUsage = new Map([['n1', { cpuMilli: 1200, memBytes: 2 ** 30 }]]);
    inv.pods = [
      pod('a', 'api', { requests: { cpu: '2', memory: '1Gi' }, limits: { cpu: '3', memory: '2Gi' } }),
      pod('b', 'api', { requests: { cpu: '500m' } }),
    ];
    const [n] = buildNodes(inv, {});
    expect(n!.cpu).toEqual({ allocatableMilli: 4000, requestedMilli: 2500, limitMilli: 3000, usedMilli: 1200 });
    expect(n!.memory).toMatchObject({ requested: 2 ** 30, limit: 2 * 2 ** 30 });
    expect(n!.conditions).toEqual([{ type: 'MemoryPressure', status: 'True', since: '2026-11-25T08:00:00Z' }]);
    expect(buildOverview(inv, 0, false).cpu).toEqual({
      usedMilli: 1200,
      allocatableMilli: 4000,
      requestedMilli: 2500,
      limitMilli: 3000,
    });
  });

  it('events link a pod and a ReplicaSet to their Deployment', () => {
    const inv = emptyInventory(new Date());
    inv.deployments = [deployment('api', { app: 'api' })];
    inv.pods = [pod('api-abc12-x', 'api')];
    const ev = (kind: string, name: string) =>
      ({
        metadata: { name: `${name}.1`, namespace: 'apps' },
        reason: 'BackOff',
        count: 1,
        lastTimestamp: '2026-11-25T09:00:00Z',
        involvedObject: { kind, name, namespace: 'apps' },
      }) as (typeof inv.events)[number];
    inv.events = [ev('Pod', 'api-abc12-x'), ev('ReplicaSet', 'api-abc12'), ev('Pod', 'gone-123')];
    expect(buildEvents(inv).map((e) => e.workload)).toEqual([
      { kind: 'Deployment', name: 'api' },
      { kind: 'Deployment', name: 'api' },
      undefined,
    ]);
  });

  it('network: the workload behind an ingress, through the service selector', () => {
    const inv = emptyInventory(new Date());
    inv.deployments = [deployment('api', { app: 'api', tier: 'web' }), deployment('worker', { app: 'worker' })];
    inv.services = [
      {
        metadata: { name: 'api', namespace: 'apps' },
        spec: { selector: { app: 'api' }, ports: [{ port: 80 }] },
      } as Service,
    ];
    inv.ingresses = [
      {
        metadata: { name: 'api', namespace: 'apps' },
        spec: {
          rules: [
            {
              host: 'api.example.org',
              http: { paths: [{ backend: { service: { name: 'api', port: { number: 80 } } } }] },
            },
          ],
        },
      },
    ];
    expect(buildNetwork(inv, {}, []).ingresses[0]!.workloads).toEqual(['Deployment/api']);
  });
});
