import { afterEach, describe, expect, it, vi } from 'vitest';

import { ActionsService, LOG_LIMIT_BYTES } from './actions/actions.service';
import type { Issue } from './checks/types';
import { int, loadConfig, parseChoice, parseDigest, parseSwitch } from './config';
import { DemoKubeClient } from './demo/demo-cluster';
import { errorText, localize, raw, render, reviveText, t } from './i18n/text';
import { upsertConfigMapData } from './kube/configmap';
import { KubeClient, KubeError, MAX_KUBE_ERROR_BODY } from './kube/kube-client';
import { RegistryClient } from './modules/image-updates/registry-client';
import { parseAlerts } from './modules/integrations/alertmanager';
import { Prometheus, ServiceHttp } from './modules/service-proxy';
import { boundStats, capIssues, MAX_ISSUES_PER_MODULE, str, strings } from './modules/untrusted';
import { OSV_MAX_IDS_PER_QUERY, OsvClient, sanitize } from './modules/vulnerabilities/osv-client';
import { parseNotified } from './notify/notified-store';
import { escapeDiscord, escapeSlack, Notifier, webhookBody } from './notify/notifier';
import { SilenceService } from './silence/silence.service';
import { logSafe } from './util/log-safe';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('H1: Texts are only what the agent made', () => {
  it('leaves look-alike objects from outside input as data, whatever key they name', () => {
    for (const key of ['valueOf', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'raw', 'common.yes']) {
      const out = localize({ stats: [{ value: { $t: key } }] }, 'en') as unknown as { stats: { value: unknown }[] };
      expect(out.stats[0]!.value).toEqual({ $t: key });
    }
  });

  it('renders own keys only, and a parameter of the wrong shape never throws', () => {
    expect(render({ $t: 'valueOf' } as never, 'en')).toBe('valueOf');
    expect(render(t('grafana.database.cause', { state: { evil: true } as never }), 'en')).toContain('{"evil":true}');
    expect(() => render(t('common.sentences', { parts: 'not a list' as never }), 'en')).not.toThrow();
  });

  it('revives stored Texts only with known keys and plain parameters', () => {
    expect(reviveText({ $t: 'raw', p: { text: 'x' } })).toEqual(raw('x'));
    expect(render(reviveText({ $t: 'raw', p: { text: 'x' } })!, 'en')).toBe('x');
    expect(reviveText({ $t: 'valueOf' })).toBeNull();
    expect(reviveText({ $t: 'raw', p: { text: { toString: 'x' } } })).toBeNull();
    const stored = JSON.stringify({
      v: 1,
      issues: { a: { s: 'c', t: { $t: 'constructor' } }, b: { s: 'w', t: raw('ok') } },
    });
    expect([...parseNotified(stored).keys()]).toEqual(['b']);
  });

  it('coerces and caps every field of an untrusted answer', () => {
    expect(str({ $t: 'valueOf' })).toBeUndefined();
    expect(str('a\nb‮c')).toBe('a b c');
    expect(str('x'.repeat(1000))!.length).toBe(300);
    expect(strings({ a: 'x', b: { $t: 'raw' }, c: 3 })).toEqual({ a: 'x', c: '3' });
    expect(parseAlerts({ not: 'a list' })).toEqual([]);
    expect(parseAlerts([{ labels: { alertname: { $t: 'valueOf' } } }])[0]!.labels).toEqual({});
    expect(boundStats([{ label: t('stat.version'), value: { $t: 'valueOf' } as never }])[0]!.value).toBe('?');
  });

  it('cuts the issues of one untrusted module to a summary', () => {
    const issues: Issue[] = Array.from({ length: 120 }, (_, i) => ({
      id: `x/${i}`,
      check: 'x',
      severity: i === 119 ? 'critical' : 'warning',
      title: raw(''),
      cause: raw(''),
      actions: [],
    }));
    const capped = capIssues(issues, 'x');
    expect(capped).toHaveLength(MAX_ISSUES_PER_MODULE);
    expect(capped[0]!.id).toBe('x/119');
    expect(capped.at(-1)).toMatchObject({ id: 'x/more', severity: 'warning' });
    expect(render(capped.at(-1)!.title, 'en')).toBe('71 more reports');
  });

  it('reads a forged Prometheus answer without throwing on its shape', async () => {
    const http = {
      get: async () => ({
        status: 'success',
        data: { result: [{ metric: { job: { $t: 'x' }, ok: 'y' }, value: [0, '3'] }, { value: 'nope' }, 'junk'] },
      }),
    } as unknown as ServiceHttp;
    expect(await new Prometheus(http).query('up')).toEqual([{ metric: { ok: 'y' }, value: 3 }]);
    const bad = {
      get: async () => ({ status: 'success', data: { result: { not: 'an array' } } }),
    } as unknown as ServiceHttp;
    expect(await new Prometheus(bad).query('up')).toEqual([]);
  });
});

