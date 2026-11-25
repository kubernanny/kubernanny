import { describe, expect, it } from 'vitest';
import { de, en } from '../testing/i18n';
import { cronText } from './format';
import { checkNotifyUrl, loadConfig } from '../config';
import { CATALOG } from '../discovery/catalog';
import { distribution, imageVersion } from '../discovery/discovery';
import { emptyInventory, parseQuantity } from '../inventory/inventory';
import { detectFormat, webhookBody } from '../notify/notifier';
import type { IdentityService } from '../auth/identity.service';
import { CODE_TTL_MS, MAX_FAILURES_PER_WINDOW, PairingService, terminalQr } from '../pairing/pairing';
import { KubeClient } from '../kube/kube-client';
import { ServiceHttp } from './service-proxy';
import { lightFor, scoreFor } from '../status/status.service';
import { bytes, evaluateJobs, evaluateNodeUsage, evaluateVolumes, evaluateWorkloads } from './core';

const fakeIdentity = { publicKey: 'A'.repeat(43), fingerprint: '0000-0000-0000-0000' } as IdentityService;

const NOW = new Date('2026-11-24T12:00:00Z');
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

const recognise = (image: string) => CATALOG.find((e) => e.images.some((re) => re.test(image)))?.id;

describe('catalog', () => {
  it.each([
    ['docker.io/longhornio/longhorn-manager:v1.9.0', 'longhorn'],
    ['quay.io/argoproj/argocd:v3.1.2', 'argocd'],
    ['quay.io/argoprojlabs/argocd-image-updater:v0.17.0', 'argocd-image-updater'],
    ['quay.io/jetstack/cert-manager-controller:v1.18.2', 'cert-manager'],
    ['quay.io/jetstack/cert-manager-webhook:v1.18.2', undefined],
    ['ghcr.io/cloudnative-pg/cloudnative-pg:1.26.1', 'cnpg'],
    ['ghcr.io/cloudnative-pg/postgis:17-3.5', 'postgres'],
    ['docker.io/grafana/grafana:12.1.0', 'grafana'],
    ['quay.io/kiwigrid/k8s-sidecar:1.30.0', undefined],
    ['rancher/mirrored-library-traefik:3.3.6', 'traefik'],
    ['ghcr.io/kubereboot/kured:1.17.1', 'kured'],
    ['ghcr.io/home-assistant/home-assistant:2026.11', 'home-assistant'],
    ['vaultwarden/server:1.34.1', 'vaultwarden'],
    ['ghcr.io/immich-app/immich-server:v2.1.0', 'immich'],
    ['nginx:1.29', undefined],
  ])('%s -> %s', (image, id) => {
    expect(recognise(image)).toBe(id);
  });

  it('has unique ids', () => {
    expect(new Set(CATALOG.map((e) => e.id)).size).toBe(CATALOG.length);
  });
});

describe('discovery helpers', () => {
  it('reads the version from the image tag', () => {
    expect(imageVersion('quay.io/argoproj/argocd:v3.1.2')).toBe('3.1.2');
    expect(imageVersion('registry:5000/grafana/grafana:12.1.0@sha256:abc')).toBe('12.1.0');
    expect(imageVersion('registry:5000/grafana/grafana')).toBeUndefined();
  });

  it('tells the distribution from the kubelet version', () => {
    const inv = emptyInventory(NOW);
    inv.nodes = [{ metadata: { name: 'n' }, status: { nodeInfo: { kubeletVersion: 'v1.33.4+k3s1' } } }];
    expect(distribution(inv)).toBe('k3s');
  });

  it('parses Kubernetes quantities', () => {
    expect(parseQuantity('1536Mi')).toBe(1536 * 2 ** 20);
    expect(parseQuantity('250m')).toBe(0.25);
    expect(parseQuantity('2')).toBe(2);
    expect(parseQuantity('1.5G')).toBe(1.5e9);
    expect(en(bytes(1536 * 2 ** 20))).toBe('1.5 GiB');
    expect(de(bytes(1536 * 2 ** 20))).toBe('1,5 GiB');
    expect(de(bytes(15 * 2 ** 30))).toBe('15 GiB');
    expect(de(cronText('0 0 2 * * *'))).toBe('täglich 02:00');
    expect(en(cronText('30 4 * * 1'))).toBe('every Monday at 04:30');
    expect(de(cronText('*/5 * * * *'))).toBe('*/5 * * * *');
  });
});

