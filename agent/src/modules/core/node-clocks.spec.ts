import { describe, expect, it } from 'vitest';

import { emptyInventory } from '../../inventory/inventory';
import { de } from '../../testing/i18n';
import { Prometheus, PromSample } from '../service-proxy';
import { ModuleContext } from '../types';
import { evaluateNodeClocks, NodeClocksCheck } from './node-clocks';

describe('evaluateNodeClocks', () => {
  it('warns above 0.5 s and is critical above 5 s, either direction', () => {
    const issues = evaluateNodeClocks([
      { node: 'a', offset: 0.5 },
      { node: 'b', offset: -0.51 },
      { node: 'c', offset: 5.2 },
    ]);
    expect(issues.map((i) => [i.id, i.severity])).toEqual([
      ['node-clocks/b', 'warning'],
      ['node-clocks/c', 'critical'],
    ]);
    expect(de(issues[0]!.title)).toBe('Uhr von b geht 0,51 s falsch');
  });

  it('warns about a clock the kernel no longer synchronises', () => {
    expect(evaluateNodeClocks([{ node: 'a', offset: 0.01, synchronised: false }]).map((i) => i.severity)).toEqual([
      'warning',
    ]);
  });
});

describe('NodeClocksCheck', () => {
  const inv = emptyInventory(new Date());
  inv.nodes = [
    { metadata: { name: 'n1' }, status: { addresses: [{ type: 'InternalIP', address: '10.0.0.1' }] } },
    { metadata: { name: 'n2' } },
  ] as typeof inv.nodes;
  const prom = (answers: Record<string, PromSample[]>) =>
    ({
      query: async (expr: string) => Object.entries(answers).find(([needle]) => expr.includes(needle))?.[1] ?? [],
    }) as unknown as Prometheus;

  it('maps node-exporter instances to nodes and prefers timex over the ntp collector', async () => {
    const r = await new NodeClocksCheck().run(
      {
        inv,
        prom: prom({
          node_timex_offset_seconds: [{ metric: { instance: '10.0.0.1:9100' }, value: 0.9 }],
          node_ntp_offset_seconds: [
            { metric: { instance: '10.0.0.1:9100' }, value: 0.001 },
            { metric: { nodename: 'n2' }, value: 7 },
          ],
          node_timex_sync_status: [{ metric: { instance: '10.0.0.1:9100' }, value: 1 }],
        }),
      } as unknown as ModuleContext,
      () => true,
    );
    expect(r.issues.map((i) => [i.id, i.severity])).toEqual([
      ['node-clocks/n1', 'warning'],
      ['node-clocks/n2', 'critical'],
    ]);
  });

  // Real shape: chrony on all three nodes, node-exporter's timex offset is exactly 0 everywhere.
  it("does not take chrony's zero timex offset for a measurement", async () => {
    const r = await new NodeClocksCheck().run(
      {
        inv,
        prom: prom({
          node_timex_offset_seconds: [
            { metric: { instance: '10.0.0.1:9100' }, value: 0 },
            { metric: { nodename: 'n2' }, value: 0 },
          ],
          node_timex_sync_status: [
            { metric: { instance: '10.0.0.1:9100' }, value: 1 },
            { metric: { nodename: 'n2' }, value: 1 },
          ],
          node_timex_maxerror_seconds: [{ metric: { instance: '10.0.0.1:9100' }, value: 0.210436 }],
          node_timex_estimated_error_seconds: [
            { metric: { instance: '10.0.0.1:9100' }, value: 0.000071 },
            { metric: { nodename: 'n2' }, value: 0.000409 },
          ],
        }),
      } as unknown as ModuleContext,
      () => true,
    );
    expect(r.issues).toEqual([]);
    expect(de(r.summary)).toBe('2 Uhren synchronisiert');
    expect(de(r.stats).map((s) => [s.label, s.value])).toEqual([
      ['Synchronisiert', '2/2'],
      ['Geschätzter Fehler', '< 1 ms'],
    ]);
  });

  it('without Prometheus raises nothing and says why', async () => {
    const r = await new NodeClocksCheck().run({ inv, prom: null } as unknown as ModuleContext, () => true);
    expect(r.issues).toEqual([]);
    expect(de(r.summary)).toBe('Ohne Prometheus nicht messbar');
  });
});
