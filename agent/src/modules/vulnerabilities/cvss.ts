/**
 * CVSS v3.0/v3.1 base score from a vector string, the formula of the
 * FIRST specification (section 7). OSV carries vectors, not numbers. v4
 * vectors are not scored here (their formula needs the full MacroVector
 * table); advisories with only v4 fall back to the database's own label.
 */
const W = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const;

/** The specification's Roundup: the smallest one-decimal number not below x, robust against float noise. */
function roundUp(x: number): number {
  const i = Math.round(x * 100_000);
  return i % 10_000 === 0 ? i / 100_000 : (Math.floor(i / 10_000) + 1) / 10;
}

/** The table's own entry for `key`, or undefined: never an inherited property. */
function weight(table: Readonly<Record<string, number>>, key: string | undefined): number | undefined {
  return key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

export function cvss3Score(vector: string): number | null {
  if (!/^CVSS:3\.[01]\//.test(vector)) {
    return null;
  }
  // A Map, not an object: a metric value like "constructor" must not find Object.prototype.
  const m = new Map(vector.split('/').slice(1).map((p) => p.split(':') as [string, string]));
  const scope = m.get('S');
  const av = weight(W.AV, m.get('AV'));
  const ac = weight(W.AC, m.get('AC'));
  const ui = weight(W.UI, m.get('UI'));
  const pr = weight({ N: 0.85, L: scope === 'C' ? 0.68 : 0.62, H: scope === 'C' ? 0.5 : 0.27 }, m.get('PR'));
  const [c, i, a] = ['C', 'I', 'A'].map((k) => weight(W.CIA, m.get(k)));
  if (av === undefined || ac === undefined || ui === undefined || pr === undefined || c === undefined || i === undefined || a === undefined || (scope !== 'U' && scope !== 'C')) {
    return null;
  }
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scope === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  if (impact <= 0) {
    return 0;
  }
  const exploitability = 8.22 * av * ac * pr * ui;
  return roundUp(Math.min((scope === 'U' ? 1 : 1.08) * (impact + exploitability), 10));
}
