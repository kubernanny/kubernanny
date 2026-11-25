/** Reads a response body, aborting once it passes `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > max) {
    throw new Error(`response of ${declared} bytes refused (limit ${max})`);
  }
  if (!res.body) {
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error(`response passed ${max} bytes, refused`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
