import { describe, expect, it } from 'vitest';

import type { IdentityService } from '../auth/identity.service';
import type { Config } from '../config';
import { CODE_TTL_MS, FAILURE_WINDOW_MS, MAX_FAILURES_PER_WINDOW, PairingService } from './pairing';

const pairing = () => new PairingService({ clusterName: 'c' } as Config, {} as IdentityService);
const NOW = 1_800_000_000_000;

describe('pairing codes', () => {
  it('are ten characters from an alphabet without look-alikes', () => {
    const code = pairing().issue(NOW);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);
  });

  it('work once: the second use of the same code is invalid', () => {
    const p = pairing();
    const code = p.issue(NOW);
    expect(p.redeem(code, NOW + 1)).toBe('ok');
    expect(p.redeem(code, NOW + 2)).toBe('invalid');
  });

  it('accept the code as people type it: lower case, spaces and dashes', () => {
    const p = pairing();
    const code = p.issue(NOW);
    const typed = ` ${code.slice(0, 5).toLowerCase()}-${code.slice(5)} `;
    expect(p.redeem(typed, NOW)).toBe('ok');
  });

  it('expire after their lifetime', () => {
    const p = pairing();
    const code = p.issue(NOW);
    expect(p.redeem(code, NOW + CODE_TTL_MS + 1)).toBe('invalid');
  });

  it('are replaced by a new one: the earlier code stops working', () => {
    const p = pairing();
    const first = p.issue(NOW);
    const second = p.issue(NOW + 1);
    expect(p.redeem(first, NOW + 2)).toBe('invalid');
    expect(p.redeem(second, NOW + 3)).toBe('ok');
  });

  it('throttle guessing, but never the right code', () => {
    const p = pairing();
    const code = p.issue(NOW);
    for (let i = 0; i < MAX_FAILURES_PER_WINDOW; i++) {
      expect(p.redeem('WRONGWRONG', NOW + i)).toBe('invalid');
    }
    expect(p.redeem('WRONGWRONG', NOW + 10)).toBe('throttled');
    expect(p.redeem('', NOW + 11)).toBe('throttled');
    expect(p.redeem(code, NOW + 12)).toBe('ok');
  });

  it('forget wrong attempts once the window has passed', () => {
    const p = pairing();
    p.issue(NOW);
    for (let i = 0; i <= MAX_FAILURES_PER_WINDOW; i++) {
      p.redeem('WRONGWRONG', NOW + i);
    }
    expect(p.redeem('WRONGWRONG', NOW + FAILURE_WINDOW_MS + 100)).toBe('invalid');
  });
});
