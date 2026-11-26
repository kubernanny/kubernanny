import { HttpErrorResponse } from '@angular/common/http';
import { describe, expect, it } from 'vitest';

import { pairingRoute } from './app';
import { buildClusterView, headline } from './cluster/cluster-view';
import { eventRows } from './cluster/tabs/events.tab';
import { hostRows } from './cluster/tabs/network.tab';
import { nodeCards } from './cluster/tabs/nodes.tab';
import { volumeRows } from './cluster/tabs/storage.tab';
import { workloadGroups } from './cluster/tabs/workloads.tab';
import { ModuleView, NetworkView, NodeView, Snapshot, WorkloadView } from './core/agent.model';
import {
  AgentError,
  describeError,
  deviceName,
  transportAllowed,
} from './core/agent-client.service';
import { bytes, cores, formatValue } from './core/format';
import { translatorFor } from './i18n/translator';
import { chartGeometry } from './ui/area-chart';
import { parseLog } from './ui/logs-modal';

const NOW = new Date('2026-11-24T12:00:00Z');
const de = translatorFor('de');
const en = translatorFor('en');

const mod = (
  id: string,
  category: ModuleView['category'],
  status: ModuleView['status'],
): ModuleView => ({
  id,
  name: id,
  category,
  icon: 'cube-outline',
  description: '',
  status,
  summary: `${id} summary`,
  stats: [],
  links: [],
  workloads: { ready: 1, total: 1, items: [] },
  issueIds: [],
});

const snapshot: Snapshot = {
  cluster: 'home',
  light: 'red',
  score: 78,
  checkedAt: '2026-11-24T11:58:00Z',
  durationMs: 31,
  agentVersion: '0.3.0',
  kubernetes: { version: 'v1.33.4+rke2r1', distribution: 'RKE2' },
  overview: {
    nodes: { ready: 3, total: 3 },
    pods: { running: 60, total: 62 },
    cpu: { usedMilli: 5400, allocatableMilli: 16000 },
    memory: { used: 55 * 2 ** 30, allocatable: 61 * 2 ** 30 },
    volumes: { bound: 11, total: 12 },
    ingresses: 12,
    namespaces: 16,
    workloads: 35,
    components: 27,
    prometheus: true,
    metricsServer: true,
  },
  modules: [
    mod('nodes', 'core', 'ok'),
    mod('longhorn', 'storage', 'warning'),
    mod('argocd', 'gitops', 'critical'),
    mod('grafana', 'observability', 'ok'),
    mod('velero', 'backup', 'skipped'),
  ],
  issues: [
    {
      id: 'argocd/web/health',
      check: 'argocd',
      module: 'argocd',
      severity: 'critical',
      title: 'App web Degraded',
      cause: '…',
      since: '2026-11-24T11:00:00Z',
      actions: [
        { type: 'restart', kind: 'Deployment', namespace: 'default', name: 'a' },
        { type: 'restart', kind: 'Deployment', namespace: 'default', name: 'b' },
        { type: 'argocd-sync', namespace: 'argocd', app: 'web' },
      ],
    },
    {
      id: 'longhorn/x',
      check: 'longhorn',
      module: 'longhorn',
      severity: 'warning',
      title: 'Volume degraded',
      cause: '…',
      since: '2026-11-24T11:59:30Z',
      actions: [],
    },
  ],
};

