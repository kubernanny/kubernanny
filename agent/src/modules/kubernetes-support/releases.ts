/**
 * End of life of every Kubernetes minor release, as published by the
 * Kubernetes project: https://kubernetes.io/releases/ (and its "patch
 * releases" page for branches no longer supported).
 *
 * Compiled on 2026-11-24 from those pages. Dates of past releases are the
 * actual end of life the project lists (some differ from the plan, e.g. 1.31
 * on 2025-11-11); dates of 1.35 to 1.37 are the project's planned dates.
 * Nothing here is guessed: a minor the project had not released on that day
 * is simply missing, and the check says nothing about it.
 *
 * Update it when a new minor comes out (about three times a year): add the
 * line from the releases page, nothing else changes.
 */
export const RELEASES_COMPILED = '2026-11-24';

/** Minor version → end of life (YYYY-MM-DD), oldest first. */
export const KUBERNETES_EOL: Readonly<Record<number, string>> = {
  20: '2022-02-28',
  21: '2022-06-28',
  22: '2022-12-08',
  23: '2023-02-28',
  24: '2023-07-28',
  25: '2023-10-28',
  26: '2024-02-28',
  27: '2024-07-16',
  28: '2024-10-22',
  29: '2025-02-28',
  30: '2025-07-15',
  31: '2025-11-11',
  32: '2026-02-28',
  33: '2026-06-28',
  34: '2026-10-27',
  35: '2027-02-28',
  36: '2027-06-28',
  37: '2027-10-28',
};
