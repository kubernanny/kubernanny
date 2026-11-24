import { blake2b } from '@noble/hashes/blake2.js';

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Base64url without padding (RFC 4648 section 5); no Buffer, so it runs in the browser too. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let c = 0; c < chars; c++) {
      out += B64URL[(n >> (18 - 6 * c)) & 63];
    }
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) {
    throw new Error('not base64url');
  }
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of text) {
    value = (value << 6) | B64URL.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  if (bits > 0 && (value & ((1 << bits) - 1)) !== 0) {
    throw new Error('not canonical base64url');
  }
  return out;
}

/** A public key as it appears in links, the QR code and the device list. */
export function parsePublicKey(text: string): Uint8Array {
  const key = fromBase64Url(text);
  if (key.length !== 32) {
    throw new Error('a public key is 32 bytes');
  }
  return key;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * 80 bits of BLAKE2b over the key, in Crockford base32, in groups of four:
 * "7KQ2-M0XD-4F9A-TR3C". For people comparing a key by eye; the protocol
 * itself always pins the full key.
 */
export function fingerprint(publicKey: Uint8Array): string {
  const digest = blake2b(publicKey, { dkLen: 32 }).subarray(0, 10);
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(value >> bits) & 31];
    }
  }
  return out.match(/.{4}/g)!.join('-');
}
