import { Injectable } from '@nestjs/common';

export type CallOutcome = 'ok' | 'agent_error' | 'offline' | 'timeout' | 'rate_limited' | 'too_large' | 'response_too_large' | 'bad_request';
export type RegistrationOutcome = 'ok' | 'proof_failed' | 'timeout' | 'protocol' | 'full';

/**
 * Prometheus counters without a client library: a handful of numbers, no
 * agent ids as labels (that would be one time series per agent, and a list
 * of who uses the relay).
 */
@Injectable()
export class RelayMetrics {
  agents = 0;
  pending = 0;
  private readonly calls = new Map<CallOutcome, number>();
  private readonly registrations = new Map<RegistrationOutcome, number>();
  private readonly pushes = new Map<string, number>();
  private bytesIn = 0;
  private bytesOut = 0;
  private durationSum = 0;
  private durationCount = 0;

  call(outcome: CallOutcome, bytesIn: number, bytesOut: number, ms: number): void {
    this.calls.set(outcome, (this.calls.get(outcome) ?? 0) + 1);
    this.bytesIn += bytesIn;
    this.bytesOut += bytesOut;
    this.durationSum += ms / 1000;
    this.durationCount++;
  }

  registration(outcome: RegistrationOutcome): void {
    this.registrations.set(outcome, (this.registrations.get(outcome) ?? 0) + 1);
  }

  /** A native push by outcome (sent, unregistered, rate_limited, …); never with a token or agent id. */
  push(outcome: string): void {
    this.pushes.set(outcome, (this.pushes.get(outcome) ?? 0) + 1);
  }

  render(): string {
    const lines = [
      '# HELP kubernanny_relay_agents Agents connected and registered.',
      '# TYPE kubernanny_relay_agents gauge',
      `kubernanny_relay_agents ${this.agents}`,
      '# HELP kubernanny_relay_pending_registrations Connections that have not proven their key yet.',
      '# TYPE kubernanny_relay_pending_registrations gauge',
      `kubernanny_relay_pending_registrations ${this.pending}`,
      '# HELP kubernanny_relay_calls_total Calls by outcome (agent_error: the agent refused in plain, e.g. rate limited).',
      '# TYPE kubernanny_relay_calls_total counter',
      ...[...this.calls].map(([outcome, n]) => `kubernanny_relay_calls_total{outcome="${outcome}"} ${n}`),
      '# HELP kubernanny_relay_registrations_total Agent registrations by outcome.',
      '# TYPE kubernanny_relay_registrations_total counter',
      ...[...this.registrations].map(([outcome, n]) => `kubernanny_relay_registrations_total{outcome="${outcome}"} ${n}`),
      '# HELP kubernanny_relay_pushes_total Native pushes by outcome.',
      '# TYPE kubernanny_relay_pushes_total counter',
      ...[...this.pushes].map(([outcome, n]) => `kubernanny_relay_pushes_total{outcome="${outcome}"} ${n}`),
      '# HELP kubernanny_relay_bytes_total Bytes carried, request (in) and response (out).',
      '# TYPE kubernanny_relay_bytes_total counter',
      `kubernanny_relay_bytes_total{direction="in"} ${this.bytesIn}`,
      `kubernanny_relay_bytes_total{direction="out"} ${this.bytesOut}`,
      '# HELP kubernanny_relay_call_duration_seconds Time from request to answer.',
      '# TYPE kubernanny_relay_call_duration_seconds summary',
      `kubernanny_relay_call_duration_seconds_sum ${this.durationSum}`,
      `kubernanny_relay_call_duration_seconds_count ${this.durationCount}`,
      '# HELP process_resident_memory_bytes Resident memory.',
      '# TYPE process_resident_memory_bytes gauge',
      `process_resident_memory_bytes ${process.memoryUsage.rss()}`,
    ];
    return `${lines.join('\n')}\n`;
  }
}

export function outcomeOf(code: string | null, status: number): CallOutcome {
  switch (code) {
    case null:
      return status === 200 ? 'ok' : 'agent_error';
    case 'RELAY_AGENT_OFFLINE':
      return 'offline';
    case 'RELAY_TIMEOUT':
      return 'timeout';
    case 'RELAY_RATE_LIMITED':
      return 'rate_limited';
    case 'RELAY_TOO_LARGE':
      return 'too_large';
    case 'RELAY_RESPONSE_TOO_LARGE':
      return 'response_too_large';
    default:
      return 'bad_request';
  }
}
