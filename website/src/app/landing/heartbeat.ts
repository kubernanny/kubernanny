/**
 * An ECG-like trace like the app's heartbeat (docs/DESIGN.md): regular beats,
 * generated deterministically so server and browser draw the same path.
 */
export function heartbeatPath(width: number, mid: number, spacing: number): string {
  const parts = [`M0 ${mid}`];
  for (let x = spacing / 2; x + 60 < width; x += spacing) {
    parts.push(
      `L${x} ${mid}`,
      `Q${x + 6} ${mid - 7} ${x + 12} ${mid}`,
      `L${x + 20} ${mid}`,
      `L${x + 24} ${mid + 8}`,
      `L${x + 30} ${mid - 44}`,
      `L${x + 36} ${mid + 22}`,
      `L${x + 41} ${mid}`,
      `L${x + 52} ${mid}`,
      `Q${x + 62} ${mid - 13} ${x + 72} ${mid}`,
    );
  }
  parts.push(`L${width} ${mid}`);
  return parts.join(' ');
}
