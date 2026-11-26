import { Injectable } from '@angular/core';

import { markRolledBack } from '../../cluster/argocd-rollback';
import { MAINTENANCE_HOURS } from '../../cluster/maintenance-view';
import { ACCEPTING_MODULES, componentOfIssueId } from '../../cluster/vulnerability-acceptance';
import { Lang } from '../../i18n/lang';
import { translatorFor } from '../../i18n/translator';
import {
  AcceptedAdvisory,
  IncidentsView,
  Issue,
  Light,
  ModuleView,
  SettingsPatch,
  SettingsView,
  Snapshot,
} from '../agent.model';
import { AgentError } from '../agent-error';
import { ageIssues, DEMO_LABELS, DemoData, DemoScenario, shiftTimes } from './demo-data';

const SEVERITY_FACTOR = { critical: 0.82, warning: 0.95, info: 1 } as const;

/** Same rule as the agent's lightFor/scoreFor, applied after a demo action "fixed" something. */
export function judge(issues: Pick<Issue, 'severity'>[]): { light: Light; score: number } {
  const light: Light = issues.some((i) => i.severity === 'critical')
    ? 'red'
    : issues.some((i) => i.severity === 'warning')
      ? 'yellow'
      : 'green';
  return {
    light,
    score: Math.round(issues.reduce((s, i) => s * SEVERITY_FACTOR[i.severity], 100)),
  };
}

/** What the person did in one demo cluster; kept when the language changes. */
interface DemoState {
  /** Issues a demo action has "fixed", with when (ms). */
  fixed: Map<string, number>;
  /** Issue id to the end of its silence (ms). */
  silenced: Map<string, number>;
  /** Every switch flipped in the settings, applied over the recording's. */
  toggles: SettingsPatch;
  /** End of the maintenance window (ms); 0: none. */
  maintenanceUntil: number;
  /** "component|advisory" to the advisory marked as not applicable. */
  accepted: Map<string, { until: number; reason?: string }>;
  /** "namespace/app" to the history id a simulated rollback went back to. */
  rolledBack: Map<string, number>;
}

interface Demo {
  data: DemoData;
  state: DemoState;
  settings: SettingsView;
}

/**
 * The built-in demo: answers the app's API calls from recordings of the three
 * demo agents (made by `npm run demo:export` in agent/), in the UI language:
 * app/public/demo/<scenario>.<lang>.json, else <scenario>.json. Nothing
 * leaves the device. Actions pretend to work and take the issue away, so the
 * whole flow can be tried, including in App Review.
 */
@Injectable({ providedIn: 'root' })
export class DemoAgent {
  private readonly recordings = new Map<string, Promise<DemoData>>();
  private readonly states = new Map<DemoScenario, DemoState>();

