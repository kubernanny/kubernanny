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
