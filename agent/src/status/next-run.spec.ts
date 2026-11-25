import { describe, expect, it } from 'vitest';
import { nextRunAt } from './status.service';

describe('next scheduled run (nextCheckAt)', () => {
  const since = 1_000_000;
  const minute = 60_000;

  it('is the next interval tick, never now itself', () => {
    expect(nextRunAt(since, since, minute, null)).toBe(since + minute);
    expect(nextRunAt(since + 12_000, since, minute, null)).toBe(since + minute);
    expect(nextRunAt(since + minute, since, minute, null)).toBe(since + 2 * minute);
  });

  it('is a pending early run when that comes first, the tick otherwise', () => {
    expect(nextRunAt(since + 10_000, since, minute, since + 15_000)).toBe(since + 15_000);
    expect(nextRunAt(since + 50_000, since, minute, since + 75_000)).toBe(since + minute);
  });

  it('is unknown before the schedule runs, unless an early run waits', () => {
    expect(nextRunAt(since, null, minute, null)).toBeNull();
    expect(nextRunAt(since, null, minute, since + 5_000)).toBe(since + 5_000);
  });
});
