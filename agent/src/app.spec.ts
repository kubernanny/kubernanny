import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, toBase64Url } from '@kubernanny/protocol';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Agent } from './agent';
import { IdentityService } from './auth/identity.service';
import { DemoKubeClient } from './demo/demo-cluster';
import { call } from './e2e/internal-server';
import { CLOCK_WINDOW_MS } from './e2e/e2e.service';
import { CONTENT_SECURITY_POLICY } from './security/http-security';
import { renderMetrics } from './metrics/exporter';
import { StatusService } from './status/status.service';
import { PairingService } from './pairing/pairing';
import { Notifier } from './notify/notifier';
import { E2eClient } from './testing/e2e-client';

describe('agent against the demo cluster', () => {
  let app: Agent;
  const kube = new DemoKubeClient();
  const socket = join(mkdtempSync(join(tmpdir(), 'kubernanny-')), 'agent.sock');
  /** A device paired in beforeAll; every view test talks through it. */
  let phone: E2eClient;
  const client = () => new E2eClient(app.getHttpServer(), app.get(IdentityService).publicKey);
  async function paired(name: string): Promise<{ client: E2eClient; deviceId: string }> {
    const c = client();
    const { body } = await c.post('/pair', { code: app.get(PairingService).issue(), name }, 200);
    return { client: c, deviceId: body.deviceId };
  }

  beforeAll(async () => {
    delete process.env.PULSE_TOKEN;
    delete process.env.DEMO;
    // The assertions below read the reviewed German copy; English has its own tests at the end.
    process.env.LANGUAGE = 'de';
    process.env.CLUSTER_NAME = 'home';
    process.env.CHECK_INTERVAL_SECONDS = '3600';
    process.env.POD_NAMESPACE = 'kubernanny';
    process.env.INTERNAL_SOCKET = socket;
    const moduleRef = new Agent({ kube: kube });
    app = moduleRef;
    await app.init();
    await app.get(StatusService).refresh();
    phone = (await paired('Testhandy')).client;
  });

  afterAll(async () => {
    await app.close();
    delete process.env.INTERNAL_SOCKET;
    delete process.env.LANGUAGE;
  });

  it('creates its key pair in a Secret on first start and publishes only the public key', async () => {
    const identity = app.get(IdentityService);
    expect(identity.persistent).toBe(true);
    expect(kube.writes[0]).toMatchObject({ method: 'POST', path: '/api/v1/namespaces/kubernanny/secrets' });
    expect(JSON.stringify(kube.writes[0])).toContain('kubernanny-identity');
    const { body } = await request(app.getHttpServer()).get('/api/identity').expect(200);
    expect(body).toEqual({ publicKey: identity.publicKey, fingerprint: identity.fingerprint });
    expect(JSON.stringify(body)).not.toContain(toBase64Url(identity.keyPair.secretKey));
  });

  it('pairs a device by its public key with a one-time code', async () => {
    const c = client();
    const code = app.get(PairingService).issue();
    const { body } = await c.post('/pair', { code, name: 'Nicos iPhone' }, 200);
    expect(body).toMatchObject({ cluster: 'home' });
    await c.get('/status', 200);
    // Once only, and nothing else for an unknown key.
    const other = client();
    expect((await other.post('/pair', { code, name: 'x' }, 401)).body.code).toBe('PAIRING_CODE_INVALID');
    expect((await other.post('/pair', {}, 401)).body.code).toBe('PAIRING_CODE_INVALID');
    expect((await other.get('/status', 401)).body.code).toBe('DEVICE_UNKNOWN');
  });

  it('stores public keys only', async () => {
    const { client: c } = await paired('Laptop');
    const stored = JSON.stringify(kube.writes.filter((w) => JSON.stringify(w).includes('kubernanny-devices')));
    expect(stored).toContain(toBase64Url(c.device.publicKey));
    expect(stored).not.toContain(toBase64Url(c.device.secretKey));
  });

  it('lists devices and revokes one, which then stops working at once', async () => {
    const { client: old, deviceId } = await paired('Altes Handy');
    const list = (await old.get('/devices', 200)).body;
    const me = list.find((d: { id: string }) => d.id === deviceId);
    expect(me).toMatchObject({ name: 'Altes Handy', current: true });
    expect(me.lastSeenAt).not.toBeNull();
    expect(JSON.stringify(list)).not.toContain('publicKey');

    await phone.delete(`/devices/${deviceId}`, 204);
    expect((await old.get('/status', 401)).body.code).toBe('DEVICE_UNKNOWN');
    await phone.delete(`/devices/${deviceId}`, 404);
    await phone.delete('/devices/not-a-uuid', 400);
  });

  it('announces a revocation through the channels before it takes effect, naming both devices', async () => {
    const { deviceId } = await paired('Zweithandy');
    const alert = vi.spyOn(app.get(Notifier), 'securityAlert');
    await phone.delete(`/devices/${deviceId}`, 204);
    expect(alert).toHaveBeenCalledWith('Testhandy', [{ kind: 'deviceRevoked', device: 'Zweithandy' }]);
    alert.mockRestore();
  });

  it('cleans device names before they reach logs and lists', async () => {
    const { deviceId } = await paired('evil\n[Nest] fake <script>');
    const list = (await phone.get('/devices', 200)).body;
    expect(list.find((d: { id: string }) => d.id === deviceId).name).toBe('evil Nest fake script');
  });

  it('lets a paired device create a code (and a link with the agent key) for the next one', async () => {
    const { body } = await phone.post('/pair/code', undefined, 200);
    expect(body.app).toContain(`key=${app.get(IdentityService).publicKey}`);
    await client().post('/pair', { code: body.code }, 200);
  });

  it('refuses a replayed request, even from a paired device', async () => {
    const sealed = phone.seal('POST', '/status/refresh');
    expect((await phone.post_raw(sealed.body)).status).toBe(200);
    const again = await phone.post_raw(sealed.body);
    expect(again.status).toBe(400);
    expect(JSON.parse(again.body.toString())).toEqual({ code: 'E2E_REPLAY' });
  });

  it('refuses a request whose clock is off, and says the agent time authenticated', async () => {
    const skewed = phone.seal('GET', '/status', undefined, Date.now() - CLOCK_WINDOW_MS - 60_000);
    const res = await phone.post_raw(skewed.body);
    const inner = skewed.open(new Uint8Array(res.body));
    expect(inner.status).toBe(401);
    expect(Math.abs(inner.time - Date.now())).toBeLessThan(5000);
    expect(JSON.parse(new TextDecoder().decode(inner.body)).code).toBe('E2E_CLOCK_SKEW');
  });

  it('refuses requests sealed for another agent key, and tampered ones', async () => {
    const impostor = new E2eClient(app.getHttpServer(), toBase64Url(generateKeyPair().publicKey), phone.device);
    expect((await impostor.get('/status')).body).toEqual({ code: 'E2E_HANDSHAKE' });
    const sealed = phone.seal('GET', '/status');
    sealed.body[60] ^= 1;
    expect((await phone.post_raw(sealed.body)).status).toBe(400);
    expect((await phone.post_raw(new Uint8Array([2, 1, 2]))).status).toBe(400);
  });

  it('keeps every API route off the public port', async () => {
    for (const path of ['/api/status', '/api/devices', '/api/pair/code', '/api/info']) {
      const res = await request(app.getHttpServer()).get(path).set('x-kubernanny-principal', 'admin');
      expect([401, 404]).toContain(res.status);
    }
    await request(app.getHttpServer()).post('/api/pair/code').set('x-kubernanny-principal', 'admin').expect(401);
    await request(app.getHttpServer()).post('/api/pair').send({ code: 'x' }).expect(404);
  });

  it('serves the admin CLI over the internal socket only', async () => {
    const res = await call(socket, 'admin', 'POST', '/pair/code/banner');
    expect(res.status).toBe(200);
    expect(res.body.toString()).toContain(app.get(IdentityService).fingerprint);
    // A device may not ask for the banner, and the public port never serves it.
    expect((await phone.post('/pair/code/banner', undefined)).status).toBe(403);
    await request(app.getHttpServer()).post('/api/pair/code/banner').expect(401);
  });

  it('sends security headers, and no-store for the API', async () => {
    const res = await request(app.getHttpServer()).post('/api/e2e').set('content-type', 'application/octet-stream').send(Buffer.from(phone.seal('GET', '/status').body)).expect(200);
    expect(res.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
    expect(res.headers['content-security-policy']).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-powered-by']).toBeUndefined();
    // A forwarded header is any caller's word; HSTS is the TLS terminator's job.
    const https = await request(app.getHttpServer()).get('/healthz').set('x-forwarded-proto', 'https');
    expect(https.headers['strict-transport-security']).toBeUndefined();
  });

  it('refuses oversized bodies', async () => {
    await request(app.getHttpServer()).post('/api/e2e').set('content-type', 'application/octet-stream').send(Buffer.alloc(70_000, 1)).expect(413);
    const huge = await phone.post('/notify/test', { pad: 'y'.repeat(10_000) });
    expect(huge.status).toBe(413);
  });

  it('answers /healthz in plain, nothing else', async () => {
    await request(app.getHttpServer()).get('/healthz').expect(200, { ok: true });
    await request(app.getHttpServer()).get('/api/status').expect(401);
    await request(app.getHttpServer()).get('/api/status').set({ authorization: 'Bearer wrong' }).expect(401);
  });

  it('recognises the components of the cluster by their images', async () => {
    const { body } = await phone.get('/status', 200);
    const ids = body.modules.map((m: { id: string }) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'nodes',
        'etcd',
        'pods',
        'volumes',
        'longhorn',
        'local-path',
        'argocd',
        'argocd-image-updater',
        'cnpg',
        'redis',
        'cert-manager',
        'infisical',
        'prometheus',
        'alertmanager',
        'grafana',
        'loki',
        'promtail',
        'kube-state-metrics',
        'node-exporter',
        'blackbox-exporter',
        'metrics-server',
        'traefik',
        'coredns',
        'calico',
        'kured',
        'system-upgrade-controller',
        'descheduler',
        'weblate',
        'discourse',
        'pgadmin',
        'kubernanny',
      ]),
    );
    expect(body.kubernetes).toEqual({ version: 'v1.33.4+rke2r1', distribution: 'RKE2' });
    expect(body.overview).toMatchObject({ nodes: { ready: 3, total: 3 }, prometheus: true, metricsServer: true });
  });

  it('links components to their ingress and reports their own numbers', async () => {
    const { body } = await phone.get('/status', 200);
    const byId = Object.fromEntries(body.modules.map((m: { id: string }) => [m.id, m]));
    expect(byId.grafana.links).toEqual([{ label: 'monitoring.home.example', url: 'https://monitoring.home.example' }]);
    expect(byId.grafana.version).toBe('12.1.0');
    expect(byId.argocd.stats).toEqual(expect.arrayContaining([{ label: 'Apps', value: '14' }]));
    expect(byId.longhorn.stats.find((s: { label: string }) => s.label === 'Platte frei').value).toBe('271 GiB von 640 GiB');
    expect(byId.prometheus.summary).toBe('Scrape-Ziel blackbox down (1)');
    expect(byId.kured.summary).toBe('kured-Sperre hängt seit 3 h');
  });

  it('finds the problems a homelab really has', async () => {
    const { body } = await phone.get('/status', 200);
    const ids = body.issues.map((i: { id: string }) => i.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'pods/default/Deployment/social-importer',
        'pods/discourse/Deployment/discourse',
        'jobs/default/appstore-metrics-reviews',
        'volumes/discourse/uploads',
        'nodes/rke2-node-5/disk',
        'prometheus/down/blackbox',
      ]),
    );
    expect(ids).toEqual(expect.arrayContaining(['argocd/argocd/weblate-chart/sync', 'cnpg/default/shop-api-pg/backup', 'certificates/weblate/weblate-tls', 'alertmanager/BlackboxProbeFailed', 'kured/lock']));
    // Kubernetes 1.33 ended in June 2026, Gatus sees the forum down, Velero's nightly run partly failed.
    expect(ids).toEqual(expect.arrayContaining(['kubernetes-support/1.33', 'gatus/group/shop', 'velero/daily-apps']));
    expect(body.light).toBe('red');
    expect(body.score).toBeGreaterThan(10);
    expect(body.score).toBeLessThan(40);
    // Critical first.
    expect(body.issues[0].severity).toBe('critical');
  });

  it('serves the detail views', async () => {
    const nodes = (await phone.get('/nodes', 200)).body;
    expect(nodes).toHaveLength(3);
    expect(nodes[2]).toMatchObject({ name: 'rke2-node-5', rebooting: true, disk: 0.88, roles: ['control-plane', 'etcd', 'master'] });
    expect(nodes[0].cpu.usedMilli).toBe(1730);

    const workloads = (await phone.get('/workloads', 200)).body;
    const importer = workloads.find((w: { name: string }) => w.name === 'social-importer');
    expect(importer).toMatchObject({ health: 'critical', restarts: 14 });
    expect(workloads.find((w: { name: string }) => w.name === 'monitoring-chart-grafana').component).toBe('Grafana');

    const storage = (await phone.get('/storage', 200)).body;
    expect(storage.classes.find((c: { name: string }) => c.name === 'longhorn')).toMatchObject({ isDefault: true, expansion: true });
    const prom = storage.volumes.find((v: { name: string }) => v.name.startsWith('data-prometheus'));
    expect(prom.used).toBeGreaterThan(40 * 2 ** 30);
    expect(prom.longhorn).toMatchObject({ robustness: 'healthy', replicas: 3 });

    const network = (await phone.get('/network', 200)).body;
    const weblate = network.ingresses.find((i: { hosts: string[] }) => i.hosts[0] === 'translate.shop.example');
    expect(weblate.certificate.daysLeft).toBe(9);
    expect(network.loadBalancers[0].addresses).toEqual(['10.0.0.1', '10.0.0.4', '10.0.0.5']);

    const events = (await phone.get('/events', 200)).body;
    expect(events[0].reason).toBe('BackOff');

    const history = (await phone.get('/history?hours=6', 200)).body;
    expect(history.source).toBe('prometheus');
    expect(history.series.map((s: { id: string }) => s.id)).toEqual(
      expect.arrayContaining(['cpu', 'memory', 'net-in', 'net-out', 'restarts', 'etcd-fsync', 'node-cpu:rke2-node-1', 'node-memory:rke2-node-5']),
    );
  });

  it('groups repeated warnings about one object in the events view', async () => {
    const events = (await phone.get('/events', 200)).body;
    const scheduling = events.filter((e: { reason: string; name: string }) => e.reason === 'FailedScheduling' && e.name === 'discourse');
    expect(scheduling).toHaveLength(1);
    expect(scheduling[0]).toMatchObject({ count: 35, events: 2 });
    expect(Date.parse(scheduling[0].firstSeen)).toBeLessThan(Date.parse(scheduling[0].time));
  });

  it('serves the incident history: the demo week plus what is open now, newest first', async () => {
    const { body } = await phone.get('/incidents?days=7', 200);
    expect(Date.now() - Date.parse(body.coveredSince)).toBeGreaterThan(6 * 86_400_000);
    expect(body.days).toBe(7);
    const resolved = body.incidents.filter((i: { end: string | null }) => i.end !== null);
    expect(resolved.length).toBeGreaterThanOrEqual(7);
    expect(body.incidents.find((i: { issueId: string }) => i.issueId === 'pods/default/Deployment/social-importer')).toMatchObject({ end: null, severity: 'critical', module: 'pods' });
    expect(resolved.find((i: { issueId: string }) => i.issueId === 'nodes/rke2-node-5/not-ready').title).toBe('Node rke2-node-5 NotReady');
    const starts = body.incidents.map((i: { start: string }) => i.start);
    expect(starts).toEqual([...starts].sort().reverse());
    // Only seven days are kept; anything larger is the week, anything smaller at least one day.
    expect((await phone.get('/incidents?days=30', 200)).body.days).toBe(7);
    expect((await phone.get('/incidents?days=0', 200)).body.days).toBe(1);
  });

  it('serves the backups of every kind the modules read, worst first', async () => {
    const { body } = await phone.get('/backups', 200);
    expect(body.maxAgeHours).toBe(26);
    expect(new Set(body.rows.map((r: { kind: string }) => r.kind))).toEqual(new Set(['cnpg', 'longhorn', 'etcd', 'velero']));
    expect(body.rows[0].state).not.toBe('ok');
    expect(body.rows.find((r: { id: string }) => r.id === 'cnpg/default/shop-api-pg')).toMatchObject({ state: 'warning', note: 'Älter als 26 h', target: { type: 's3' } });
    expect(body.rows.find((r: { id: string }) => r.id === 'velero/daily-apps')).toMatchObject({ state: 'warning', count: 3 });
    expect(body.rows.find((r: { id: string }) => r.id === 'etcd')).toMatchObject({ state: 'ok', count: 7 });
    expect(body.targets).toEqual([{ kind: 'longhorn', name: 'default', type: 's3', location: 's3://shop-backups@eu-central-2/longhorn-backups', available: true }]);
    expect(body.unprotected.map((u: { name: string }) => u.name)).toEqual(['data-prometheus-monitoring-chart-kube-prom-prometheus-0', 'data-loki-0']);
  });

  it('restarts the workload the issue names and serves logs of the crashed run', async () => {
    const issue = 'pods/default/Deployment/social-importer';
    const { body } = await phone.post(`/actions/restart?${new URLSearchParams({ issue })}`, undefined, 200);
    expect(body.done).toContain('social-importer');
    expect(kube.writes.at(-1)).toMatchObject({ method: 'PATCH', path: '/apis/apps/v1/namespaces/default/deployments/social-importer' });

    const logs = (await phone.get(`/logs?${new URLSearchParams({ issue })}`, 200)).body;
    expect(logs).toMatchObject({ container: 'social', previous: true });
    expect(logs.text).toContain('code 190');
  });

  it('starts a CNPG backup from the backup issue', async () => {
    await phone.post(`/actions/cnpg-backup?${new URLSearchParams({ issue: 'cnpg/default/shop-api-pg/backup' })}`, undefined, 200);
    expect(kube.writes.at(-1)).toMatchObject({ method: 'POST', path: '/apis/postgresql.cnpg.io/v1/namespaces/default/backups' });
  });

  it('refuses actions an issue does not offer, and issues that are gone', async () => {
    const before = kube.writes.length;
    await phone.post(`/actions/cnpg-backup?${new URLSearchParams({ issue: 'pods/default/Deployment/social-importer' })}`, undefined, 404);
    await phone.post(`/actions/restart?${new URLSearchParams({ issue: 'pods/kube-system/Deployment/coredns' })}`, undefined, 409);
    await phone.post(`/actions/delete-everything?${new URLSearchParams({ issue: 'x' })}`, undefined, 400);
    expect(kube.writes).toHaveLength(before);
  });

  it('switches modules, actions and notifications from the app, stored in a ConfigMap', async () => {
    const before = (await phone.get('/settings', 200)).body;
    expect(before.modules.find((m: { id: string }) => m.id === 'argocd')).toMatchObject({ state: 'on', detected: true, deep: true });
    expect(before.modules.find((m: { id: string }) => m.id === 'nodes')).toMatchObject({ category: 'core', state: 'on' });
    expect(before.actions.map((a: { type: string }) => a.type)).toEqual(['restart', 'argocd-sync', 'argocd-refresh', 'argocd-rollback', 'cnpg-backup', 'logs']);
    // Opt-in: locked until the deployment names it, and the app cannot switch it on.
    expect(before.actions.find((a: { type: string }) => a.type === 'argocd-rollback').state).toBe('locked');
    expect((await phone.post('/settings', { actions: { 'argocd-rollback': true } })).status).toBe(403);
    expect(before.modules.find((m: { id: string }) => m.id === 'argocd').rollbacks).toBeUndefined();

    await phone.post('/settings', { modules: { argocd: false }, actions: { restart: false } }, 200);
    await app.get(StatusService).refresh();
    kube.lists.length = 0;
    await app.get(StatusService).refresh();
    expect(kube.lists.some((p) => p.includes('argoproj.io'))).toBe(false);
    const status = (await phone.get('/status', 200)).body;
    expect(status.modules.map((m: { id: string }) => m.id)).not.toContain('argocd');
    expect(status.issues.flatMap((i: { actions: { type: string }[] }) => i.actions.map((a) => a.type))).not.toContain('restart');
    const refused = await phone.post(`/actions/restart?${new URLSearchParams({ issue: 'pods/default/Deployment/social-importer' })}`, undefined);
    expect([403, 404]).toContain(refused.status);
    expect(kube.writes.some((w) => w.path.endsWith('/configmaps') && JSON.stringify(w.body).includes('kubernanny-settings'))).toBe(true);

    const back = (await phone.post('/settings', { modules: { argocd: true }, actions: { restart: true } }, 200)).body;
    expect(back.modules.find((m: { id: string }) => m.id === 'argocd').state).toBe('on');
    await app.get(StatusService).refresh();
    expect((await phone.get('/status', 200)).body.modules.map((m: { id: string }) => m.id)).toContain('argocd');
  });

  it('silences an issue: still listed, but no longer part of light and score', async () => {
    const before = (await phone.get('/status', 200)).body;
    const critical = before.issues.filter((i: { severity: string }) => i.severity === 'critical');
    for (const issue of critical) {
      await phone.post(`/issues/silence?${new URLSearchParams({ issue: issue.id, hours: '8' })}`, undefined, 200);
    }
    const after = (await phone.get('/status', 200)).body;
    expect(after.issues.filter((i: { silencedUntil?: string }) => i.silencedUntil)).toHaveLength(critical.length);
    expect(after.light).not.toBe('red');
    expect(after.score).toBeGreaterThan(before.score);
    expect((await phone.post(`/issues/silence?${new URLSearchParams({ issue: critical[0].id, hours: '5' })}`)).status).toBe(400);
    for (const issue of critical) {
      await phone.post(`/issues/unsilence?${new URLSearchParams({ issue: issue.id })}`, undefined, 204);
    }
    expect((await phone.get('/status', 200)).body.light).toBe('red');
  });

  it('holds notifications during a maintenance window, keeps the light honest, and ends it early on request', async () => {
    const started = (await phone.post('/maintenance?hours=2', undefined, 200)).body;
    const during = (await phone.get('/status', 200)).body;
    expect(during.maintenanceUntil).toBe(started.maintenanceUntil);
    expect(during.light).toBe('red');
    expect((await phone.post('/maintenance?hours=3')).status).toBe(400);
    await phone.post('/maintenance/end', undefined, 204);
    expect((await phone.get('/status', 200)).body.maintenanceUntil).toBeUndefined();
  });

  it('refuses unknown switches', async () => {
    expect((await phone.post('/settings', { modules: { 'no-such-thing': false } })).status).toBe(400);
    expect((await phone.post('/settings', { actions: { 'delete-everything': true } })).status).toBe(400);
  });

  it('exports its state for Prometheus', () => {
    const text = renderMetrics(app.get(StatusService).snapshot());
    expect(text).toContain('kubernanny_light 2');
    expect(text).toMatch(/kubernanny_issues\{severity="critical"\} \d+/);
    expect(text).toContain('kubernanny_module_status{module="longhorn",category="storage"}');
  });

  describe('languages', () => {
    it('answers a sealed request with language "en" in English, end to end', async () => {
      const english = new E2eClient(app.getHttpServer(), app.get(IdentityService).publicKey, phone.device, 'en');
      const { body } = await english.get('/status', 200);
      const byId = Object.fromEntries(body.modules.map((m: { id: string }) => [m.id, m]));
      expect(byId.prometheus.summary).toBe('Scrape target blackbox down (1)');
      expect(byId.kured.summary).toBe('kured lock held for 3 h');
      expect(byId.nodes).toMatchObject({ name: 'Nodes', description: 'Reachability, pressure and load of the machines.' });
      expect(byId.longhorn.stats.find((s: { label: string }) => s.label === 'Disk free').value).toBe('271 GiB of 640 GiB');
      const titles = Object.fromEntries(body.issues.map((i: { id: string; title: string }) => [i.id, i.title]));
      expect(titles['volumes/discourse/uploads']).toMatch(/^PVC discourse\/uploads pending for \d+ (min|h|days?)$/);
      expect(titles['argocd/argocd/weblate-chart/sync']).toBe('Argo CD app weblate-chart: change waiting for sync');
      // Ids and machine fields do not change with the language.
      const german = (await phone.get('/status', 200)).body;
      expect(body.issues.map((i: { id: string; severity: string }) => [i.id, i.severity])).toEqual(german.issues.map((i: { id: string; severity: string }) => [i.id, i.severity]));
      expect(german.modules.find((m: { id: string }) => m.id === 'prometheus').summary).toBe('Scrape-Ziel blackbox down (1)');
    });

    it('renders settings, history, action errors and channel errors in the request language', async () => {
      const english = new E2eClient(app.getHttpServer(), app.get(IdentityService).publicKey, phone.device, 'en');
      const settings = (await english.get('/settings', 200)).body;
      expect(settings.actions.find((a: { type: string }) => a.type === 'logs')).toMatchObject({ label: 'Read logs', description: 'Show the last lines of a crashed pod.' });
      expect(settings.modules.find((m: { id: string }) => m.id === 'longhorn')).toMatchObject({ name: 'Longhorn', description: 'Replicated block storage across all nodes.' });
      const history = (await english.get('/history?hours=1', 200)).body;
      expect(history.series.every((s: { label: unknown }) => typeof s.label === 'string')).toBe(true);
      expect((await english.post('/actions/restart?issue=nope', undefined, 409)).body).toEqual({ code: 'ISSUE_GONE', message: 'The problem no longer exists.' });
      expect((await phone.post('/actions/restart?issue=nope', undefined, 409)).body).toEqual({ code: 'ISSUE_GONE', message: 'Das Problem besteht nicht mehr.' });
      expect((await english.post('/settings', { modules: { nope: true } }, 400)).body).toEqual({ code: 'SETTING_UNKNOWN', message: 'Unknown module nope.' });
    });

    it('never leaves an unrendered text in a response', async () => {
      const english = new E2eClient(app.getHttpServer(), app.get(IdentityService).publicKey, phone.device, 'en');
      for (const path of ['/status', '/settings', '/nodes', '/workloads', '/storage', '/network', '/events', '/history']) {
        expect(JSON.stringify((await english.get(path, 200)).body), path).not.toContain('"$t"');
      }
    });

    it('answers errors before the dispatch (unknown device) in the request language too', async () => {
      const stranger = new E2eClient(app.getHttpServer(), app.get(IdentityService).publicKey, undefined, 'en');
      expect((await stranger.get('/status', 401)).body).toEqual({ code: 'DEVICE_UNKNOWN', message: 'This device is not paired (any more).' });
    });

    it('ignores the language header on the public port, like the principal header', async () => {
      const res = await request(app.getHttpServer()).get('/api/status').set('x-kubernanny-language', 'en').expect(401);
      expect(res.body).toEqual({ code: 'E2E_REQUIRED', message: 'Nur über den verschlüsselten Kanal (POST /api/e2e).' });
    });
  });
});