describe('buildClusterView', () => {
  it('says what is wrong in one sentence and how the cluster is built', () => {
    const v = buildClusterView(snapshot, null, NOW, de);
    expect(v.headline).toBe('1 Ausfall und 1 Warnung');
    expect(v.subline).toBe('RKE2 1.33.4, 3 Nodes, 27 Komponenten erkannt · Kubernanny 0.3.0');
    expect(v.checked).toBe('Geprüft vor 2 min in 31 ms');
    expect(v.tone).toBe('critical');
  });

  it('says how long the agent has not been able to read the cluster, and how old the data is', () => {
    const failing = {
      ...snapshot,
      failingSince: '2026-11-24T11:55:00Z',
      checkedAt: '2026-11-24T11:54:00Z',
      error: 'connect ECONNREFUSED',
    };
    expect(buildClusterView(failing, null, NOW, de).checked).toBe(
      'Cluster seit 5 min nicht lesbar, Stand vor 6 min',
    );
    expect(buildClusterView(failing, null, NOW, en).checked).toBe(
      'Cluster unreadable for 5 min, data from 6 min ago',
    );
    expect(
      buildClusterView({ ...failing, failingSince: '2026-11-24T11:59:50Z' }, null, NOW, de).checked,
    ).toContain('seit kurzem');
  });

  it('numbers actions per type, as the agent counts them, and names the area', () => {
    const [card] = buildClusterView(snapshot, null, NOW, de).issues;
    expect(card.area).toBe('argocd');
    expect(card.sinceText).toBe('seit 1 h');
    expect(card.buttons.map((b) => [b.type, b.index])).toEqual([
      ['restart', 0],
      ['restart', 1],
      ['argocd-sync', 0],
    ]);
  });

  it('marks high memory in the key numbers', () => {
    const ram = buildClusterView(snapshot, null, NOW, de).kpis.find((k) => k.label === 'RAM')!;
    expect(ram).toMatchObject({ value: '90 %', tone: 'critical' });
  });

  it('groups components by category, broken first, without uninstalled ones', () => {
    const v = buildClusterView(snapshot, null, NOW, de);
    expect(v.groups.map((g) => g.label)).toEqual([
      'Kubernetes',
      'Speicher',
      'GitOps',
      'Monitoring',
    ]);
    expect(v.attention.map((r) => r.module.id)).toEqual(['longhorn', 'argocd']);
  });

  it('lists hints apart from problems, and a cluster with only hints still reads as fine', () => {
    const hint = {
      ...snapshot.issues[1],
      id: 'argocd/weblate/sync',
      severity: 'info' as const,
      title: 'Änderung wartet auf Sync',
    };
    const v = buildClusterView({ ...snapshot, light: 'green', issues: [hint] }, null, NOW, de);
    expect(v.issues).toEqual([]);
    expect(v.hints.map((h) => [h.issue.id, h.tone, h.icon])).toEqual([
      ['argocd/weblate/sync', 'muted', 'information-circle-outline'],
    ]);
    expect(v.headline).toBe('Läuft alles');
  });

  it('reads the same in English, with English plurals and number formats', () => {
    const v = buildClusterView(snapshot, null, NOW, en);
    expect(v.headline).toBe('1 outage and 1 warning');
    expect(v.subline).toBe('RKE2 1.33.4, 3 nodes, 27 components detected · Kubernanny 0.3.0');
    expect(v.checked).toBe('Checked 2 min ago in 31 ms');
    expect(v.issues[0].sinceText).toBe('for 1 h');
    expect(v.issues[0].buttons.map((b) => b.label)).toEqual(['Restart a', 'Restart b', 'Sync']);
    expect(v.kpis.find((k) => k.label === 'RAM')).toMatchObject({
      value: '90%',
      note: '55.0 GiB / 61.0 GiB',
    });
    expect(v.groups.map((g) => g.label)).toEqual(['Kubernetes', 'Storage', 'GitOps', 'Monitoring']);
    expect(v.attention.map((r) => r.statusLabel)).toEqual(['Warning', 'Failing']);
    const many = buildClusterView(
      { ...snapshot, issues: [snapshot.issues[0], { ...snapshot.issues[0], id: 'b' }] },
      null,
      NOW,
      en,
    );
    expect(many.headline).toBe('2 outages');
  });

  it('keeps the last answer when the agent stops answering, but goes grey', () => {
    const v = buildClusterView(snapshot, 'Agent nicht erreichbar. Bist du im VPN?', NOW, de);
    expect(v).toMatchObject({
      light: 'unknown',
      stale: true,
      headline: 'Keine Verbindung zum Agent',
    });
    expect(v.issues).toHaveLength(2);
  });
});

describe('formatting', () => {
  it('writes numbers the German way', () => {
    expect(bytes(1536 * 2 ** 20, 'de')).toBe('1,5 GiB');
    expect(cores(16000, 'de')).toBe('16');
    expect(cores(5400, 'de')).toBe('5,40');
    expect(cores(250, 'de')).toBe('250m');
    expect(formatValue(0.0061, 'seconds', 'de')).toBe('6,1 ms');
    expect(formatValue(2.4e6, 'bytesPerSecond', 'de')).toBe('2,3 MiB/s');
    expect(headline('green', 0, 0, de)).toBe('Läuft alles');
    expect(headline('yellow', 0, 0, de)).toBe('Läuft, aber nicht alles ist prüfbar');
  });
});