describe('M2: every switch refuses what it does not know', () => {
  it('accepts on/off/true/false/1/0 and nothing else', () => {
    expect(parseSwitch('X', 'OFF', true)).toBe(false);
    expect(parseSwitch('X', '1', false)).toBe(true);
    expect(parseSwitch('X', undefined, true)).toBe(true);
    expect(() => parseSwitch('VULN_ACCEPT', 'of', true)).toThrow(/VULN_ACCEPT must be on or off/);
    expect(() => parseChoice('NOTIFY_DETAIL', 'minmal', ['full', 'minimal'], 'full')).toThrow(
      /NOTIFY_DETAIL must be one of/,
    );
  });

  it('fails the start on a typo in VULN_ACCEPT, NOTIFY_DETAIL, WEBHOOK_FORMAT, DIGEST and PAIRING_LOG', () => {
    for (const [name, value] of [
      ['VULN_ACCEPT', 'disabled'],
      ['NOTIFY_DETAIL', 'minmal'],
      ['WEBHOOK_FORMAT', 'teams'],
      ['DIGEST', 'weekley'],
      ['PAIRING_LOG', 'no'],
    ]) {
      vi.stubEnv(name!, value!);
      expect(() => loadConfig(), name).toThrow(name);
      vi.unstubAllEnvs();
    }
    vi.stubEnv('VULN_ACCEPT', 'false');
    expect(loadConfig().vulnAcceptLocked).toBe(true);
  });

  it('takes DIGEST_WEEKDAY=0 (Sunday) and DIGEST_HOUR=0, and refuses values out of range', () => {
    expect(parseDigest({ DIGEST: 'weekly', DIGEST_WEEKDAY: '0', DIGEST_HOUR: '0' })).toEqual({ weekday: 0, hour: 0 });
    expect(() => parseDigest({ DIGEST: 'weekly', DIGEST_WEEKDAY: '7' })).toThrow(/DIGEST_WEEKDAY/);
    expect(() => int('DIGEST_HOUR', '9.5', 9, 0, 23)).toThrow();
    expect(parseDigest({})).toBeNull();
  });
});