  async call<T>(
    scenario: DemoScenario,
    method: string,
    path: string,
    body?: unknown,
    lang: Lang = 'de',
  ): Promise<T> {
    const tr = translatorFor(lang);
    const data = await this.load(scenario, lang);
    const state = this.stateOf(scenario);
    const demo: Demo = { data, state, settings: applySettings(data.settings, state.toggles) };
    const url = new URL(path, 'http://demo');
    const route = `${method} ${url.pathname}`;
    const q = (name: string) => url.searchParams.get(name) ?? '';
    switch (true) {
      case route === 'GET /status' || route === 'POST /status/refresh':
        return this.snapshot(demo, lang) as T;
      case route === 'GET /info':
        return data.info as T;
      case route === 'GET /nodes' ||
        route === 'GET /workloads' ||
        route === 'GET /storage' ||
        route === 'GET /network' ||
        route === 'GET /events':
        return data[url.pathname.slice(1) as 'nodes'] as T;
      case route === 'GET /history': {
        const wanted = Number(q('hours')) || 6;
        const key = ([6, 24, 168] as const).find((h) => h >= wanted) ?? 168;
        return data.history[key] as T;
      }
      case route === 'POST /maintenance': {
        const hours = Number(q('hours'));
        if (!(MAINTENANCE_HOURS as readonly number[]).includes(hours)) {
          throw new AgentError(400, 'MAINTENANCE_HOURS', tr.t('errors.status', { status: 400 }));
        }
        state.maintenanceUntil = Date.now() + hours * 3_600_000;
        return { maintenanceUntil: new Date(state.maintenanceUntil).toISOString() } as T;
      }
      case route === 'POST /maintenance/end':
        state.maintenanceUntil = 0;
        return undefined as T;
      case route === 'GET /incidents':
        return demoIncidents(data, state, Date.now(), Number(q('days')) || 7) as T;
      case route === 'GET /backups':
        return (data.backups ?? { maxAgeHours: 26, rows: [], targets: [], unprotected: [] }) as T;
      case route === 'GET /logs': {
        const logs = data.logs[`${q('issue')}#${q('index') || '0'}`];
        if (!logs) {
          throw new AgentError(404, 'ACTION_NOT_OFFERED', tr.t('demo.noLogs'));
        }
        return logs as T;
      }
      case route === 'POST /issues/silence':
        state.silenced.set(q('issue'), Date.now() + Number(q('hours')) * 3_600_000);
        return { silencedUntil: new Date(state.silenced.get(q('issue'))!).toISOString() } as T;
      case route === 'POST /issues/unsilence':
        state.silenced.delete(q('issue'));
        return undefined as T;
      case route === 'POST /vulnerabilities/accept': {
        const { component, advisory, days, reason } = body as {
          component: string;
          advisory: string;
          days: number;
          reason?: string;
        };
        if (![30, 90, 365].includes(days)) {
          throw new AgentError(400, 'ACCEPT_DAYS', tr.t('errors.status', { status: 400 }));
        }
        const until = Date.now() + days * 86_400_000;
        state.accepted.set(`${component}|${advisory}`, { until, ...(reason ? { reason } : {}) });
        return { acceptedUntil: new Date(until).toISOString() } as T;
      }
      case route === 'POST /vulnerabilities/unaccept': {
        const { component, advisory } = body as { component: string; advisory: string };
        state.accepted.delete(`${component}|${advisory}`);
        return undefined as T;
      }
      case route === 'POST /argocd/rollback':
        return rollbackInDemo(demo, body, tr) as T;
      case method === 'POST' && url.pathname.startsWith('/actions/'):
        return this.act(demo, url.pathname.slice('/actions/'.length), q('issue'), lang) as T;
      case route === 'GET /settings':
        return demo.settings as T;
      case route === 'POST /settings':
        state.toggles = mergeToggles(state.toggles, demo.settings, body as SettingsPatch);
        return applySettings(data.settings, state.toggles) as T;
      case route === 'GET /devices':
        return [
          {
            id: 'demo',
            name: tr.t('demo.device'),
            createdAt: data.generatedAt,
            lastSeenAt: new Date().toISOString(),
            current: true,
          },
        ] as T;
      case route === 'POST /notify/test':
        return { channels: [tr.t('demo.testChannel')] } as T;
      default:
        throw new AgentError(403, 'DEMO_ONLY', tr.t('demo.demoOnly'));
    }
  }

  private stateOf(scenario: DemoScenario): DemoState {
    let state = this.states.get(scenario);
    if (!state) {
      state = {
        fixed: new Map<string, number>(),
        silenced: new Map<string, number>(),
        toggles: {},
        maintenanceUntil: 0,
        accepted: new Map(),
        rolledBack: new Map(),
      };
      this.states.set(scenario, state);
    }
    return state;
  }

  /** The recording in the UI language, else the one without a language. */
  private load(scenario: DemoScenario, lang: Lang): Promise<DemoData> {
    const key = `${scenario}.${lang}`;
    let recording = this.recordings.get(key);
    if (!recording) {
      recording = fetchRecording(`demo/${scenario}.${lang}.json`)
        .catch(() => fetchRecording(`demo/${scenario}.json`))
        .catch(() => {
          throw new AgentError(404, 'DEMO_MISSING', translatorFor(lang).t('demo.missing'));
        })
        .then((raw) => {
          const shifted = shiftTimes(raw, Date.now() - Date.parse(raw.generatedAt));
          return {
            ...shifted,
            status: { ...shifted.status, issues: ageIssues(shifted.status.issues, Date.now()) },
          };
        });
      // A failed load may be retried with the next call.
      recording.catch(() => this.recordings.delete(key));
      this.recordings.set(key, recording);
    }
    return recording;
  }

  private snapshot({ data, state, settings }: Demo, lang: Lang): Snapshot {
    const off = new Set(settings.modules.filter((m) => m.state !== 'on').map((m) => m.id));
    const now = Date.now();
    const accepted = acceptInDemo(
      data.status.issues,
      data.status.modules,
      state.accepted,
      now,
      translatorFor(lang).t('demo.device'),
    );
    const issues = accepted.issues
      .filter((i) => !state.fixed.has(i.id) && !off.has(i.module))
      .map((i) =>
        (state.silenced.get(i.id) ?? 0) > now
          ? { ...i, silencedUntil: new Date(state.silenced.get(i.id)!).toISOString() }
          : i,
      );
    const modules = accepted.modules
      .filter((m) => !off.has(m.id))
      .map((m) => (m.id === 'argocd' ? withRollbacks(m, settings, state.rolledBack) : m))
      .map((m) =>
        m.issueIds.some((id) => state.fixed.has(id))
          ? { ...m, issueIds: m.issueIds.filter((id) => !state.fixed.has(id)) }
          : m,
      );
    const maintenance =
      state.maintenanceUntil > now
        ? { maintenanceUntil: new Date(state.maintenanceUntil).toISOString() }
        : {};
    return {
      ...data.status,
      ...judge(issues.filter((i) => !i.silencedUntil)),
      ...demoSchedule(now),
      cluster: DEMO_LABELS[data.scenario].cluster,
      issues,
      modules,
      ...maintenance,
    };
  }

