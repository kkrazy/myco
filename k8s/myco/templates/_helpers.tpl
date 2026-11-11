{{/* chart 名与全限定名 */}}
{{- define "myco.name" -}}
{{ .Chart.Name }}
{{- end -}}

{{- define "myco.fullname" -}}
{{ .Release.Name }}-{{ .Chart.Name }}
{{- end -}}

{{/* 镜像引用 */}}
{{- define "myco.image" -}}
{{- if not .Values.image.repository -}}
{{- fail "image.repository 必填（--set image.repository=registry-cbu.huawei.com/<ns>/myco）" -}}
{{- end -}}
{{- .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{/* 环境注入方式二选一：envFile 优先（--set-file 注入），其次 envFromSecret */}}
{{- define "myco.envMode" -}}
{{- if .Values.envFile -}}envFile{{- else if .Values.envFromSecret -}}secret{{- else -}}none{{- end -}}
{{- end -}}
