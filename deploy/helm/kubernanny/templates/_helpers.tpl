{{- define "kubernanny.name" -}}kubernanny{{- end }}

{{- define "kubernanny.labels" -}}
app.kubernetes.io/name: {{ include "kubernanny.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end }}

{{- define "kubernanny.selectorLabels" -}}
app.kubernetes.io/name: {{ include "kubernanny.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "kubernanny.publicUrl" -}}
{{- if .Values.publicUrl -}}
{{ .Values.publicUrl }}
{{- else if .Values.ingress.enabled -}}
{{ ternary "https" "http" .Values.ingress.tls }}://{{ .Values.ingress.host }}
{{- end -}}
{{- end }}

{{/* Action types switched off: actions.disabled, plus every write action without rbac.allowActions. JSON array. */}}
{{- define "kubernanny.disabledActions" -}}
{{- $rbac := .Files.Get "files/rbac.json" | fromJson -}}
{{- $list := .Values.actions.disabled | default list -}}
{{- if not .Values.rbac.allowActions -}}
{{- $list = concat $list $rbac.writeActions -}}
{{- end -}}
{{- $list | uniq | toJson -}}
{{- end }}

{{/* Write action types that are enabled and offered by at least one enabled module: what the ClusterRole grants. JSON array. */}}
{{- define "kubernanny.enabledWriteActions" -}}
{{- $rbac := .Files.Get "files/rbac.json" | fromJson -}}
{{- $disabledModules := .Values.checks.disabled | default list -}}
{{- $disabledActions := include "kubernanny.disabledActions" . | fromJsonArray -}}
{{- $out := list -}}
{{- range $type := $rbac.writeActions -}}
{{- if not (has $type $disabledActions) -}}
{{- range (get $rbac.actions $type).modules -}}
{{- if not (has . $disabledModules) -}}{{- $out = append $out $type -}}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- $out | uniq | toJson -}}
{{- end }}

{{/*
Refuses a typo in the hard switches: an id in checks.disabled or
actions.disabled that no module or action has would switch nothing off while
the values say otherwise. The lists come from files/rbac.json (`npm run rbac`).
Custom components are named `custom:<id>`.
*/}}
{{- define "kubernanny.validateSwitches" -}}
{{- $rbac := .Files.Get "files/rbac.json" | fromJson -}}
{{- range (.Values.checks.disabled | default list) -}}
{{- if not (or (has . $rbac.knownModules) (hasPrefix "custom:" .)) -}}
{{- fail (printf "checks.disabled: unknown module %q. Known: %s" . (join ", " $rbac.knownModules)) -}}
{{- end -}}
{{- end -}}
{{- if not (has (.Values.notifications.detail | default "full") (list "full" "minimal")) -}}
{{- fail (printf "notifications.detail must be full or minimal, got %q" .Values.notifications.detail) -}}
{{- end -}}
{{- if not (has (.Values.notifications.webhookFormat | default "auto") (list "auto" "discord" "slack" "gotify" "json")) -}}
{{- fail (printf "notifications.webhookFormat must be auto, discord, slack, gotify or json, got %q" .Values.notifications.webhookFormat) -}}
{{- end -}}
{{- range (.Values.actions.disabled | default list) -}}
{{- if not (has . $rbac.actionTypes) -}}
{{- fail (printf "actions.disabled: unknown action type %q. Known: %s" . (join ", " $rbac.actionTypes)) -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/* True ("true") when checks.disabled contains notifications: no channel is rendered at all. */}}
{{- define "kubernanny.notificationsLocked" -}}
{{- if has "notifications" (.Values.checks.disabled | default list) -}}true{{- end -}}
{{- end }}
