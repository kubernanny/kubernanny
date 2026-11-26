/**
 * The app keeps a hand-written copy of the agent's response types
 * (app/src/app/core/agent.model.ts). This file only compiles while every
 * agent type, as it goes over the wire (each Text rendered to a string), can
 * be read as the app's copy: a renamed, retyped or dropped field fails
 * `npm run typecheck` and the drift spec. Extra fields on the agent's side
 * are fine (the app may ignore them).
 */
import type * as App from '../../app/src/app/core/agent.model';
import type { RollbackApp } from '../src/checks/argocd-rollback';
import type { Text } from '../src/i18n/text';
import type { ModuleView } from '../src/modules/types';
import type { SettingsPatch, SettingsView } from '../src/settings/settings.service';
import type { IssueView, Overview, Snapshot } from '../src/status/snapshot';
import type { BackupRow, BackupsView, BackupTargetView } from '../src/views/backups';
import type { EventView } from '../src/views/events';
import type { HistoryView, Series } from '../src/views/history';
import type { IncidentsView, IncidentView } from '../src/views/incidents';
import type { NetworkView } from '../src/views/network';
import type { NodeView } from '../src/views/nodes';
import type { StorageView } from '../src/views/storage';
import type { ContainerView, WorkloadView } from '../src/views/workloads';

/** What JSON.stringify makes of a value after `localize`: every Text becomes a string. */
type Wire<T> = T extends Text
  ? string
  : T extends string | number | boolean | null | undefined
    ? T
    : T extends readonly unknown[]
      ? { -readonly [K in keyof T]: Wire<T[K]> }
      : T extends object
        ? { -readonly [K in keyof T]: Wire<T[K]> }
        : T;

/** Fails to compile unless `A` (the agent's wire form) is assignable to `B` (the app's copy). */
type Reads<A, B> = [A] extends [B] ? true : { drift: [A, 'is not assignable to', B] };
const ok = <T extends true>(): T => true as T;

export const checks = [
  ok<Reads<Wire<Snapshot>, App.Snapshot>>(),
  ok<Reads<Wire<IssueView>, App.Issue>>(),
  ok<Reads<Wire<Overview>, App.Overview>>(),
  ok<Reads<Wire<ModuleView>, App.ModuleView>>(),
  ok<Reads<Wire<NodeView>, App.NodeView>>(),
  ok<Reads<Wire<WorkloadView>, App.WorkloadView>>(),
  ok<Reads<Wire<ContainerView>, App.ContainerView>>(),
  ok<Reads<Wire<StorageView>, App.StorageView>>(),
  ok<Reads<Wire<NetworkView>, App.NetworkView>>(),
  ok<Reads<Wire<EventView>, App.EventView>>(),
  ok<Reads<Wire<IncidentView>, App.IncidentView>>(),
  ok<Reads<Wire<IncidentsView>, App.IncidentsView>>(),
  ok<Reads<Wire<BackupRow>, App.BackupRow>>(),
  ok<Reads<Wire<BackupTargetView>, App.BackupTargetView>>(),
  ok<Reads<Wire<BackupsView>, App.BackupsView>>(),
  ok<Reads<Wire<HistoryView>, App.HistoryView>>(),
  ok<Reads<Wire<Series>, App.Series>>(),
  ok<Reads<Wire<SettingsView>, App.SettingsView>>(),
  ok<Reads<Wire<RollbackApp>, App.RollbackApp>>(),
  // The other direction for what the app sends.
  ok<Reads<App.SettingsPatch, SettingsPatch>>(),
];