  private act(
    { data, state, settings }: Demo,
    type: string,
    issueId: string,
    lang: Lang,
  ): { done: string } {
    const tr = translatorFor(lang);
    const issue = data.status.issues.find((i) => i.id === issueId);
    if (!issue || state.fixed.has(issueId)) {
      throw new AgentError(409, 'ISSUE_GONE', tr.t('demo.issueGone'));
    }
    if (!settings.actions.some((a) => a.type === type && a.state === 'on')) {
      throw new AgentError(403, 'ACTION_DISABLED', tr.t('errors.actionDisabled'));
    }
    state.fixed.set(issueId, Date.now());
    return { done: tr.t('demo.done', { title: issue.title }) };
  }
}

/**
 * A simulated rollback: checked like the agent checks it (the action on, the
 * app and history entry on the recorded sheet, not the current one), then
 * remembered so the sheet shows the chosen deployment as current. Nothing
 * else changes, and the answer says so.
 */
function rollbackInDemo(
  { data, state, settings }: Demo,
  body: unknown,
  tr: ReturnType<typeof translatorFor>,
): { done: string; revision: string } {
  if (!settings.actions.some((a) => a.type === 'argocd-rollback' && a.state === 'on')) {
    throw new AgentError(403, 'ACTION_DISABLED', tr.t('errors.actionDisabled'));
  }
  const { namespace, app, id } = (body ?? {}) as { namespace?: string; app?: string; id?: number };
  const argocd = withRollbacks(
    data.status.modules.find((m) => m.id === 'argocd') ?? ({} as ModuleView),
    settings,
    state.rolledBack,
  );
  const target = argocd.rollbacks?.find((a) => a.namespace === namespace && a.app === app);
  const entry = target?.entries.find((e) => e.id === id && !e.current);
  if (!target || !entry) {
    throw new AgentError(409, 'ROLLBACK_HISTORY_NOT_FOUND', tr.t('errors.status', { status: 409 }));
  }
  state.rolledBack.set(`${target.namespace}/${target.app}`, entry.id);
  return {
    done: tr.t('demo.rolledBack', { app: target.app, revision: entry.short }),
    revision: entry.revision,
  };
}

/** The recorded rollback list, hidden while the action is off and with every simulated rollback applied. */
export function withRollbacks(
  m: ModuleView,
  settings: SettingsView,
  rolledBack: ReadonlyMap<string, number>,
): ModuleView {
  if (!m.rollbacks) {
    return m;
  }
  if (!settings.actions.some((a) => a.type === 'argocd-rollback' && a.state === 'on')) {
    const { rollbacks: _hidden, ...rest } = m;
    return rest;
  }
  return [...rolledBack].reduce((view, [key, id]) => {
    const [namespace, app] = key.split('/');
    return markRolledBack(view, { namespace: namespace!, app: app! }, id);
  }, m);
}

/**
 * Accepted advisories, applied like the agent does: they leave their issue
 * (which goes once nothing remains) and are listed on the module that
 * reported them (the built-in lookup or Trivy Operator), which always allows
 * accepting in the demo.
 */