describe('core evaluations', () => {
  it('warns at 90 % memory and 85 % disk', () => {
    const inv = emptyInventory(NOW);
    inv.nodes = [{ metadata: { name: 'n1' }, status: { allocatable: { memory: '10Gi' } } }];
    inv.nodeUsage = new Map([['n1', { cpuMilli: 100, memBytes: 9.5 * 2 ** 30 }]]);
    const issues = de(evaluateNodeUsage(inv, new Map([['n1', 0.96]])));
    expect(issues.map((i) => [i.id, i.severity])).toEqual([
      ['nodes/n1/memory', 'warning'],
      ['nodes/n1/disk', 'critical'],
    ]);
  });

  it('reports the failed newest run of a CronJob, not older ones', () => {
    const inv = emptyInventory(NOW);
    const owner = [{ kind: 'CronJob', name: 'backup' }];
    inv.jobs = [
      { metadata: { name: 'backup-1', namespace: 'x', ownerReferences: owner, creationTimestamp: ago(2000) }, status: { conditions: [{ type: 'Failed', status: 'True' }] } },
      { metadata: { name: 'backup-2', namespace: 'x', ownerReferences: owner, creationTimestamp: ago(600) }, status: { completionTime: ago(590) } },
    ];
    expect(de(evaluateJobs(inv))).toEqual([]);
    inv.jobs.push({ metadata: { name: 'backup-3', namespace: 'x', ownerReferences: owner, creationTimestamp: ago(30) }, status: { conditions: [{ type: 'Failed', status: 'True', message: 'BackoffLimitExceeded' }] } });
    expect(de(evaluateJobs(inv))).toMatchObject([{ id: 'jobs/x/backup', cause: 'BackoffLimitExceeded' }]);
  });

  it('reports PVCs that hang, got lost or run full', () => {
    const inv = emptyInventory(NOW);
    inv.pvcs = [
      { metadata: { name: 'new', namespace: 'a', creationTimestamp: ago(1) }, status: { phase: 'Pending' } },
      { metadata: { name: 'stuck', namespace: 'a', creationTimestamp: ago(30) }, status: { phase: 'Pending' } },
      { metadata: { name: 'gone', namespace: 'a' }, status: { phase: 'Lost' } },
      { metadata: { name: 'full', namespace: 'a' }, status: { phase: 'Bound' } },
    ];
    const issues = de(evaluateVolumes(inv, new Map([['a/full', { used: 9, capacity: 10 }]])));
    expect(issues.map((i) => [i.id, i.severity])).toEqual([
      ['volumes/a/stuck', 'warning'],
      ['volumes/a/gone', 'critical'],
      ['volumes/a/full/full', 'warning'],
    ]);
  });

  it('reports a stuck rollout once, unless crashing pods already explain it', () => {
    const inv = emptyInventory(NOW);
    inv.deployments = [
      { metadata: { name: 'web', namespace: 'd', creationTimestamp: ago(600) }, spec: { replicas: 2 }, status: { readyReplicas: 0 } },
      { metadata: { name: 'fresh', namespace: 'd', creationTimestamp: ago(1) }, spec: { replicas: 1 }, status: { readyReplicas: 0 } },
    ];
    expect(de(evaluateWorkloads(inv, new Set())).map((i) => [i.id, i.severity])).toEqual([['workloads/d/Deployment/web', 'critical']]);
    expect(de(evaluateWorkloads(inv, new Set(['d/Deployment/web'])))).toEqual([]);
  });
});

