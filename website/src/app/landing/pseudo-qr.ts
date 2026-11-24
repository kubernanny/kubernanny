/**
 * A decorative, QR-like grid: three finder patterns and deterministic noise.
 * It encodes nothing (no format or timing data), so a camera ignores it.
 */
export function qrModules(size = 25, seed = 7): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const inFinder = (x: number, y: number, fx: number, fy: number) => x >= fx && x < fx + 7 && y >= fy && y < fy + 7;
  const finders = [
    [0, 0],
    [size - 7, 0],
    [0, size - 7],
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const finder = finders.find(([fx, fy]) => inFinder(x, y, fx, fy));
      if (finder) {
        const dx = x - finder[0];
        const dy = y - finder[1];
        const ring = dx === 0 || dy === 0 || dx === 6 || dy === 6;
        const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
        if (ring || core) {
          out.push({ x, y });
        }
        continue;
      }
      const nearFinder = finders.some(([fx, fy]) => x >= fx - 1 && x <= fx + 7 && y >= fy - 1 && y <= fy + 7);
      if (!nearFinder && random() < 0.48) {
        out.push({ x, y });
      }
    }
  }
  return out;
}
