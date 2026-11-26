import { describe, expect, it } from 'vitest';

import { parseQrFragment, qrSvgPath } from './pair-qr';

const KEY = 'Xq3v9mJb2LkPzR7tYc0wNfHs5dGa8EuQi1oVnBx4ZeW';
const LINK = `kubernanny://pair?${new URLSearchParams({ url: 'https://kubernanny.example.com', code: 'K7QM2XRT9C', name: 'homelab', key: KEY })}`;

describe('the /qr fragment', () => {
  it('takes a pairing link as the agent prints it, URL-encoded', () => {
    expect(parseQrFragment('#' + encodeURIComponent(LINK))).toEqual({ kind: 'pair', link: LINK, name: 'homelab' });
  });

  it('takes it unencoded too, and without a key', () => {
    const noKey = 'kubernanny://pair?url=http%3A%2F%2Flocalhost%3A8080&code=ABCDE23456';
    expect(parseQrFragment('#' + noKey)).toEqual({ kind: 'pair', link: noKey, name: '' });
  });

  it("takes it after Angular's router rewrote the address", () => {
    // The router parses the fragment with decodeURIComponent and writes it back with encodeURI.
    expect(parseQrFragment('#' + encodeURI(LINK))).toEqual({ kind: 'pair', link: LINK, name: 'homelab' });
  });

  it('shows nothing for an empty fragment', () => {
    expect(parseQrFragment('')).toEqual({ kind: 'none' });
    expect(parseQrFragment('#')).toEqual({ kind: 'none' });
  });

  it.each([
    'https://example.com',
    'kubernanny://evil?url=https%3A%2F%2Fa&code=X',
    'kubernanny://pair?code=X',
    'kubernanny://pair?url=javascript%3Aalert(1)&code=X',
    'kubernanny://pair?url=https%3A%2F%2Fa',
    `kubernanny://pair?url=https%3A%2F%2Fa&code=X&key=short`,
    'kubernanny://pair/x?url=https%3A%2F%2Fa&code=X',
    '%E0%A4%A',
    'any text at all',
  ])('refuses %s', (fragment) => {
    expect(parseQrFragment('#' + fragment)).toEqual({ kind: 'invalid' });
  });

  it('draws a square code with a quiet zone of four modules', () => {
    const { size, path } = qrSvgPath(LINK);
    // A QR code is 17 + 4 * version modules wide.
    expect((size - 8 - 17) % 4).toBe(0);
    // The top-left finder pattern starts at the quiet zone.
    expect(path.startsWith('M4 4h7v1h-7z')).toBe(true);
  });
});
