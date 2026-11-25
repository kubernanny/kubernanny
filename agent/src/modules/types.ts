import { CheckStatus, Issue } from '../checks/types';
import type { Text } from '../i18n/text';
import { Config } from '../config';
import { Category } from '../discovery/catalog';
import { Detected, Link } from '../discovery/discovery';
import { Inventory } from '../inventory/inventory';
import { KubeClient } from '../kube/kube-client';
import { Prometheus } from './service-proxy';
import type { Certificate } from '../checks/certificates.check';
import type { LonghornVolume } from '../checks/longhorn.check';
import type { CnpgCluster } from '../checks/cnpg.check';
import type { EtcdSnapshot, LonghornBackup, LonghornBackupTarget } from '../checks/maintenance.check';
import type { VeleroBackup } from './integrations/velero';
import type { VulnDb } from './vulnerabilities/osv-client';
import type { AcceptanceState } from './vulnerabilities/acceptance';
import type { RollbackApp } from '../checks/argocd-rollback';

export type Tone = 'ok' | 'warning' | 'critical' | 'muted';

export interface Stat {
  label: Text;
  /** Numbers and names as they are; words as a Text. */
  value: string | Text;
  tone?: Tone;
}

export interface ModuleResult {
  issues: Issue[];
  stats: Stat[];
  /** One line under the name: what is going on right now. */
  summary: Text;
  /** Vulnerabilities only: advisories someone marked as not applicable, shown on the module sheet. */
  accepted?: AcceptedAdvisory[];
  canAccept?: boolean;
  /** Argo CD only, while `argocd-rollback` is on: manual-sync apps and the earlier deployments they can go back to. */
  rollbacks?: RollbackApp[];
}

/** An accepted advisory as the app shows it: which component, until when, why and by whom. */
export interface AcceptedAdvisory {
  component: string;
  name: string;
  advisory: string;
  until: string;
  by: string;
  reason?: string;
}

/** Data one module reads that the detail views reuse, so nothing is fetched twice. */
export interface RunData {
  certificates?: Certificate[];
  longhornVolumes?: LonghornVolume[];
  longhornNodes?: LonghornNode[];
  /** kubelet_volume_stats_used_bytes per "namespace/pvc". */
  volumeUsage?: Map<string, { used: number; capacity: number }>;
  /** Root filesystem use per node name, 0..1. */
  nodeDisk?: Map<string, number>;
  kuredLock?: string;
  /** The lists behind the backups view (`views/backups.ts`), kept by the modules that read them. */
  cnpgClusters?: CnpgCluster[];
  longhornBackups?: LonghornBackup[];
  longhornBackupTargets?: LonghornBackupTarget[];
  etcdSnapshots?: EtcdSnapshot[];
  veleroBackups?: VeleroBackup[];
  /** Workloads (`<ns>/<kind>/<name>`) with a fresh Trivy Operator report; the built-in vulnerability lookup steps back for components they cover. */
  trivy?: { covered: Set<string> };
}

export interface LonghornNode {
  metadata: { name: string };
  spec?: { allowScheduling?: boolean };
  status?: {
    conditions?: { type: string; status: string; message?: string }[];
    diskStatus?: Record<string, { storageAvailable?: number; storageMaximum?: number; storageScheduled?: number; conditions?: { type: string; status: string; message?: string }[] }>;
  };
}

export interface ModuleContext {
  inv: Inventory;
  kube: KubeClient;
  config: Config;
  now: Date;
  /** Set when a Prometheus was found (or PROMETHEUS_URL is set). */
  prom: Prometheus | null;
  data: RunData;
  /** The components discovered in this run (core checks that look across components read them). */
  detected?: Detected[];
  /** The vulnerability database; set by the run loop, kept across runs for its cache. */
  vulnDb?: VulnDb;
  /** Advisories accepted per component, and whether accepting is possible at all (Helm `vulnerabilities.allowAccept`). */
  vulnAcceptance?: AcceptanceState;
  /** `argocd-rollback` is on: the Argo CD module lists what can be rolled back. */
  rollbackOn?: boolean;
}

/** An API resource a module reads; the RBAC test checks the chart and install.yaml grant it. */
export interface ApiRead {
  /** '' for the core group. */
  group: string;
  resource: string;
  /** Why the module reads it, one short line; docs/PERMISSIONS.md is generated from it. */
  why: string;
}

export interface ModuleView {
  id: string;
  name: Text;
  category: Category | 'core';
  icon: string;
  description: Text;
  namespace?: string;
  version?: string;
  status: CheckStatus;
  summary: Text;
  stats: Stat[];
  links: Link[];
  workloads: { ready: number; total: number; items: { kind: string; namespace: string; name: string; ready: number; desired: number }[] };
  issueIds: string[];
  error?: Text;
  /** Vulnerabilities only: accepted advisories, listed on the sheet with a way to take them back. */
  accepted?: AcceptedAdvisory[];
  /** Vulnerabilities only: advisories can be accepted (not locked in Helm). */
  canAccept?: boolean;
  /** Argo CD only, while `argocd-rollback` is on. */
  rollbacks?: RollbackApp[];
}
