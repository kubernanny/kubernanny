import { KubeError } from '../kube/kube-client';

/** Waits between attempts: about half a minute in all, short enough for a pod start, long enough for an API server restart. */
const STARTUP_READ_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000, 15_000];

export interface StartupReadOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Called before each retry, e.g. to log it. */
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

/** A start-up read failed on every attempt: the process should end, so Kubernetes restarts it. */
export class StartupReadError extends Error {
  constructor(
    readonly what: string,
    readonly cause: unknown,
  ) {
    super(`cannot read ${what} (${cause instanceof Error ? cause.message : String(cause)}); giving up so the pod restarts`);
  }
}

/**
 * Reads state the agent keeps in the cluster (a Secret, a ConfigMap) before
 * it serves anything. A 404 is an answer (nothing stored yet) and returns
 * null; any other error is retried with backoff, and after the last attempt
 * a StartupReadError is thrown. Starting with empty state instead would fail
 * open (switched-off actions back on), lose data (the next write replaces the
 * stored key) or replace the agent key every phone pinned.
 *
 * Plain async code, no framework: whoever starts the services awaits their
 * init and ends the process when it throws.
 */
export async function readAtStartup<T>(what: string, read: () => Promise<T>, options: StartupReadOptions = {}): Promise<T | null> {
  const delays = options.delaysMs ?? STARTUP_READ_DELAYS_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (err) {
      if (err instanceof KubeError && err.status === 404) {
        return null;
      }
      if (attempt >= delays.length) {
        throw new StartupReadError(what, err);
      }
      options.onRetry?.(err, attempt + 1, delays[attempt]);
      await sleep(delays[attempt]);
    }
  }
}

/** Thrown by a write before the stored value was read: it would replace what is stored with what this process never saw. */
export class NotLoadedError extends Error {
  constructor(what: string) {
    super(`${what} not loaded yet; refusing to overwrite what is stored`);
  }
}
