import { RelayLimits, parseLimits } from './core/limits';

export interface RelayConfig {
  port: number;
  /** Prometheus /metrics on its own port, kept off the public one. 0 disables it. */
  metricsPort: number;
  limits: RelayLimits;
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
  return { port: port('PORT', 8080), metricsPort: port('METRICS_PORT', 9100), limits: parseLimits(env) };
}

export const RELAY_CONFIG = Symbol('RELAY_CONFIG');
