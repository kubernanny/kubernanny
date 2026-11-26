import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ClusterConfig } from './agent.model';
import { AgentClient } from './agent-client.service';
import { AgentError } from './agent-error';
import { ClusterStore } from './cluster-store.service';
import { isTransient } from './describe-error';
import { QUIET_RETRY_MS, StatusStore } from './status-store.service';

const cluster: ClusterConfig = {
  id: 'c1',
  name: 'home',
  url: 'http://10.0.0.5',
  agentKey: 'k',
  deviceKey: 'd',
  deviceId: 'x',
  demo: undefined,
};

function storeWith(status: () => Promise<unknown>) {
  TestBed.configureTestingModule({
    providers: [
      { provide: AgentClient, useValue: { status, info: async () => ({}) } },
      {
        provide: ClusterStore,
        useValue: {
          loaded: Promise.resolve(),
          clusters: () => [cluster],
          find: () => cluster,
          save: async (c: ClusterConfig) => c,
        },
      },
    ],
  });
  return TestBed.inject(StatusStore);
}

describe('a rolling update of the agent (no "offline" flash)', () => {
  afterEach(() => {
    vi.useRealTimers();
    TestBed.resetTestingModule();
  });

  it('tells transient failures from real ones', () => {
    expect(isTransient(new HttpErrorResponse({ status: 0 }))).toBe(true);
    expect(isTransient(new HttpErrorResponse({ status: 503 }))).toBe(true);
    expect(
      isTransient(new HttpErrorResponse({ status: 502, error: { code: 'RELAY_AGENT_OFFLINE' } })),
    ).toBe(true);
    expect(isTransient(new AgentError(503, 'AGENT_HANDOVER', 'being updated'))).toBe(true);
    expect(isTransient(new HttpErrorResponse({ status: 404 }))).toBe(false);
    expect(isTransient(new AgentError(403, 'ACTION_DISABLED', ''))).toBe(false);
  });

  it('keeps the last snapshot and shows no error while the agent comes back within the quiet retries', async () => {
    vi.useFakeTimers();
    const good = { cluster: 'home', light: 'green' };
    let calls = 0;
    const store = storeWith(async () => {
      calls++;
      if (calls === 1 || calls >= 4) {
        return good;
      }
      throw new HttpErrorResponse({ status: 0 });
    });
    await store.refresh(cluster);
    expect(store.states()['c1']).toMatchObject({ snapshot: good, error: null });

    const second = store.refresh(cluster);
    for (const ms of QUIET_RETRY_MS) {
      await vi.advanceTimersByTimeAsync(ms);
      expect(store.states()['c1'].error).toBeNull();
      expect(store.states()['c1'].snapshot).toEqual(good);
    }
    await second;
    expect(calls).toBe(4);
    expect(store.states()['c1']).toMatchObject({ snapshot: good, error: null, loading: false });
  });

  it('shows the error once the quiet retries are used up, and at once for one that is not transient', async () => {
    vi.useFakeTimers();
    const store = storeWith(async () => {
      throw new HttpErrorResponse({ status: 0 });
    });
    const done = store.refresh(cluster);
    await vi.advanceTimersByTimeAsync(QUIET_RETRY_MS.reduce((a, b) => a + b, 0));
    await done;
    expect(store.states()['c1'].error).not.toBeNull();

    TestBed.resetTestingModule();
    let calls = 0;
    const strict = storeWith(async () => {
      calls++;
      throw new HttpErrorResponse({ status: 404 });
    });
    await strict.refresh(cluster);
    expect(calls).toBe(1);
    expect(strict.states()['c1'].error).not.toBeNull();
  });
});