describe('tabs', () => {
  it('shows node usage, reservations and per-node history', () => {
    const node: NodeView = {
      name: 'n1',
      roles: ['control-plane', 'etcd'],
      ready: true,
      cordoned: false,
      rebooting: true,
      cpu: { allocatableMilli: 4000, requestedMilli: 1000, limitMilli: 0, usedMilli: 2000 },
      memory: { allocatable: 16 * 2 ** 30, requested: 4 * 2 ** 30, limit: 0, used: 15 * 2 ** 30 },
      podsWithoutLimit: { cpu: 0, memory: 0 },
      disk: 0.5,
      pods: { count: 20, capacity: 110 },
      conditions: [{ type: 'DiskPressure', status: 'True', message: 'low' }],
      taints: [
        'node-role.kubernetes.io/control-plane:NoSchedule',
        'example.com/gpu=true:NoSchedule',
      ],
    };
    const [card] = nodeCards(
      [node],
      {
        source: 'prometheus',
        hours: 6,
        series: [{ id: 'node-cpu:n1', label: 'CPU', unit: 'ratio', points: [] }],
      },
      NOW,
      de,
    );
    expect(card).toMatchObject({ state: 'Startet neu', tone: 'muted' });
    expect(card.cpu).toMatchObject({ kind: 'cpu', used: 2000, capacity: 4000, requested: 1000 });
    expect(card.cpuSeries?.id).toBe('node-cpu:n1');
    expect(card.warnings).toEqual(['DiskPressure: low', 'example.com/gpu=true:NoSchedule']);
  });

  it('filters and groups workloads, namespaces with problems first', () => {
    const w = (
      ns: string,
      name: string,
      health: WorkloadView['health'],
      restarts = 0,
    ): WorkloadView => ({
      kind: 'Deployment',
      namespace: ns,
      name,
      ready: 1,
      desired: 1,
      health,
      images: [`ghcr.io/x/${name}:1`],
      restarts,
      cpuMilli: 10,
      memBytes: 2 ** 20,
      resources: {
        cpuRequestMilli: 0,
        cpuLimitMilli: null,
        memRequest: 0,
        memLimit: null,
        cpuUnlimited: 0,
        memUnlimited: 0,
      },
      pods: [],
    });
    const list = [w('a', 'web', 'ok'), w('b', 'api', 'critical'), w('b', 'worker', 'ok', 3)];
    expect(workloadGroups(list, '', 'all', NOW, de).map((g) => g.namespace)).toEqual(['b', 'a']);
    expect(
      workloadGroups(list, '', 'problems', NOW, de).flatMap((g) => g.rows.map((r) => r.w.name)),
    ).toEqual(['api']);
    expect(
      workloadGroups(list, '', 'restarts', NOW, de).flatMap((g) => g.rows.map((r) => r.w.name)),
    ).toEqual(['worker']);
    expect(
      workloadGroups(list, 'ghcr.io/x/web', 'all', NOW, de).flatMap((g) =>
        g.rows.map((r) => r.w.name),
      ),
    ).toEqual(['web']);
  });

  it('puts degraded and full volumes first', () => {
    const rows = volumeRows(
      {
        classes: [],
        volumes: [
          {
            namespace: 'a',
            name: 'ok',
            phase: 'Bound',
            capacity: 10,
            accessModes: [],
            used: 1,
            usedBy: [],
          },
          {
            namespace: 'a',
            name: 'full',
            phase: 'Bound',
            capacity: 10,
            accessModes: [],
            used: 9.5,
            usedBy: [],
          },
          {
            namespace: 'a',
            name: 'deg',
            phase: 'Bound',
            capacity: 10,
            accessModes: [],
            used: null,
            usedBy: [],
            longhorn: { robustness: 'degraded' },
          },
        ],
      },
      de,
    );
    expect(rows.map((r) => [r.name, r.tone])).toEqual([
      ['full', 'critical'],
      ['deg', 'warning'],
      ['ok', 'ok'],
    ]);
  });

  it('puts certificates that run out first', () => {
    const view: NetworkView = {
      loadBalancers: [],
      ingresses: [
        {
          namespace: 'a',
          name: 'x',
          hosts: ['b.example'],
          tls: true,
          backends: [],
          workloads: [],
          certificate: { name: 'c', daysLeft: 60, ready: true },
        },
        {
          namespace: 'a',
          name: 'y',
          hosts: ['a.example'],
          tls: true,
          backends: [],
          workloads: [],
          certificate: { name: 'd', daysLeft: 9, ready: true },
        },
        {
          namespace: 'a',
          name: 'z',
          hosts: ['c.example'],
          tls: true,
          backends: [],
          workloads: [],
          certificate: { name: 'e', daysLeft: 1, ready: true },
        },
      ],
    };
    expect(hostRows(view, de).map((r) => [r.host, r.cert])).toEqual([
      ['c.example', 'Zertifikat noch 1 Tag'],
      ['a.example', 'Zertifikat noch 9 Tage'],
      ['b.example', 'Zertifikat noch 60 Tage'],
    ]);
    expect(hostRows(view, en).map((r) => r.cert)).toEqual([
      'Certificate: 1 day',
      'Certificate: 9 days',
      'Certificate: 60 days',
    ]);
  });
});

