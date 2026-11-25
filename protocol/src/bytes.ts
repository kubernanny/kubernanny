/** Byte helpers shared by the protocol and the relay (no Buffer: they run in browsers and Workers too). */

/** Equal length and equal bytes, in time that does not depend on where they differ. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

/** `length` bytes from the platform's CSPRNG (WebCrypto, available in Node, browsers and Workers). */
export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}
