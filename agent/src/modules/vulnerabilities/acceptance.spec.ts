import { describe, expect, it, vi } from 'vitest';

import { Config, loadConfig } from '../../config';
import { DemoKubeClient } from '../../demo/demo-cluster';
import { Notifier } from '../../notify/notifier';
import { SettingsService } from '../../settings/settings.service';
import { cleanReason, DAY, parseAccepted } from './acceptance';
import { AcceptanceService } from './acceptance.service';
import { applyAcceptance, ComponentFindings, vulnerabilityIssue } from './evaluate';

const who = { kind: 'device' as const, id: 'd1', name: 'Test' };

function setup(config: Partial<Config> = {}, kube = new DemoKubeClient()) {
  const cfg = { ...loadConfig(), ...config };
  const settings = new SettingsService(cfg, kube);
  const securityAlert = vi.fn(async () => undefined);
  const service = new AcceptanceService(cfg, kube, settings, { securityAlert } as unknown as Notifier);
  return { service, settings, kube, securityAlert, cfg };
}

const component = (findings: string[]): ComponentFindings => ({
  key: 'cnpg',
  name: 'CloudNativePG',
  version: '1.26.1',
  reachable: true,
  findings: findings.map((id) => ({ id, level: 'critical' as const, score: 9.9, fixed: '1.28.3' })),
});

describe('accepting an advisory', () => {
  it('stores it for the chosen days in the settings ConfigMap, announces it first, and survives a restart', async () => {
    const { service, kube, securityAlert, cfg } = setup();
    await service.onModuleInit();
    const until = await service.accept('cnpg', 'GHSA-423p-g724-fr39', 90, '  only the\noperator, not exposed ', who, 0);
    expect(until).toBe(new Date(90 * DAY).toISOString());
    expect(securityAlert).toHaveBeenCalledWith('Test', [
      { kind: 'advisoryAccepted', component: 'cnpg', advisory: 'GHSA-423p-g724-fr39', days: 90 },
    ]);
    expect(JSON.stringify(kube.writes.at(-1))).toContain('accepted');

    const restarted = new AcceptanceService(cfg, kube, new SettingsService(cfg, kube));
    await restarted.onModuleInit();
    const a = restarted.state(DAY).accepted.get('cnpg|GHSA-423p-g724-fr39');
    expect(a).toEqual({ until: 90 * DAY, at: 0, by: 'Test', reason: 'only the operator, not exposed' });
    // Expired: no longer there.
    expect(restarted.state(91 * DAY).accepted.size).toBe(0);
    await restarted.unaccept('cnpg', 'GHSA-423p-g724-fr39', who, DAY);
    expect(restarted.state(DAY).accepted.size).toBe(0);
  });

  it('refuses other durations, odd ids and a reason that is not text', async () => {
    const { service } = setup();
    await expect(service.accept('cnpg', 'GHSA-1', 7, undefined, who)).rejects.toMatchObject({ status: 400 });
    await expect(service.accept('../x', 'GHSA-1', 30, undefined, who)).rejects.toMatchObject({ status: 400 });
    await expect(service.accept('cnpg', 'javascript:alert(1)?', 30, undefined, who)).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.accept('cnpg', 'GHSA-1', 30, { evil: true }, who)).rejects.toMatchObject({ status: 400 });
  });

  it('is impossible with vulnerabilities.allowAccept: false: refused before reading or writing, stored ones ignored', async () => {
    const kube = new DemoKubeClient();
    const open = setup({}, kube);
    await open.service.onModuleInit();
    await open.service.accept('cnpg', 'GHSA-1', 30, undefined, who, 0);
    const writes = kube.writes.length;

    const locked = setup({ vulnAcceptLocked: true }, kube);
    const get = vi.spyOn(kube, 'get');
    await locked.service.onModuleInit();
    expect(get).not.toHaveBeenCalled();
    await expect(locked.service.accept('cnpg', 'GHSA-2', 30, undefined, who)).rejects.toMatchObject({
      status: 403,
      response: { code: 'ACCEPT_LOCKED' },
    });
    await expect(locked.service.unaccept('cnpg', 'GHSA-1', who)).rejects.toMatchObject({ status: 403 });
    expect(kube.writes.length).toBe(writes);
    expect(locked.securityAlert).not.toHaveBeenCalled();
    expect(locked.service.state(1)).toEqual({ allowed: false, accepted: new Map() });
  });

  it('is refused while both the built-in lookup and the Trivy integration are locked off in Helm', async () => {
    const { service } = setup({ disabledModules: ['vulnerabilities', 'trivy'] });
    expect(service.allowed()).toBe(false);
    await expect(service.accept('cnpg', 'GHSA-1', 30, undefined, who)).rejects.toMatchObject({
      status: 403,
      response: { code: 'MODULE_OFF' },
    });
  });

  it('cleans reasons and stored data', () => {
    expect(cleanReason('a‮b\u0000c   d')).toBe('a b c d');
    expect(cleanReason('x'.repeat(500))).toHaveLength(200);
    expect(cleanReason('   ')).toBeUndefined();
    expect(parseAccepted('{"a|b":{"until":1,"at":0,"by":"x"},"c|d":{"until":"soon"}}')).toEqual(
      new Map([['a|b', { until: 1, at: 0, by: 'x' }]]),
    );
    expect(parseAccepted('not json')).toEqual(new Map());
  });
});

describe('accepted advisories in the check', () => {
  it('no longer count for the issue, and are listed for the module sheet', () => {
    const accepted = new Map([['cnpg|GHSA-a', { until: 10 * DAY, at: 0, by: 'Test', reason: 'not used' }]]);
    const { components, accepted: list } = applyAcceptance([component(['GHSA-a', 'GHSA-b'])], accepted);
    expect(components[0]!.findings.map((f) => f.id)).toEqual(['GHSA-b']);
    expect(list).toEqual([
      {
        component: 'cnpg',
        name: 'CloudNativePG',
        advisory: 'GHSA-a',
        until: new Date(10 * DAY).toISOString(),
        by: 'Test',
        reason: 'not used',
      },
    ]);
    const issue = vulnerabilityIssue(components[0]!)!;
    expect(issue.advisories).toEqual(['GHSA-b']);
    expect(JSON.stringify(issue.cause)).toContain('vulnerabilities.acceptedNote');
  });

  it('makes the issue disappear when nothing else remains', () => {
    const accepted = new Map([['cnpg|GHSA-a', { until: 10 * DAY, at: 0, by: 'Test' }]]);
    const { components } = applyAcceptance([component(['GHSA-a'])], accepted);
    expect(vulnerabilityIssue(components[0]!)).toBeNull();
  });

  it('only matches the same advisory on the same component', () => {
    const accepted = new Map([['longhorn|GHSA-a', { until: 10 * DAY, at: 0, by: 'Test' }]]);
    const { components, accepted: list } = applyAcceptance([component(['GHSA-a'])], accepted);
    expect(components[0]!.findings).toHaveLength(1);
    expect(list).toEqual([]);
  });
});