describe('M3: OSV and registry answers are bounded', () => {
  const NOW = new Date('2026-11-25T00:00:00Z');
  const q = { ecosystem: 'Go', name: 'x', version: '1.0.0' };

  it('refuses redirects and oversized answers', async () => {
    const inits: RequestInit[] = [];
    const big = new OsvClient('https://osv.example', async (_url, init) => {
      inits.push(init!);
      return new Response('x'.repeat(5 * 1024 * 1024));
    });
    await expect(big.lookup([q], NOW)).rejects.toThrow(/unreachable/);
    expect(inits[0]!.redirect).toBe('error');
  });

  it('takes at most OSV_MAX_IDS_PER_QUERY ids per version and caps record arrays', async () => {
    const ids = Array.from({ length: 1000 }, (_, i) => ({ id: `GHSA-${String(i).padStart(4, '0')}` }));
    let details = 0;
    const client = new OsvClient('https://osv.example', async (url) => {
      if (url.endsWith('/v1/querybatch')) {
        return new Response(JSON.stringify({ results: [{ vulns: ids }] }));
      }
      details++;
      return new Response(JSON.stringify({ id: 'x' }));
    });
    const res = await client.lookup([q], NOW);
    expect(res.results[0]).toHaveLength(OSV_MAX_IDS_PER_QUERY);
    expect(details).toBe(OSV_MAX_IDS_PER_QUERY);
    const record = sanitize(
      {
        aliases: Array(500).fill('CVE-2026-1'),
        affected: Array(500).fill({ ranges: Array(500).fill({ events: [] }) }),
      },
      'x',
    );
    expect(record.aliases!.length).toBeLessThanOrEqual(20);
    expect(record.affected!.length).toBeLessThanOrEqual(50);
    expect(record.affected![0]!.ranges!.length).toBeLessThanOrEqual(20);
  });

  it('forgets answers past the stale window', async () => {
    let calls = 0;
    const client = new OsvClient('https://osv.example', async (url) => {
      calls++;
      return new Response(JSON.stringify(url.endsWith('/v1/querybatch') ? { results: [{ vulns: [] }] } : {}));
    });
    await client.lookup([q], NOW);
    const later = new Date(NOW.getTime() + 8 * 86_400_000);
    await client.lookup([{ ...q, version: '2.0.0' }], later);
    expect((client as unknown as { queries: Map<string, unknown> }).queries.size).toBe(1);
    expect(calls).toBe(2);
  });

  it('caps a registry tag list answer', async () => {
    const client = new RegistryClient(async () => new Response('x'.repeat(3 * 1024 * 1024), { status: 200 }));
    const ref = {
      registry: { name: 'ghcr.io', api: 'https://ghcr.io', tokenHosts: ['ghcr.io'] },
      repository: 'a/b',
      tag: '1.0',
    } as never;
    await expect(client.tags(ref, NOW)).rejects.toThrow(/refused/);
  });
});

describe('error texts from outside', () => {
  it('lose control characters and are bounded (pentest finding)', () => {
    const text = render(errorText(new Error('bad\u0007answer\u202e' + 'x'.repeat(500))), 'en');
    expect(text).not.toMatch(/[\p{Cc}\u202e]/u);
    expect(text.length).toBeLessThanOrEqual(300);
  });
});

describe('M5: silencing cannot blind the owner', () => {
  const who = { kind: 'device' as const, id: 'd1', name: 'Phone' };

  it('announces every silenced warning and outage, never a hint', async () => {
    const alerts: unknown[][] = [];
    const notifier = { securityAlert: async (...a: unknown[]) => void alerts.push(a) } as unknown as Notifier;
    const silences = new SilenceService(loadConfig(), new DemoKubeClient(), notifier);
    await silences.onModuleInit();
    await silences.silence('nodes/n1/not-ready', 1, who, 0, 'critical');
    await silences.silence('certificates/a/b', 8, who, 1000, 'warning');
    await silences.silence('security/x/root', 8, who, 2000, 'info');
    expect(alerts).toEqual([
      ['Phone', [{ kind: 'silenced', issue: 'nodes/n1/not-ready', hours: 1 }]],
      ['Phone', [{ kind: 'silenced', issue: 'certificates/a/b', hours: 8 }]],
    ]);
  });

  it('a warning silenced early is no longer silenced once it turns critical (pentest finding)', async () => {
    const silences = new SilenceService(loadConfig(), new DemoKubeClient());
    await silences.onModuleInit();
    await silences.silence('certificates/a/b', 168, who, 0, 'warning');
    expect(silences.silencedUntil('certificates/a/b', 1000, 'warning')).not.toBeNull();
    expect(silences.silencedUntil('certificates/a/b', 1000, 'critical')).toBeNull();
    // A silence set on an outage keeps covering it, and an issue that got better.
    await silences.silence('nodes/n1/not-ready', 1, who, 0, 'critical');
    expect(silences.silencedUntil('nodes/n1/not-ready', 1000, 'critical')).not.toBeNull();
    expect(silences.silencedUntil('nodes/n1/not-ready', 1000, 'warning')).not.toBeNull();
  });

  it('keeps the severity across a restart, and reads silences stored without one as warnings', async () => {
    const kube = new DemoKubeClient();
    const first = new SilenceService(loadConfig(), kube);
    await first.onModuleInit();
    await first.silence('certificates/a/b', 8, who, 0, 'warning');
    const second = new SilenceService(loadConfig(), kube);
    await second.onModuleInit();
    expect(second.silencedUntil('certificates/a/b', 1000, 'critical')).toBeNull();
    expect(second.silencedUntil('certificates/a/b', 1000, 'warning')).not.toBeNull();
  });
});