describe('notifications and pairing', () => {
  it('detects the webhook format from the URL', () => {
    expect(detectFormat('https://discord.com/api/webhooks/1/abc', 'auto')).toBe('discord');
    expect(detectFormat('https://hooks.slack.com/services/T/B/x', 'auto')).toBe('slack');
    expect(detectFormat('https://gotify.example/message?token=x', 'auto')).toBe('gotify');
    expect(detectFormat('https://n8n.example/webhook/kubernanny', undefined)).toBe('json');
    expect(detectFormat('https://n8n.example/webhook/kubernanny', 'slack')).toBe('slack');
  });

  it('colours Discord embeds by severity', () => {
    const body = webhookBody('discord', 'home', { title: 't', body: 'b', priority: 5, tags: '' }, { opened: [], resolved: [], escalated: [] }, 'de') as {
      embeds: { color: number }[];
    };
    expect(body.embeds[0].color).toBe(0xff5c6c);
  });

  it('builds app and web links that carry a one-time code and the agent key to pin', () => {
    process.env.PUBLIC_URL = 'https://kubernanny.example.com/';
    process.env.WEB_ROOT = '/app/web';
    const pairing = new PairingService(loadConfig(), fakeIdentity);
    const links = pairing.links('ABCDE23456');
    expect(links.app).toBe(`kubernanny://pair?url=https%3A%2F%2Fkubernanny.example.com&code=ABCDE23456&name=cluster&key=${fakeIdentity.publicKey}`);
    expect(links.web).toBe(`https://kubernanny.example.com/#/pair?code=ABCDE23456&name=cluster&key=${fakeIdentity.publicKey}`);
    delete process.env.PUBLIC_URL;
    delete process.env.WEB_ROOT;
  });

  it('prints the pairing banner in the language of LANGUAGE', async () => {
    const english = await new PairingService({ ...loadConfig(), language: 'en' }, fakeIdentity).banner('ABCDE23456');
    expect(english).toContain('Pairing code: ABCDE-23456 (single use, valid for 60 minutes).');
    expect(english).toContain('Kubernanny for cluster is ready.');
    const german = await new PairingService({ ...loadConfig(), language: 'de' }, fakeIdentity).banner('ABCDE23456');
    expect(german).toContain('Pairing-Code: ABCDE-23456 (einmal verwendbar, 60 Minuten gültig).');
    expect(german).toContain('QR als Bild (falls der Code im Log nicht scannbar ist): https://kubernanny.app/qr#kubernanny%3A%2F%2Fpair%3F');
  });

  it('links the QR code as an image, with the app link in the fragment', () => {
    const pairing = new PairingService(loadConfig(), fakeIdentity);
    const links = pairing.links('ABCDE23456');
    expect(links.image).toBe(`https://kubernanny.app/qr#${encodeURIComponent(links.app)}`);
    // One decode on the page gives the app link back, its own encoding intact.
    expect(decodeURIComponent(new URL(links.image).hash.slice(1))).toBe(links.app);
  });

  it('prints the QR code without ANSI escapes, light modules as blocks, the image link right under it', async () => {
    const banner = await new PairingService({ ...loadConfig(), language: 'en' }, fakeIdentity).banner('ABCDE23456');
    expect(banner).not.toMatch(/\x1b/);
    const qr = terminalQr('kubernanny://pair?url=https%3A%2F%2Fa&code=ABCDE23456');
    const rows = qr.split('\n');
    // Quiet zone of four light modules on top: two full lines of blocks, as wide as the code.
    const width = rows[0].length;
    expect(rows[0]).toBe('█'.repeat(width));
    expect(rows[1]).toBe('█'.repeat(width));
    // Then the finder pattern starts four modules in: light quiet zone, dark module (blank).
    expect(rows[2].slice(0, 4)).toBe('████');
    expect(rows[2][4]).not.toBe('█');
    // Half blocks: about 1 column per module plus the zone, well under 80 columns.
    expect(width).toBeLessThan(80);
    const lines = banner.split('\n');
    const imageLine = lines.findIndex((l) => l.startsWith('QR as an image'));
    expect(lines[imageLine - 1]).toMatch(/[█▀▄]/);
  });

  it('refuses the removed PULSE_TOKEN instead of ignoring it', () => {
    process.env.PULSE_TOKEN = 'x'.repeat(32);
    expect(() => loadConfig()).toThrow(/PULSE_TOKEN is gone/);
    delete process.env.PULSE_TOKEN;
  });

  it('scores 100 without issues and keeps telling many issues apart', () => {
    expect(scoreFor([])).toBe(100);
    expect(scoreFor([{ severity: 'warning' }])).toBe(95);
    expect(scoreFor([{ severity: 'critical' }, { severity: 'warning' }])).toBe(78);
    expect(scoreFor(Array.from({ length: 9 }, () => ({ severity: 'critical' as const })))).toBe(17);
    expect(scoreFor([{ severity: 'info' }, { severity: 'info' }])).toBe(100);
  });

  it('keeps the light green with only hints', () => {
    expect(lightFor([{ status: 'ok' }], [{ severity: 'info' }])).toBe('green');
  });
});

