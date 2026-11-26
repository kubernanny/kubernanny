/**
 * The key a per-address limit counts a caller under: IPv4 as is (an
 * IPv4-mapped IPv6 address unwrapped), IPv6 by its /64, since one host or
 * household usually owns a whole /64 and could otherwise rotate through it to
 * get a fresh budget per address. Used by the agent (direct calls) and the
 * relay (callers of one agent). Never throws: anything that is not a valid
 * IPv6 address shares one key.
 */
export function sourceKey(address: string | undefined): string {
  if (!address) {
    return 'unknown';
  }
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (v4) {
    return v4[1]!;
  }
  if (!address.includes(':')) {
    return address;
  }
  // Expand "::" so the first four groups are the /64.
  const [head, tail = ''] = address.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  if (left.length + right.length > 8) {
    // Not a valid address (more than eight groups): one shared bucket, never an exception.
    return 'invalid';
  }
  const groups = address.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${groups.slice(0, 4).join(':')}::/64`;
}
