#!/usr/bin/env bash
# Preserve the build command and expose compiler failures as check annotations.
set -uo pipefail
log_file="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/musaic-xcodebuild-${RANDOM}.log"
xcodebuild "$@" 2>&1 | tee "$log_file"
result=${PIPESTATUS[0]}
if [[ "$result" -ne 0 ]]; then
  while IFS= read -r line; do
    line="${line//%/%25}"
    line="${line//$'\r'/%0D}"
    printf '::error::%s\n' "$line"
  done < <(grep -E '(^|[[:space:]])(fatal )?error:|xcodebuild: error:' "$log_file" | head -25)
fi
exit "$result"
