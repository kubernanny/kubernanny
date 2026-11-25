import { describe, expect, it } from 'vitest';
import { de, en } from '../../testing/i18n';
import { CephCluster, evaluateRookCeph } from './rook-ceph';

const NOW = new Date('2026-11-25T12:00:00Z');
const TiB = 2 ** 40;

function cluster(ceph: NonNullable<CephCluster['status']>['ceph'], extra: Partial<NonNullable<CephCluster['status']>> = {}): CephCluster {
  return { metadata: { name: 'rook-ceph', namespace: 'rook-ceph' }, status: { phase: 'Ready', ceph: { lastChecked: '2026-11-25T11:59:20Z', ...ceph }, ...extra } };
}

describe('evaluateRookCeph', () => {
  it('stays quiet on HEALTH_OK below 75 %', () => {
    expect(evaluateRookCeph([cluster({ health: 'HEALTH_OK', capacity: { bytesTotal: 10 * TiB, bytesUsed: 7.4 * TiB } })], NOW)).toEqual([]);
  });

  it('reports HEALTH_WARN as a warning with Ceph checks, errors first, at most three', () => {
    const [issue] = evaluateRookCeph(
      [
        cluster({
          health: 'HEALTH_WARN',
          details: {
            RECENT_CRASH: { message: '1 daemons have recently crashed', severity: 'HEALTH_WARN' },
            OSD_NEARFULL: { message: '1 nearfull osd(s)', severity: 'HEALTH_WARN' },
            PG_DEGRADED: { message: 'Degraded data redundancy', severity: 'HEALTH_WARN' },
            MON_DOWN: { message: '1/3 mons down', severity: 'HEALTH_WARN' },
          },
        }),
      ],
      NOW,
    );
    expect(issue).toMatchObject({ id: 'rook-ceph/rook-ceph/rook-ceph/health', severity: 'warning' });
    expect(en(issue!.cause)).toBe('Ceph reports: RECENT_CRASH: 1 daemons have recently crashed; OSD_NEARFULL: 1 nearfull osd(s); PG_DEGRADED: Degraded data redundancy (and 1 more). Details: ceph health detail in the toolbox.');
  });

  it('makes HEALTH_ERR critical and names the erroring check first', () => {
    const [issue] = evaluateRookCeph(
      [cluster({ health: 'HEALTH_ERR', details: { RECENT_CRASH: { message: 'crash', severity: 'HEALTH_WARN' }, OSD_FULL: { message: '1 full osd(s)', severity: 'HEALTH_ERR' } } })],
      NOW,
    );
    expect(issue!.severity).toBe('critical');
    expect(de(issue!.title)).toBe('Ceph rook-ceph: HEALTH_ERR');
    expect(en(issue!.cause)).toMatch(/^Ceph reports: OSD_FULL: 1 full osd\(s\); RECENT_CRASH/);
  });

  it('warns from 75 % raw use and is critical from 85 %', () => {
    const at = (share: number) => evaluateRookCeph([cluster({ health: 'HEALTH_OK', capacity: { bytesTotal: 10 * TiB, bytesUsed: share * 10 * TiB } })], NOW).map((i) => i.severity);
    expect(at(0.749)).toEqual([]);
    expect(at(0.75)).toEqual(['warning']);
    expect(at(0.85)).toEqual(['critical']);
  });

  it("reports the operator's Failure condition and a status Rook stopped updating", () => {
    const failed = evaluateRookCeph([cluster({ health: 'HEALTH_OK' }, { phase: 'Failure', conditions: [{ type: 'Failure', status: 'True', message: 'failed to create cluster: mons not quorate' }] })], NOW);
    expect(failed.map((i) => [i.id, i.severity, en(i.cause)])).toEqual([['rook-ceph/rook-ceph/rook-ceph/operator', 'warning', 'failed to create cluster: mons not quorate']]);
    const stale = evaluateRookCeph([cluster({ health: 'HEALTH_OK', lastChecked: '2026-11-25T11:30:00Z' })], NOW);
    expect(stale.map((i) => en(i.title))).toEqual(['Status of Ceph rook-ceph is stale']);
  });
});