describe('LOW: log lines and chat messages carry no forged syntax', () => {
  it('escapes control characters in log values', () => {
    expect(logSafe('alertmanager/X\n2026 audit forged')).toBe('alertmanager/X?2026 audit forged');
  });

  it('escapes Slack control syntax and Discord markdown, and allows no Discord mention', () => {
    expect(escapeSlack('<!channel> <@U1> <https://evil|click> & x')).toBe(
      '&lt;!channel&gt; &lt;@U1&gt; &lt;https://evil|click&gt; &amp; x',
    );
    expect(escapeDiscord('@everyone [click](https://evil) **b**')).toBe(
      '\\@everyone \\[click\\]\\(https://evil\\) \\*\\*b\\*\\*',
    );
    const push = { title: '<!here>', body: '[x](https://evil) @everyone', priority: 5, tags: '' };
    const plan = { opened: [], resolved: [], escalated: [] };
    const discord = webhookBody('discord', 'c', push, plan, 'en') as {
      allowed_mentions: unknown;
      embeds: { description: string }[];
    };
    expect(discord.allowed_mentions).toEqual({ parse: [] });
    expect(discord.embeds[0]!.description).not.toContain('](');
    expect(JSON.stringify(webhookBody('slack', 'c', push, plan, 'en'))).not.toContain('<!here>');
  });
});

describe('LOW: Kubernetes responses are bounded', () => {
  it('asks for at most LOG_LIMIT_BYTES of a pod log', async () => {
    const kube = new DemoKubeClient();
    const text = vi.spyOn(kube, 'text').mockResolvedValue('log');
    const status = { findIssue: () => ({ actions: [{ type: 'logs', namespace: 'a', pod: 'p' }] }) };
    const settings = { actionOn: () => true };
    const actions = new ActionsService(kube, status as never, settings as never);
    await actions.logs('pods/a/Deployment/p');
    expect(text.mock.calls[0]![0]).toContain(`limitBytes=${LOG_LIMIT_BYTES}`);
    expect(text.mock.calls[0]![1]).toBe(2 * LOG_LIMIT_BYTES);
  });

  it('fails with a clear message outside a cluster without K8S_API_URL', async () => {
    vi.stubEnv('K8S_API_URL', undefined as never);
    vi.stubEnv('KUBERNETES_SERVICE_HOST', undefined as never);
    delete process.env.K8S_API_URL;
    delete process.env.KUBERNETES_SERVICE_HOST;
    await expect(new KubeClient().get('/version')).rejects.toThrow(/K8S_API_URL/);
  });

  it('reads an error body only up to MAX_KUBE_ERROR_BODY (review: res.json() had no cap)', async () => {
    vi.stubEnv('K8S_API_URL', 'http://kube.test');
    const huge = `{"message":"${'x'.repeat(MAX_KUBE_ERROR_BODY * 4)}"}`;
    const bodies = [JSON.stringify({ kind: 'Status', message: 'configmaps "x" is forbidden' }), huge];
    vi.stubGlobal('fetch', async () => new Response(bodies.shift()!, { status: 403, statusText: 'Forbidden' }));
    try {
      const kube = new KubeClient();
      await expect(kube.get('/a')).rejects.toMatchObject({
        status: 403,
        message: '403 on /a: configmaps "x" is forbidden',
      });
      // Too large to be a Status: refused unread, the status text stands in.
      await expect(kube.get('/b')).rejects.toMatchObject({ status: 403, message: '403 on /b: Forbidden' });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe('QUALITY: one ConfigMap upsert', () => {
  it('creates a missing ConfigMap, and patches when another writer created it first', async () => {
    const kube = new KubeClient();
    const calls: string[] = [];
    let patches = 0;
    vi.spyOn(kube, 'mergePatch').mockImplementation(async () => {
      calls.push('patch');
      if (patches++ === 0) {
        throw new KubeError(404, 'missing');
      }
    });
    vi.spyOn(kube, 'create').mockImplementation(async () => {
      calls.push('create');
      throw new KubeError(409, 'exists');
    });
    await upsertConfigMapData(kube, 'ns', 'cm', { a: '1' });
    expect(calls).toEqual(['patch', 'create', 'patch']);
  });
});