export function acceptInDemo(
  issues: Issue[],
  modules: ModuleView[],
  accepted: ReadonlyMap<string, { until: number; reason?: string }>,
  now: number,
  by: string,
): { issues: Issue[]; modules: ModuleView[] } {
  const lists = new Map<string, AcceptedAdvisory[]>(ACCEPTING_MODULES.map((id) => [id, []]));
  const kept: Issue[] = [];
  for (const issue of issues) {
    const component = componentOfIssueId(issue.id);
    if (component === null || !issue.advisories) {
      kept.push(issue);
      continue;
    }
    const name =
      issue.check === 'trivy'
        ? issue.id.split('/')[3]
        : (modules.find((m) => m.id === component)?.name ?? component);
    const remaining = issue.advisories.filter((advisory) => {
      const a = accepted.get(`${component}|${advisory}`);
      if (a && a.until > now) {
        lists.get(issue.check === 'trivy' ? 'trivy' : 'vulnerabilities')!.push({
          component,
          name,
          advisory,
          until: new Date(a.until).toISOString(),
          by,
          ...(a.reason ? { reason: a.reason } : {}),
        });
        return false;
      }
      return true;
    });
    if (remaining.length > 0) {
      kept.push(
        remaining.length === issue.advisories.length ? issue : { ...issue, advisories: remaining },
      );
    }
  }
  const gone = new Set(issues.filter((i) => !kept.some((k) => k.id === i.id)).map((i) => i.id));
  return {
    issues: kept,
    modules: modules.map((m) =>
      lists.has(m.id)
        ? {
            ...m,
            canAccept: true,
            accepted: lists.get(m.id)!,
            issueIds: m.issueIds.filter((id) => !gone.has(id)),
          }
        : gone.size
          ? { ...m, issueIds: m.issueIds.filter((id) => !gone.has(id)) }
          : m,
    ),
  };
}

/**
 * The recorded incident history, made to agree with what the demo shows: an
 * open incident starts when its issue does (the issues are aged on load), one
 * a demo action fixed ends then, one silenced here says so.
 */
export function demoIncidents(
  data: DemoData,
  state: Pick<DemoState, 'fixed' | 'silenced'>,
  now: number,
  days: number,
): IncidentsView {
  const recorded = data.incidents ?? { coveredSince: data.generatedAt, days: 7, incidents: [] };
  const since = new Map(data.status.issues.map((i) => [i.id, i.since]));
  const from = now - Math.min(Math.max(days, 1), 7) * 86_400_000;
  const incidents = recorded.incidents
    .map((i) => {
      const start = i.end === null ? (since.get(i.issueId) ?? i.start) : i.start;
      const fixedAt = i.end === null ? state.fixed.get(i.issueId) : undefined;
      const end = fixedAt !== undefined ? new Date(fixedAt).toISOString() : i.end;
      const silenced = i.silenced || (i.end === null && (state.silenced.get(i.issueId) ?? 0) > now);
      return {
        ...i,
        start,
        end,
        silenced,
        durationMs: Math.max(0, (end ? Date.parse(end) : now) - Date.parse(start)),
      };
    })
    .filter((i) => i.end === null || Date.parse(i.end) >= from)
    .sort((a, b) => Date.parse(b.start) - Date.parse(a.start));
  return { coveredSince: recorded.coveredSince, days: Math.min(Math.max(days, 1), 7), incidents };
}

async function fetchRecording(url: string): Promise<DemoData> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url}: ${res.status}`);
  }
  return (await res.json()) as DemoData;
}

/** Adds a settings change to the switches flipped so far; locked switches stay as recorded. */
export function mergeToggles(
  toggles: SettingsPatch,
  current: SettingsView,
  patch: SettingsPatch,
): SettingsPatch {
  const applied = applySettings(current, patch);
  return {
    modules: {
      ...toggles.modules,
      ...Object.fromEntries(
        applied.modules
          .filter((m) => patch.modules?.[m.id] !== undefined)
          .map((m) => [m.id, m.state === 'on']),
      ),
    },
    actions: {
      ...toggles.actions,
      ...Object.fromEntries(
        applied.actions
          .filter((a) => patch.actions?.[a.type] !== undefined)
          .map((a) => [a.type, a.state === 'on']),
      ),
    },
    ...(patch.notifications !== undefined
      ? { notifications: applied.notifications === 'on' }
      : toggles.notifications !== undefined
        ? { notifications: toggles.notifications }
        : {}),
  };
}

export function applySettings(view: SettingsView, patch: SettingsPatch): SettingsView {
  const flip = <T extends { state: string }>(item: T, on: boolean | undefined): T =>
    on === undefined || item.state === 'locked' ? item : { ...item, state: on ? 'on' : 'off' };
  return {
    modules: view.modules.map((m) => flip(m, patch.modules?.[m.id])),
    actions: view.actions.map((a) => flip(a, patch.actions?.[a.type])),
    notifications:
      patch.notifications === undefined || view.notifications === 'locked'
        ? view.notifications
        : patch.notifications
          ? 'on'
          : 'off',
  };
}

/** The demo checks once a minute on the minute, like an agent with the default interval: the last run and the next. */
export function demoSchedule(now: number): { checkedAt: string; nextCheckAt: string } {
  const last = now - (now % 60_000);
  return {
    checkedAt: new Date(last).toISOString(),
    nextCheckAt: new Date(last + 60_000).toISOString(),
  };
}
