# Screenshots

Every screen of Kubernanny, taken from the built-in demo clusters (`DEMO=broken`, `warning`, `healthy`), in English unless marked German. Regenerate all of them with `scripts/screenshots/run.sh`.

## Getting started

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/01-start-empty.png" alt="First start: what Kubernanny is, and the web UI noticing it is served by an agent"><br><sub>First start: what Kubernanny is, and the web UI noticing it is served by an agent</sub></td>
<td valign="top" width="33%"><img src="screenshots/02-start-install-steps.png" alt="Install in three steps, commands copyable"><br><sub>Install in three steps, commands copyable</sub></td>
<td valign="top" width="33%"><img src="screenshots/03-pair-code.png" alt="Pairing by typing the one-time code from the log"><br><sub>Pairing by typing the one-time code from the log</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/04-clusters.png" alt="Three clusters: red, yellow, green"><br><sub>Three clusters: red, yellow, green</sub></td>
</tr>
</table>

## Overview

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/05-overview-red.png" alt="A cluster with outages: heartbeat, one-sentence headline, score"><br><sub>A cluster with outages: heartbeat, one-sentence headline, score</sub></td>
<td valign="top" width="33%"><img src="screenshots/06-overview-issues.png" alt="Problems with cause, age and the action that fixes them"><br><sub>Problems with cause, age and the action that fixes them</sub></td>
<td valign="top" width="33%"><img src="screenshots/07-overview-charts.png" alt="Key numbers and components needing attention"><br><sub>Key numbers and components needing attention</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/08-overview-more-charts.png" alt="Components needing attention, broken first"><br><sub>Components needing attention, broken first</sub></td>
<td valign="top" width="33%"><img src="screenshots/09-overview-kpis.png" alt="More of the same list"><br><sub>More of the same list</sub></td>
<td valign="top" width="33%"><img src="screenshots/37-overview-yellow.png" alt="A cluster with warnings only"><br><sub>A cluster with warnings only</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/38-overview-green.png" alt="All green: nothing to do"><br><sub>All green: nothing to do</sub></td>
<td valign="top" width="33%"><img src="screenshots/39-overview-green-charts.png" alt="History from Prometheus: CPU, RAM, network, restarts, etcd, API server"><br><sub>History from Prometheus: CPU, RAM, network, restarts, etcd, API server</sub></td>
</tr>
</table>

## Actions

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/10-logs.png" alt="Logs of the crashed container run, errors highlighted"><br><sub>Logs of the crashed container run, errors highlighted</sub></td>
<td valign="top" width="33%"><img src="screenshots/11-confirm-restart.png" alt="Every action that changes the cluster asks first"><br><sub>Every action that changes the cluster asks first</sub></td>
<td valign="top" width="33%"><img src="screenshots/12-action-done.png" alt="Confirmation once the agent has patched the Deployment"><br><sub>Confirmation once the agent has patched the Deployment</sub></td>
</tr>
</table>

## Components

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/13-services.png" alt="Dienste: every recognised component by category"><br><sub>Dienste: every recognised component by category</sub></td>
<td valign="top" width="33%"><img src="screenshots/14-services-monitoring.png" alt="Monitoring stack, recognised by image"><br><sub>Monitoring stack, recognised by image</sub></td>
<td valign="top" width="33%"><img src="screenshots/15-services-apps.png" alt="Maintenance, platform and self-hosted apps"><br><sub>Maintenance, platform and self-hosted apps</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/16-sheet-argocd.png" alt="Argo CD: apps, sync and health, link to its UI"><br><sub>Argo CD: apps, sync and health, link to its UI</sub></td>
<td valign="top" width="33%"><img src="screenshots/17-sheet-argocd-issues.png" alt="Argo CD problems with sync, refresh and restart, and its workloads"><br><sub>Argo CD problems with sync, refresh and restart, and its workloads</sub></td>
<td valign="top" width="33%"><img src="screenshots/18-sheet-longhorn.png" alt="Longhorn: volume health, free disk, replica state"><br><sub>Longhorn: volume health, free disk, replica state</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/19-sheet-cnpg.png" alt="CloudNativePG: instances, primaries, backup age"><br><sub>CloudNativePG: instances, primaries, backup age</sub></td>
<td valign="top" width="33%"><img src="screenshots/20-sheet-prometheus.png" alt="Prometheus: targets down, series"><br><sub>Prometheus: targets down, series</sub></td>
<td valign="top" width="33%"><img src="screenshots/21-sheet-grafana.png" alt="Grafana: version, database health, URL"><br><sub>Grafana: version, database health, URL</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/22-sheet-kured.png" alt="kured: which node reboots, and a stuck lock"><br><sub>kured: which node reboots, and a stuck lock</sub></td>
</tr>
</table>