describe('transport', () => {
  it('fetches an unpinned agent key only where TLS, this machine or the same origin vouches for it', () => {
    expect(transportAllowed('https://kubernanny.example.com')).toBe(true);
    expect(transportAllowed('http://localhost:8080')).toBe(true);
    expect(transportAllowed('http://127.0.0.1:8080')).toBe(true);
    expect(transportAllowed('http://192.168.1.20:8080')).toBe(false);
    expect(transportAllowed('http://kubernanny.example.com')).toBe(false);
    expect(transportAllowed('http://localhost.evil.com')).toBe(false);
    expect(transportAllowed('javascript:alert(1)')).toBe(false);
    expect(transportAllowed('not a url')).toBe(false);
    // The web UI served by the agent itself may ask its own origin.
    expect(transportAllowed('http://192.168.1.20:8080', 'http://192.168.1.20:8080')).toBe(true);
    expect(transportAllowed('http://192.168.1.20:8080', 'http://192.168.1.21:8080')).toBe(false);
  });

  it('names the device for the device list', () => {
    expect(
      deviceName(
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        'Gerät',
      ),
    ).toBe('iPhone, Safari');
    expect(
      deviceName(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36',
        'Gerät',
      ),
    ).toBe('Linux, Chrome');
    expect(deviceName('', 'Gerät')).toBe('Gerät');
    expect(deviceName('', 'Device')).toBe('Device');
  });
});

describe('ui helpers', () => {
  it('scales ratios to 100 % and other units to their peak', () => {
    const g = chartGeometry(
      [
        [0, 0.5],
        [1000, 0.25],
      ],
      'ratio',
    )!;
    expect(g.max).toBe(1);
    expect(chartGeometry([[0, 1]], 'ratio')).toBeNull();
  });

  it('splits log lines into time and text and marks errors', () => {
    expect(parseLog('2026-11-24T04:02:12.006Z ERROR token expired\nplain line\n')).toEqual([
      { time: '04:02:12', text: 'ERROR token expired', level: 'error' },
      { time: '', text: 'plain line', level: 'plain' },
    ]);
  });

  it('accepts only well-formed pairing links', () => {
    expect(
      pairingRoute(
        'kubernanny://pair?url=https%3A%2F%2Fkubernanny.example&code=ABCDE23456&name=home',
      ),
    ).toEqual({ url: 'https://kubernanny.example', code: 'ABCDE23456', name: 'home' });
    const key = 'A'.repeat(43);
    expect(
      pairingRoute(`kubernanny://pair?url=http%3A%2F%2F10.0.0.5&code=ABCDE23456&key=${key}`),
    ).toEqual({ url: 'http://10.0.0.5', code: 'ABCDE23456', name: undefined, key });
    expect(
      pairingRoute('kubernanny://pair?url=https%3A%2F%2Fkubernanny.example&code=X&key=short'),
    ).toBeNull();
    expect(
      pairingRoute('kubernanny://pair?url=https%3A%2F%2Fkubernanny.example&token=t'),
    ).toBeNull();
    expect(pairingRoute('kubernanny://pair?url=https%3A%2F%2Fkubernanny.example')).toBeNull();
    expect(pairingRoute('kubernanny://pair?url=javascript%3Aalert(1)&token=t')).toBeNull();
    expect(pairingRoute('https://evil.example/pair?url=https://x&token=t')).toBeNull();
    // The host must be exactly `pair`.
    expect(pairingRoute('kubernanny://cluster/pair?url=https%3A%2F%2Fx&code=C')).toBeNull();
    expect(pairingRoute('kubernanny://repair?url=https%3A%2F%2Fx&code=C')).toBeNull();
  });
});

describe('events', () => {
  it('says how often and since when, and how many Kubernetes events were merged', () => {
    const base = {
      time: '2026-11-24T11:55:00Z',
      namespace: 'discourse',
      kind: 'Pod',
      name: 'discourse',
      reason: 'FailedScheduling',
      message: '0/3 nodes',
      count: 35,
      firstSeen: '2026-11-24T09:00:00Z',
      events: 2,
    };
    const [row] = eventRows([base], NOW, de);
    expect(row).toMatchObject({
      object: 'Pod discourse/discourse',
      when: 'vor 5 min',
      repeat: '35× seit 3 h',
      merged: '2 Kubernetes-Events zusammengefasst',
    });
    expect(eventRows([base], NOW, en)[0]).toMatchObject({
      repeat: '35× in 3 h',
      merged: '2 Kubernetes events merged',
    });
    expect(eventRows([{ ...base, count: 1, events: 1 }], NOW, de)[0]).toMatchObject({
      repeat: null,
      merged: null,
    });
  });
});

describe('errors', () => {
  it('words too many pairing attempts in both languages, encrypted or plain', () => {
    expect(describeError(new AgentError(429, 'PAIRING_RATE_LIMITED', 'x'), de)).toBe(
      'Zu viele Kopplungsversuche. Code prüfen und in ein paar Minuten nochmal versuchen.',
    );
    const plain = new HttpErrorResponse({ status: 429, error: { code: 'PAIRING_RATE_LIMITED' } });
    expect(describeError(plain, en)).toBe(
      'Too many pairing attempts. Check the code and try again in a few minutes.',
    );
  });
});
