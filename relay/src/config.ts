import { readFileSync } from 'node:fs';
import { relayOrigin } from '@kubernanny/protocol';
import { RelayLimits, parseLimits } from './core/limits';
import { DeadmanConfig, parseDeadmanConfig } from './core/deadman';
import { PushConfig, parsePushConfig } from './core/push';

export interface RelayConfig {
  port: number;
  /** Prometheus /metrics on its own port, kept off the public one. 0 disables it. */
  metricsPort: number;
  limits: RelayLimits;
  /** Native push to FCM: off unless a service account is configured (docs/RELAY.md, "Native push"). */
  push: PushConfig;
  /** The dead man's switch (docs/RELAY.md): on wherever push is, unless RELAY_DEADMAN=off. */
  deadman: DeadmanConfig;
  /**
   * RELAY_PUBLIC_URL as an origin (`https://relay.example`): what agents'
   * registration proofs must be made for. Null: only loopback hosts can
   * register (local runs and tests), see `registrationOrigin`.
   */
  publicOrigin: string | null;
}

function publicOrigin(raw: string | undefined): string | null {
  if (!raw?.trim()) {
    return null;
  }
  try {
    return relayOrigin(raw);
  } catch {
    throw new Error(`RELAY_PUBLIC_URL must be the relay's public https:// (or wss://) URL, got "${raw}"`);
  }
}

function port(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`${name} must be a port number, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): RelayConfig {
  // The key file mounted from a Secret is the usual way; the variable itself works too (and is what a Worker uses).
  const file = env['FCM_SERVICE_ACCOUNT_FILE'];
  const pushEnv = file && !env['FCM_SERVICE_ACCOUNT'] ? { ...env, FCM_SERVICE_ACCOUNT: readFileSync(file, 'utf8') } : env;
  const push = parsePushConfig(pushEnv);
  return { port: port('PORT', 8080), metricsPort: port('METRICS_PORT', 9100), limits: parseLimits(env), push, deadman: parseDeadmanConfig(env, push.enabled), publicOrigin: publicOrigin(env['RELAY_PUBLIC_URL']) };
}

export const RELAY_CONFIG = Symbol('RELAY_CONFIG');
