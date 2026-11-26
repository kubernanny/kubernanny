import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { translatorFor } from '../i18n/translator';
import { buildClusterView } from '../cluster/cluster-view';
import { Snapshot } from './agent.model';
import { KNOWN_AGENT_VERSION, olderThan } from './version';

describe('agent version', () => {
  it('is the version the agent declares', () => {
    const agent = readFileSync(join(__dirname, '../../../../agent/src/version.ts'), 'utf8');
    expect(agent).toContain(`AGENT_VERSION = '${KNOWN_AGENT_VERSION}'`);
  });

  it('compares numerically', () => {
    expect(olderThan('0.9.1', '0.10.0')).toBe(true);
    expect(olderThan('v0.3.0', '0.3.0')).toBe(false);
    expect(olderThan('0.4.0', '0.3.9')).toBe(false);
    expect(olderThan('0.3.0-rc.1', '0.3.0')).toBe(false);
  });

  it('suggests an update only for an older agent', () => {
    const base = { cluster: 'c', light: 'green', score: 100, checkedAt: new Date().toISOString(), durationMs: 1, agentVersion: '0.3.0', kubernetes: null, overview: null, modules: [], issues: [] } as Snapshot;
    expect(buildClusterView({ ...base, agentVersion: '0.2.0' }, null, new Date(), translatorFor('de')).update?.command).toContain('helm upgrade');
    expect(buildClusterView({ ...base, agentVersion: KNOWN_AGENT_VERSION }, null, new Date(), translatorFor('de')).update).toBeNull();
    expect(buildClusterView(base, null, new Date(), translatorFor('de')).update).toBeNull();
  });
});
