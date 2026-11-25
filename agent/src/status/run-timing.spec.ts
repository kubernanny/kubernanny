import { describe, expect, it } from 'vitest';
import { de } from '../testing/i18n';
import { runTiming } from './run-timing';

describe('run timing on the Kubernanny sheet', () => {
  it('names the phases, the Prometheus queries and the slowest modules and queries', () => {
    const sections = de(
      runTiming({
        inventoryMs: 42,
        componentsMs: 880,
        coreMs: 140,
        totalMs: 1103,
        moduleMs: new Map([['prometheus', 610], ['longhorn', 90], ['nodes', 120]]),
        prometheus: [
          { expr: 'up == 0', ms: 35 },
          { expr: 'count by (job) (up)', ms: 410 },
        ],
      }),
    );
    expect(sections.map((s) => s.title)).toEqual(['Letzte Prüfung', 'Langsamste Module', 'Langsamste Prometheus-Abfragen']);
    const phases = sections[0]!.kind === 'list' ? sections[0]!.rows : [];
    expect(phases.map((r) => [r.name, r.value])).toEqual([
      ['Cluster lesen', '42 ms'],
      ['Komponenten (parallel)', '880 ms'],
      ['Kubernetes-Checks (danach, parallel)', '140 ms'],
      ['Prometheus', '2 Abfragen'],
      ['Gesamt', '1.103 ms'],
    ]);
    expect(phases[3]!.sub).toBe('2 Abfragen, zusammen 445 ms, die längste 410 ms, höchstens 8 gleichzeitig');
    expect(sections[1]!.kind === 'list' && sections[1]!.rows.map((r) => r.name)).toEqual(['prometheus', 'nodes', 'longhorn']);
  });
});
