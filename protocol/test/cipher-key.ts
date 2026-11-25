/** Test-only: the raw key of a CipherState after Split, for comparing with libsodium and the vectors. Not part of the package. */
export function cipherKey(state: unknown): Uint8Array | null {
  return (state as { k: Uint8Array | null }).k;
}