describe('pairing codes', () => {
  const pairing = () => new PairingService(loadConfig(), fakeIdentity);

  it('work once, in any case and with a dash', () => {
    const p = pairing();
    const code = p.issue(0);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{10}$/);
    expect(p.redeem(`${code.slice(0, 5).toLowerCase()}-${code.slice(5)}`, 1000)).toBe('ok');
    expect(p.redeem(code, 2000)).toBe('invalid');
  });

  it('expire after an hour', () => {
    const p = pairing();
    const code = p.issue(0);
    expect(p.redeem(code, CODE_TTL_MS + 1)).toBe('invalid');
  });

  it('are not burnt by wrong guesses: the right one still works after the throttle engaged', () => {
    const p = pairing();
    const code = p.issue(0);
    for (let i = 0; i <= MAX_FAILURES_PER_WINDOW; i++) {
      p.redeem('WRONGCODE0', 1);
    }
    expect(p.redeem('WRONGCODE0', 1)).toBe('throttled');
    expect(p.redeem(code, 2)).toBe('ok');
  });

  it('replaces an older code when a new one is issued', () => {
    const p = pairing();
    const first = p.issue(0);
    p.issue(0);
    expect(p.redeem(first, 1)).toBe('invalid');
  });
});

describe('reaching in-cluster services', () => {
  it('goes straight to the service DNS name inside a pod, needing no services/proxy grant', async () => {
    const kube = new KubeClient();
    Object.defineProperty(kube, 'inCluster', { get: () => true });
    const svc = { metadata: { name: 'prometheus-operated', namespace: 'monitoring' }, spec: { ports: [{ port: 9090 }] } };
    const http = ServiceHttp.forService(kube, svc, [9090])!;
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      calls.push(url);
      return new Response('{}');
    }) as typeof fetch;
    try {
      await http.get('/api/v1/query?query=up');
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toEqual(['http://prometheus-operated.monitoring.svc:9090/api/v1/query?query=up']);
  });
});

describe('notification URLs', () => {
  it('accept https, and http only inside the cluster', () => {
    expect(checkNotifyUrl('NTFY_URL', 'https://ntfy.sh/topic')).toBe('https://ntfy.sh/topic');
    expect(checkNotifyUrl('NTFY_URL', 'http://ntfy.ntfy.svc/topic')).toBe('http://ntfy.ntfy.svc/topic');
    expect(checkNotifyUrl('NTFY_URL', 'http://ntfy.ntfy.svc.cluster.local/topic')).toBe('http://ntfy.ntfy.svc.cluster.local/topic');
    expect(() => checkNotifyUrl('WEBHOOK_URL', 'http://hooks.example.com/x')).toThrow(/https/);
    expect(() => checkNotifyUrl('WEBHOOK_URL', 'ftp://x')).toThrow(/https/);
    expect(() => checkNotifyUrl('WEBHOOK_URL', 'not a url')).toThrow(/not a URL/);
  });
});
