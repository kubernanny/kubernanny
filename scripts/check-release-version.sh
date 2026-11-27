#!/usr/bin/env bash
# Checks that every file carrying the agent/chart/relay version agrees with the
# release version, and that CHANGELOG.md has a dated entry for it. CI runs it
# on a v* tag before anything is published; run it locally before tagging:
#   scripts/check-release-version.sh 0.3.0
set -euo pipefail
cd "$(dirname "$0")/.."

v="${1:?usage: $0 X.Y.Z}"
v="${v#v}"
fail=0
check() { # file, pattern that must match
  if ! grep -Eq "$2" "$1"; then echo "::error file=$1::does not carry version $v (expected /$2/)"; fail=1; fi
}
q="${v//./\\.}"
# release-please's marker may follow a version (release-please-config.json).
m='( *#? *x-release-please-version)?'

check deploy/helm/kubernanny/Chart.yaml "^version: $q$m$"
check deploy/helm/kubernanny/Chart.yaml "^appVersion: \"?$q\"?$m$"
check deploy/install.yaml "image: ghcr\.io/kubernanny/agent:$q$m$"
check deploy/relay/relay.yaml "image: ghcr\.io/kubernanny/relay:$q$m$"
check agent/src/version.ts "AGENT_VERSION = '$q';"
check agent/package.json "\"version\": \"$q\","
check relay/package.json "\"version\": \"$q\","
check README.md "kubernanny/v$q/deploy/install\.yaml"
check website/src/app/landing/install.component.ts "kubernanny/v$q/deploy/install\.yaml"
check deploy/relay/relay.yaml "kubernanny/v$q/deploy/relay/relay\.yaml"
# Written by hand ("## 0.4.0 (2026-11-27)") or by release-please ("## [0.4.1](…compare…) (2026-11-28)").
check CHANGELOG.md "^## (\[$q\]\([^)]*\)|$q) \([0-9]{4}-[0-9]{2}-[0-9]{2}\)"
if [ "$fail" = 0 ]; then echo "All version files and CHANGELOG.md agree on $v."; fi
exit "$fail"
