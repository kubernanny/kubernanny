import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StatusStore } from '../status-store.service';
import { WidgetBridge } from './widget-bridge';
import { WIDGET_REFRESH_TIMEOUT_MS, WidgetRefresh } from './widget-refresh.service';
import { WidgetSync } from './widget-sync.service';

describe('WidgetRefresh', () => {
  let order: string[];
  let finishRound: () => void;
  let status: { refreshAll: ReturnType<typeof vi.fn> };
  let sync: { loaded: Promise<void>; sync: ReturnType<typeof vi.fn> };
  let bridge: { moveToBack: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    order = [];
    status = {
      refreshAll: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            order.push('refresh');
            finishRound = () => {
              order.push('answered');
              resolve();
            };
          }),
      ),
    };
    sync = { loaded: Promise.resolve(), sync: vi.fn(async () => void order.push('written')) };
    bridge = { moveToBack: vi.fn(async () => (order.push('back'), true)) };
    TestBed.configureTestingModule({
      providers: [
        { provide: StatusStore, useValue: status },
        { provide: WidgetSync, useValue: sync },
        { provide: WidgetBridge, useValue: bridge },
      ],
    });
  });

  afterEach(() => vi.useRealTimers());

  it('asks the agents, writes the widget, then goes back to the home screen', async () => {
    const run = TestBed.inject(WidgetRefresh).run();
    await vi.waitFor(() => expect(status.refreshAll).toHaveBeenCalled());
    finishRound();
    await run;
    expect(order).toEqual(['refresh', 'answered', 'written', 'back']);
  });

  it('joins a run under way instead of starting another', async () => {
    const refresh = TestBed.inject(WidgetRefresh);
    const first = refresh.run();
    const second = refresh.run();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(status.refreshAll).toHaveBeenCalled());
    finishRound();
    await first;
    expect(status.refreshAll).toHaveBeenCalledTimes(1);
    expect(bridge.moveToBack).toHaveBeenCalledTimes(1);
  });

  it('stays open when the person touched the app meanwhile', async () => {
    const run = TestBed.inject(WidgetRefresh).run();
    await vi.waitFor(() => expect(status.refreshAll).toHaveBeenCalled());
    document.dispatchEvent(new Event('pointerdown'));
    finishRound();
    await run;
    expect(sync.sync).toHaveBeenCalled();
    expect(bridge.moveToBack).not.toHaveBeenCalled();
  });

  it('goes back after the timeout when an agent does not answer', async () => {
    vi.useFakeTimers();
    const run = TestBed.inject(WidgetRefresh).run();
    await vi.advanceTimersByTimeAsync(WIDGET_REFRESH_TIMEOUT_MS);
    await run;
    expect(order).toEqual(['refresh', 'written', 'back']);
  });
});
