import { describe, expect, it } from 'vitest';
import { Prometheus, PROM_CONCURRENCY } from './service-proxy';

describe('Prometheus queries of one run', () => {
  it('run at most PROM_CONCURRENCY at a time and are timed', async () => {
    let active = 0;
    let peak = 0;
    const http = {
      get: async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { status: 'success', data: { result: [] } };
      },
    };
    const prom = new Prometheus(http as never);
    await Promise.all(Array.from({ length: 30 }, (_, i) => prom.query(`q${i}`)));
    expect(peak).toBe(PROM_CONCURRENCY);
    expect(prom.timings).toHaveLength(30);
  });
});
