import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN } from '../auth/devices.service';
import { AppModule } from '../app.module';
import { DemoKubeClient } from '../demo/demo-cluster';
import { KubeClient, KubeError } from '../kube/kube-client';
import { renderMetrics } from '../metrics/exporter';
import { Notifier } from '../notify/notifier';
import { SilenceService } from '../silence/silence.service';
import { en } from '../testing/i18n';
import { StatusService, Snapshot, UNREACHABLE_AFTER_RUNS, UNREACHABLE_ISSUE_ID } from './status.service';

/** The demo cluster, with an API server that can stop answering. */
class FlakyKube extends DemoKubeClient {
  down = false;
  override async get<T>(path: string): Promise<T> {
    if (this.down && path === '/apis') {
      throw new KubeError(503, 'connect ECONNREFUSED 10.43.0.1:443');
    }
    return super.get<T>(path);
  }
}

describe('API server unreachable (review: was silent)', () => {
  let moduleRef: TestingModule;
  afterEach(async () => {
    await moduleRef.close();
  });

  async function start() {
    process.env.CHECK_INTERVAL_SECONDS = '3600';
    const kube = new FlakyKube(undefined, 'healthy');
    const pushed: Snapshot[] = [];
    const notifier = { channels: ['ntfy'], update: async (s: Snapshot) => void pushed.push(s), securityAlert: async () => undefined, test: async () => [] };
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(KubeClient).useValue(kube).overrideProvider(Notifier).useValue(notifier).compile();
    const status = moduleRef.get(StatusService);
    await status.refresh();
    return { kube, status, pushed };
  }

  it('keeps the last good checkedAt, adds failingSince, and turns red with one critical issue after three failed runs', async () => {
    const { kube, status, pushed } = await start();
    const good = status.snapshot();
    expect(good.light).toBe('green');
    expect(good.failingSince).toBeUndefined();

    kube.down = true;
    await status.refresh();
    const blip = status.snapshot();
    expect(blip.checkedAt).toBe(good.checkedAt);
    expect(blip.failingSince).toBeDefined();
    expect(blip.light).toBe('yellow');
    expect(blip.issues.map((i) => i.id)).not.toContain(UNREACHABLE_ISSUE_ID);

    for (let i = 1; i < UNREACHABLE_AFTER_RUNS; i++) {
      await status.refresh();
    }
    const down = en(status.snapshot());
    expect(down.light).toBe('red');
    expect(down.checkedAt).toBe(good.checkedAt);
    expect(down.failingSince).toBe(blip.failingSince);
    const issue = down.issues.find((i) => i.id === UNREACHABLE_ISSUE_ID)!;
    expect(issue).toMatchObject({ severity: 'critical', title: 'Kubernanny cannot read the cluster', since: blip.failingSince });
    expect(issue.cause).toContain('ECONNREFUSED');
    // It goes to the notifier like any issue (which waits NOTIFY_AFTER_SECONDS before pushing).
    expect(pushed.at(-1)!.issues.map((i) => i.id)).toContain(UNREACHABLE_ISSUE_ID);
    // The metrics keep the time of the last run that read the cluster: staleness shows there too.
    expect(renderMetrics(status.snapshot())).toContain(`kubernanny_last_run_timestamp_seconds ${Math.floor(Date.parse(good.checkedAt!) / 1000)}`);

    kube.down = false;
    await status.refresh();
    const back = status.snapshot();
    expect(back.light).toBe('green');
    expect(back.failingSince).toBeUndefined();
    expect(back.error).toBeUndefined();
    expect(back.issues.map((i) => i.id)).not.toContain(UNREACHABLE_ISSUE_ID);
    expect(back.checkedAt).not.toBe(good.checkedAt);
  });

  it('respects a maintenance window like any other issue', async () => {
    const { kube, status, pushed } = await start();
    await moduleRef.get(SilenceService).onModuleInit();
    await moduleRef.get(SilenceService).startMaintenance(2, ADMIN);
    const before = pushed.length;
    kube.down = true;
    for (let i = 0; i < UNREACHABLE_AFTER_RUNS; i++) {
      await status.refresh();
    }
    expect(status.snapshot().issues.map((i) => i.id)).toContain(UNREACHABLE_ISSUE_ID);
    expect(status.snapshot().maintenanceUntil).toBeDefined();
    expect(pushed.length).toBe(before);
  });
});