## Nodes

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/23-nodes.png" alt="Nodes: CPU and RAM used vs. requested, disk, pods"><br><sub>Nodes: CPU and RAM used vs. requested, disk, pods</sub></td>
<td valign="top" width="33%"><img src="screenshots/24-nodes-details.png" alt="Per-node history, OS, kernel, runtime, age"><br><sub>Per-node history, OS, kernel, runtime, age</sub></td>
<td valign="top" width="33%"><img src="screenshots/25-nodes-rebooting.png" alt="A node held by kured, high memory and disk"><br><sub>A node held by kured, high memory and disk</sub></td>
</tr>
</table>

## Workloads

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/26-workloads.png" alt="Workloads by namespace, problems first"><br><sub>Workloads by namespace, problems first</sub></td>
<td valign="top" width="33%"><img src="screenshots/27-workloads-expanded.png" alt="A workload with its images and pods"><br><sub>A workload with its images and pods</sub></td>
<td valign="top" width="33%"><img src="screenshots/28-workloads-problems.png" alt="Filter: only workloads with problems"><br><sub>Filter: only workloads with problems</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/29-workloads-search.png" alt="Search by name, namespace or image"><br><sub>Search by name, namespace or image</sub></td>
</tr>
</table>

## Storage, network, events

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/30-storage.png" alt="StorageClasses and volumes"><br><sub>StorageClasses and volumes</sub></td>
<td valign="top" width="33%"><img src="screenshots/31-storage-volumes.png" alt="Fill level, Longhorn state and the pods using each volume"><br><sub>Fill level, Longhorn state and the pods using each volume</sub></td>
<td valign="top" width="33%"><img src="screenshots/32-network.png" alt="Every ingress host with its certificate, soonest expiry first"><br><sub>Every ingress host with its certificate, soonest expiry first</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/33-network-loadbalancer.png" alt="LoadBalancer services"><br><sub>LoadBalancer services</sub></td>
<td valign="top" width="33%"><img src="screenshots/34-events.png" alt="Warnings Kubernetes reported itself"><br><sub>Warnings Kubernetes reported itself</sub></td>
</tr>
</table>

## Last 7 days, silencing, backups

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/61-history.png" alt="Last 7 days: one cell per day, coloured by its worst incident, and the newest incidents with start and duration"><br><sub>Last 7 days: one cell per day, coloured by its worst incident, and the newest incidents with start and duration</sub></td>
<td valign="top" width="33%"><img src="screenshots/62-history-all.png" alt="“Show all” unfolds the whole week"><br><sub>"Show all" unfolds the whole week</sub></td>
<td valign="top" width="33%"><img src="screenshots/63-silence.png" alt="Silence a known issue for an hour up to a week: it stays visible but no longer counts"><br><sub>Silence a known issue for an hour up to a week: it stays visible but no longer counts</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/66-backups.png" alt="Backups: CloudNativePG, Longhorn, etcd and Velero with last success and target"><br><sub>Backups: CloudNativePG, Longhorn, etcd and Velero with last success and target</sub></td>
<td valign="top" width="33%"><img src="screenshots/67-backups-more.png" alt="Backup targets and what has no backup at all"><br><sub>Backup targets and what has no backup at all</sub></td>
<td valign="top" width="33%"><img src="screenshots/74-desktop-backups.png" alt="The backups tab on a desktop"><br><sub>The backups tab on a desktop</sub></td>
</tr>
</table>

## Security

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/64-sheet-vulnerabilities.png" alt="Known vulnerabilities (off by default): the advisory, its severity and the release that fixes it"><br><sub>Known vulnerabilities (off by default): the advisory, its severity and the release that fixes it</sub></td>
<td valign="top" width="33%"><img src="screenshots/65-sheet-security.png" alt="Security posture: privileged containers, host access, missing limits, as hints"><br><sub>Security posture: privileged containers, host access, missing limits, as hints</sub></td>
</tr>
</table>

## What is checked

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/68-modules.png" alt="Every check and every recognised tool with its own switch; what Helm switched off is locked"><br><sub>Every check and every recognised tool with its own switch; what Helm switched off is locked</sub></td>
<td valign="top" width="33%"><img src="screenshots/69-modules-actions.png" alt="Action types and notifications, switchable on their own"><br><sub>Action types and notifications, switchable on their own</sub></td>
<td valign="top" width="33%"><img src="screenshots/59-settings-maintenance.png" alt="The maintenance window and pairing another device"><br><sub>The maintenance window and pairing another device</sub></td>
</tr>
</table>

