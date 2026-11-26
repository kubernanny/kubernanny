import { Snapshot } from '../status/status.service';

const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

/**
 * The agent's own state in Prometheus' text format, so Grafana can chart it
 * and Alertmanager can alert on it. Served on a port the ingress never sees.
 */
export function renderMetrics(s: Snapshot, extra: { widgetPushes?: ReadonlyMap<string, number> } = {}): string {
  const lines: string[] = [];
  const metric = (
    name: string,
    help: string,
    type: 'gauge' | 'counter',
    samples: [Record<string, string>, number][],
  ) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) {
      const l = Object.entries(labels)
        .map(([k, v]) => `${k}="${esc(v)}"`)
        .join(',');
      lines.push(`${name}${l ? `{${l}}` : ''} ${value}`);
    }
  };
  const light = { green: 0, yellow: 1, red: 2, unknown: 3 }[s.light];
  metric('kubernanny_health_score', 'Health score 0..100 (100 = no issues).', 'gauge', [[{}, s.score]]);
  metric('kubernanny_light', 'Traffic light: 0 green, 1 yellow, 2 red, 3 unknown.', 'gauge', [[{}, light]]);
  metric('kubernanny_issues', 'Open issues by severity.', 'gauge', [
    [{ severity: 'critical' }, s.issues.filter((i) => i.severity === 'critical').length],
    [{ severity: 'warning' }, s.issues.filter((i) => i.severity === 'warning').length],
    [{ severity: 'info' }, s.issues.filter((i) => i.severity === 'info').length],
  ]);
  metric(
    'kubernanny_module_status',
    'Per module: 0 ok, 1 warning, 2 critical, 3 error.',
    'gauge',
    s.modules
      .filter((m) => m.status !== 'skipped')
      .map((m) => [
        { module: m.id, category: m.category },
        { ok: 0, warning: 1, critical: 2, error: 3, skipped: 0 }[m.status],
      ]),
  );
  metric('kubernanny_components_detected', 'Components recognised in the cluster.', 'gauge', [
    [{}, s.overview?.components ?? 0],
  ]);
  if (s.durationMs !== null) {
    metric('kubernanny_run_duration_seconds', 'Duration of the last check run.', 'gauge', [[{}, s.durationMs / 1000]]);
  }
  if (s.checkedAt) {
    metric('kubernanny_last_run_timestamp_seconds', 'Time of the last check run that read the cluster.', 'gauge', [
      [{}, Math.floor(Date.parse(s.checkedAt) / 1000)],
    ]);
  }
  if (extra.widgetPushes && extra.widgetPushes.size > 0) {
    // Outcomes only: never a device, a token or a key id.
    metric(
      'kubernanny_widget_pushes_total',
      'Silent status pushes for home-screen widgets handed to the relay, by outcome.',
      'counter',
      [...extra.widgetPushes].map(([outcome, n]) => [{ outcome }, n]),
    );
  }
  return `${lines.join('\n')}\n`;
}
