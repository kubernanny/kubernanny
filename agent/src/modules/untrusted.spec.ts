import { describe, expect, it } from 'vitest';

import { Detected } from '../discovery/discovery';
import { raw } from '../i18n/text';
import { emptyInventory } from '../inventory/inventory';
import { KubeClient } from '../kube/kube-client';
import { INTEGRATIONS } from './integrations';
import { Integration } from './module';
import { readCapped } from './service-proxy';
import { ModuleContext, ModuleResult } from './types';

const ctx = (prom: unknown): ModuleContext => ({
  inv: emptyInventory(new Date()),
  kube: new KubeClient(),
  config: {} as ModuleContext['config'],
  now: new Date(),
  prom: prom as ModuleContext['prom'],
  data: {},
});
const det = { entry: { id: 'x' }, services: [], workloads: [], links: [] } as unknown as Detected;
const restart = { type: 'restart' as const, kind: 'Deployment' as const, namespace: 'a', name: 'b' };

class Probe extends Integration {
  readonly id = 'probe';
  readonly reads = [];
  override readonly actions = ['restart'] as const;
  seenProm: unknown = 'unset';
  constructor(readonly trusted: boolean) {
    super();
    Object.defineProperty(this, 'untrusted', { value: !trusted });
  }
  protected async inspect(c: ModuleContext): Promise<ModuleResult> {
    this.seenProm = c.prom;
    return {
      issues: [
        {
          id: 'i',
          check: 'pods',
          severity: 'critical',
          title: raw('t'),
          cause: raw('c'),
          actions: [restart, { type: 'logs', namespace: 'a', pod: 'p' }],
        },
      ],
      stats: [],
      summary: raw(''),
    };
  }
  tryHttp(c: ModuleContext) {
    return this.http(c, det, [80]);
  }
}

describe('trust of integrations', () => {
  it('keeps the Prometheus client and in-cluster HTTP away from trusted integrations', async () => {
    const trusted = new Probe(true);
    await trusted.run(ctx({ fake: true }), det, () => true);
    expect(trusted.seenProm).toBeNull();
    expect(() => trusted.tryHttp(ctx(null))).toThrow(/untrusted = true/);
  });

  it('strips every action from untrusted integrations, undeclared and switched-off ones from all', async () => {
    const untrusted = await new Probe(false).run(ctx(null), det, () => true);
    expect(untrusted.issues[0]!.actions).toEqual([]);
    const trusted = await new Probe(true).run(ctx(null), det, () => true);
    // logs is not declared by Probe.
    expect(trusted.issues[0]!.actions).toEqual([restart]);
    const off = await new Probe(true).run(ctx(null), det, (t) => t !== 'restart');
    expect(off.issues[0]!.actions).toEqual([]);
  });

  it('names a declared action that is switched off in `unavailable`, with why; never for an untrusted integration', async () => {
    const lock: ModuleContext['actionLock'] = (type) =>
      type === 'restart'
        ? { state: 'locked', lockedBy: 'disabled', label: raw('Restart'), description: raw('d') }
        : null;
    const off = await new Probe(true).run({ ...ctx(null), actionLock: lock }, det, (t) => t !== 'restart');
    expect(off.issues[0]!.actions).toEqual([]);
    expect(off.issues[0]!.unavailable).toEqual([
      { type: 'restart', state: 'locked', lockedBy: 'disabled', label: raw('Restart'), description: raw('d') },
    ]);
    // Undeclared (logs) and allowed actions are not listed; nothing at all when everything is on.
    const on = await new Probe(true).run({ ...ctx(null), actionLock: lock }, det, () => true);
    expect(on.issues[0]!.unavailable).toBeUndefined();
    const untrusted = await new Probe(false).run({ ...ctx(null), actionLock: lock }, det, (t) => t !== 'restart');
    expect(untrusted.issues[0]!.unavailable).toBeUndefined();
  });

  it('marks the integrations that act on the cluster as trusted, the HTTP readers as untrusted', () => {
    const flagged = INTEGRATIONS.filter((i) => i.untrusted).map((i) => i.id);
    expect(flagged).toEqual(expect.arrayContaining(['prometheus', 'alertmanager', 'grafana', 'loki', 'kured']));
    expect(flagged).not.toContain('argocd');
    expect(flagged).not.toContain('cnpg');
  });

  it('refuses a response beyond the size limit instead of buffering it', async () => {
    const big = new Response('x'.repeat(2048));
    await expect(readCapped(big, 1024)).rejects.toThrow(/refused/);
    const declared = new Response('small', { headers: { 'content-length': '999999999' } });
    await expect(readCapped(declared, 1024)).rejects.toThrow(/refused/);
    expect(await readCapped(new Response('ok'), 1024)).toBe('ok');
  });
});