## Demo and German

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/60-demo.png" alt="The demo (demo.kubernanny.app, or “Try the demo first” in the app): three made-up clusters"><br><sub>The demo (demo.kubernanny.app, or "Try the demo first" in the app): three made-up clusters</sub></td>
<td valign="top" width="33%"><img src="screenshots/70-de-clusters.png" alt="German: the cluster list"><br><sub>German: the cluster list</sub></td>
<td valign="top" width="33%"><img src="screenshots/71-de-overview.png" alt="German: a cluster with outages"><br><sub>German: a cluster with outages</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/72-de-issues.png" alt="German: problems with cause and action"><br><sub>German: problems with cause and action</sub></td>
<td valign="top" width="33%"><img src="screenshots/73-de-backups.png" alt="German: backups"><br><sub>German: backups</sub></td>
</tr>
</table>

## Settings and pairing

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/35-settings.png" alt="Settings of a cluster"><br><sub>Settings of a cluster</sub></td>
<td valign="top" width="33%"><img src="screenshots/36-settings-agent-and-pairing.png" alt="Agent info and a pairing code for another device"><br><sub>Agent info and a pairing code for another device</sub></td>
</tr>
</table>

## Light mode

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/40-light-clusters.png" alt="Light mode: cluster list"><br><sub>Light mode: cluster list</sub></td>
<td valign="top" width="33%"><img src="screenshots/41-light-overview.png" alt="Light mode: overview"><br><sub>Light mode: overview</sub></td>
<td valign="top" width="33%"><img src="screenshots/42-light-nodes.png" alt="Light mode: nodes"><br><sub>Light mode: nodes</sub></td>
</tr>
</table>

## Tablet and desktop

<table>
<tr>
<td valign="top" width="50%"><img src="screenshots/43-tablet-overview.png" alt="Tablet"><br><sub>Tablet</sub></td>
<td valign="top" width="50%"><img src="screenshots/44-tablet-storage.png" alt="Tablet: storage"><br><sub>Tablet: storage</sub></td>
</tr>
<tr>
<td valign="top" width="50%"><img src="screenshots/45-desktop-clusters.png" alt="Desktop: cluster list"><br><sub>Desktop: cluster list</sub></td>
<td valign="top" width="50%"><img src="screenshots/46-desktop-overview.png" alt="Desktop: vital signs stay on the left"><br><sub>Desktop: vital signs stay on the left</sub></td>
</tr>
<tr>
<td valign="top" width="50%"><img src="screenshots/47-desktop-charts.png" alt="Desktop: history"><br><sub>Desktop: history</sub></td>
<td valign="top" width="50%"><img src="screenshots/48-desktop-services.png" alt="Desktop: components"><br><sub>Desktop: components</sub></td>
</tr>
<tr>
<td valign="top" width="50%"><img src="screenshots/49-desktop-nodes.png" alt="Desktop: nodes"><br><sub>Desktop: nodes</sub></td>
<td valign="top" width="50%"><img src="screenshots/50-desktop-workloads.png" alt="Desktop: workloads"><br><sub>Desktop: workloads</sub></td>
</tr>
<tr>
<td valign="top" width="50%"><img src="screenshots/51-desktop-storage.png" alt="Desktop: storage"><br><sub>Desktop: storage</sub></td>
<td valign="top" width="50%"><img src="screenshots/52-desktop-network.png" alt="Desktop: network"><br><sub>Desktop: network</sub></td>
</tr>
<tr>
<td valign="top" width="50%"><img src="screenshots/53-desktop-green.png" alt="Desktop: a healthy cluster"><br><sub>Desktop: a healthy cluster</sub></td>
<td valign="top" width="50%"><img src="screenshots/54-desktop-light-clusters.png" alt="Desktop, light: cluster list"><br><sub>Desktop, light: cluster list</sub></td>
</tr>
<tr>
<td valign="top" width="50%"><img src="screenshots/55-desktop-light-overview.png" alt="Desktop, light: overview"><br><sub>Desktop, light: overview</sub></td>
</tr>
</table>

## Command line

<table>
<tr>
<td valign="top" width="50%"><img src="screenshots/56-terminal-pairing.png" alt="The agent log: QR code, one-time pairing code and the agent's key fingerprint"><br><sub>The agent log: QR code, one-time pairing code and the agent's key fingerprint</sub></td>
<td valign="top" width="50%"><img src="screenshots/57-terminal-metrics.png" alt="kubernanny_* metrics for your Prometheus"><br><sub>kubernanny_* metrics for your Prometheus</sub></td>
</tr>
<tr>
<td valign="top" width="50%"><img src="screenshots/58-terminal-api.png" alt="The status API"><br><sub>The status API</sub></td>
</tr>
</table>
