import { describe, expect, it } from 'vitest';
import { sourceKey } from '../src/address.js';

describe('sourceKey', () => {
  it('groups IPv6 by /64, unwraps IPv4-mapped addresses and never throws', () => {
    expect(sourceKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(sourceKey('2001:DB8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(sourceKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(sourceKey('::1')).toBe('0:0:0:0::/64');
    expect(sourceKey('1:2:3:4:5:6:7:8:9::1')).toBe('invalid');
    expect(sourceKey('::ffff:10.0.0.1')).toBe('10.0.0.1');
    expect(sourceKey('10.0.0.1')).toBe('10.0.0.1');
    expect(sourceKey(undefined)).toBe('unknown');
    expect(sourceKey('')).toBe('unknown');
  });
});
