# Screenshots

One picture per screen of Kubernanny, taken from the built-in demo clusters (`DEMO=broken`, `warning`, `healthy`), in English unless marked German. `scripts/screenshots/run.sh` takes them again.


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
<td valign="top" width="33%"><img src="screenshots/05-overview-red.png" alt="A cluster with outages: the nanny's eye and a one-sentence headline"><br><sub>A cluster with outages: the nanny's eye and a one-sentence headline</sub></td>
<td valign="top" width="33%"><img src="screenshots/06-overview-issues.png" alt="Problems with cause, age and the action that fixes them"><br><sub>Problems with cause, age and the action that fixes them</sub></td>
<td valign="top" width="33%"><img src="screenshots/07-overview-charts.png" alt="Key numbers and components needing attention"><br><sub>Key numbers and components needing attention</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/84-overview-per-node.png" alt="Per node: use, requests and limits of its pods, overbooking and pods without a limit"><br><sub>Per node: use, requests and limits of its pods, overbooking and pods without a limit</sub></td>
<td valign="top" width="33%"><img src="screenshots/89-overview-ready-to-sync.png" alt="Manual Argo CD apps with a change waiting: one calm card, no issue"><br><sub>Manual Argo CD apps with a change waiting: one calm card, no issue</sub></td>
<td valign="top" width="33%"><img src="screenshots/90-ready-to-sync-list.png" alt="Ready to sync: revisions, image tags and the resources that change, with Sync"><br><sub>Ready to sync: revisions, image tags and the resources that change, with Sync</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/93-sheet-kubernanny-timing.png" alt="Kubernanny's own sheet: where the last check spent its time"><br><sub>Kubernanny's own sheet: where the last check spent its time</sub></td>
<td valign="top" width="33%"><img src="screenshots/37-overview-yellow.png" alt="A cluster with warnings only"><br><sub>A cluster with warnings only</sub></td>
<td valign="top" width="33%"><img src="screenshots/38-overview-green.png" alt="All green: nothing to do"><br><sub>All green: nothing to do</sub></td>
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
<td valign="top" width="33%"><img src="screenshots/16-sheet-argocd.png" alt="Argo CD: apps, sync and health, link to its UI"><br><sub>Argo CD: apps, sync and health, link to its UI</sub></td>
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
<td valign="top" width="33%"><img src="screenshots/28-workloads-problems.png" alt="Filter: only workloads with problems"><br><sub>Filter: only workloads with problems</sub></td>
</tr>
</table>

## Storage, network, events

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/30-storage.png" alt="StorageClasses and volumes"><br><sub>StorageClasses and volumes</sub></td>
<td valign="top" width="33%"><img src="screenshots/32-network.png" alt="Every ingress host with its certificate, soonest expiry first"><br><sub>Every ingress host with its certificate, soonest expiry first</sub></td>
<td valign="top" width="33%"><img src="screenshots/34-events.png" alt="Warnings Kubernetes reported itself"><br><sub>Warnings Kubernetes reported itself</sub></td>
</tr>
</table>

## Last 7 days, silencing, backups

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/61-history.png" alt="Last 7 days: one cell per day, coloured by its worst incident, and the newest incidents with start and duration"><br><sub>Last 7 days: one cell per day, coloured by its worst incident, and the newest incidents with start and duration</sub></td>
<td valign="top" width="33%"><img src="screenshots/63-silence.png" alt="Silence a known issue for an hour up to a week: it stays visible but no longer counts"><br><sub>Silence a known issue for an hour up to a week: it stays visible but no longer counts</sub></td>
<td valign="top" width="33%"><img src="screenshots/66-backups.png" alt="Backups: CloudNativePG, Longhorn, etcd and Velero with last success and target"><br><sub>Backups: CloudNativePG, Longhorn, etcd and Velero with last success and target</sub></td>
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
<td valign="top" width="33%"><img src="screenshots/60-demo.png" alt="The demo (demo.kubernanny.app, or “Try the demo first” in the app): three made-up clusters"><br><sub>The demo (demo.kubernanny.app, or “Try the demo first” in the app): three made-up clusters</sub></td>
<td valign="top" width="33%"><img src="screenshots/71-de-overview.png" alt="German: a cluster with outages"><br><sub>German: a cluster with outages</sub></td>
</tr>
</table>

## Settings and pairing

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/35-settings.png" alt="Settings of a cluster"><br><sub>Settings of a cluster</sub></td>
<td valign="top" width="33%"><img src="screenshots/36-settings-agent-and-pairing.png" alt="Agent info and a pairing code for another device"><br><sub>Agent info and a pairing code for another device</sub></td>
<td valign="top" width="33%"><img src="screenshots/98-settings-deadman.png" alt="The dead man's switch in a cluster's push settings: a warning when the agent goes silent"><br><sub>The dead man's switch in a cluster's push settings: a warning when the agent goes silent</sub></td>
</tr>
</table>

## Light mode

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/41-light-overview.png" alt="Light mode: overview"><br><sub>Light mode: overview</sub></td>
</tr>
</table>

## Tablet and desktop

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/43-tablet-overview.png" alt="Tablet"><br><sub>Tablet</sub></td>
<td valign="top" width="33%"><img src="screenshots/46-desktop-overview.png" alt="Desktop: vital signs stay on the left"><br><sub>Desktop: vital signs stay on the left</sub></td>
<td valign="top" width="33%"><img src="screenshots/49-desktop-nodes.png" alt="Desktop: nodes"><br><sub>Desktop: nodes</sub></td>
</tr>
<tr>
<td valign="top" width="33%"><img src="screenshots/55-desktop-light-overview.png" alt="Desktop, light: overview"><br><sub>Desktop, light: overview</sub></td>
</tr>
</table>

## Command line

<table>
<tr>
<td valign="top" width="33%"><img src="screenshots/56-terminal-pairing.png" alt="The agent log: QR code, one-time pairing code and the agent's key fingerprint"><br><sub>The agent log: QR code, one-time pairing code and the agent's key fingerprint</sub></td>
<td valign="top" width="33%"><img src="screenshots/57-terminal-metrics.png" alt="kubernanny_* metrics for your Prometheus"><br><sub>kubernanny_* metrics for your Prometheus</sub></td>
</tr>
</table>
