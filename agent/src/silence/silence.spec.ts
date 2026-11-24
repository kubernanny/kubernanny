import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';
import { raw } from '../i18n/text';
import { DemoKubeClient } from '../demo/demo-cluster';
import { planNotifications } from '../notify/notifier';
import { IssueView } from '../status/status.service';
import { SilenceService } from './silence.service';

const who = { kind: 'device' as const, id: 'd1', name: 'Test' };
const hour = 3_600_000;

describe('silencing issues', () => {
  it('silences for one of the offered durations, expires, and survives a restart', async () => {
    const kube = new DemoKubeClient();
    const first = new SilenceService(loadConfig(), kube);
    await first.onModuleInit();
    const until = await first.silence('pods/a/Deployment/b', 8, who, 0);
    expect(until).toBe(new Date(8 * hour).toISOString());
    expect(first.silencedUntil('pods/a/Deployment/b', hour)).toBe(until);
    expect(first.silencedUntil('pods/a/Deployment/b', 9 * hour)).toBeNull();

    const second = new SilenceService(loadConfig(), kube);
    await second.onModuleInit();
    expect(second.silencedUntil('pods/a/Deployment/b', hour)).toBe(until);
    await second.unsilence('pods/a/Deployment/b', who, hour);
    expect(second.silencedUntil('pods/a/Deployment/b', hour)).toBeNull();
  });

  it('keeps a maintenance window apart from silenced issues, and lets it end early', async () => {
    const kube = new DemoKubeClient();
    const s = new SilenceService(loadConfig(), kube);
    await s.onModuleInit();
    expect(s.maintenanceUntil(0)).toBeNull();
    const until = await s.startMaintenance(2, who, 0);
    expect(until).toBe(new Date(2 * hour).toISOString());
    expect(s.maintenanceUntil(hour)).toBe(until);
    expect(s.maintenanceUntil(2 * hour)).toBeNull();
    await expect(s.startMaintenance(3, who, 0)).rejects.toMatchObject({ status: 400 });
    await expect(s.silence('*', 1, who, 0)).rejects.toMatchObject({ status: 400 });
    await s.unsilence('*', who, hour);
    expect(s.maintenanceUntil(hour)).toBe(until);

    const restarted = new SilenceService(loadConfig(), kube);
    await restarted.onModuleInit();
    expect(restarted.maintenanceUntil(hour)).toBe(until);
    await restarted.endMaintenance(who, hour);
    expect(restarted.maintenanceUntil(hour)).toBeNull();
  });

  it('refuses odd durations and missing ids', async () => {
    const s = new SilenceService(loadConfig(), new DemoKubeClient());
    await expect(s.silence('x', 5, who)).rejects.toMatchObject({ status: 400 });
    await expect(s.silence('', 1, who)).rejects.toMatchObject({ status: 400 });
  });

  it('sends nothing new for a silenced issue, and no "resolved" just because it was silenced', () => {
    const issue: IssueView = { id: 'i', check: 'pods', module: 'pods', severity: 'critical', title: raw('t'), cause: raw('c'), actions: [], since: new Date(0).toISOString() };
    const now = new Date(hour);
    expect(planNotifications(new Map(), [{ ...issue, silencedUntil: new Date(2 * hour).toISOString() }], now, 0).opened).toEqual([]);
    const pushed = new Map([['i', { severity: 'critical' as const, title: raw('t') }]]);
    expect(planNotifications(pushed, [{ ...issue, silencedUntil: new Date(2 * hour).toISOString() }], now, 0).resolved).toEqual([]);
    expect(planNotifications(pushed, [], now, 0).resolved).toEqual([{ id: 'i', title: raw('t') }]);
  });
});
