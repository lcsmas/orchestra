#!/usr/bin/env bash
# #395 — run every mutant of scripts/e2e-browser-cli.sh in turn (each boots the built app under its own headless sway and
# patches the BUILT bundle in place, restored byte-exact + cmp'd by the driver). Exit 0 only if every mutant was KILLED.
# Usage: scripts/e2e-browser-cli-mutants.sh <app-dir> [mutant ...]    (default: all)
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-}"; [[ -n "${APP_DIR}" ]] || { echo "usage: $0 <app-dir> [mutant ...]" >&2; exit 2; }
shift
if [[ $# -gt 0 ]]; then MUTANTS=("$@"); else read -r -a MUTANTS <<< "$("${HERE}/e2e-browser-cli.sh" --list | sed -n 's/^mutants: //p')"; fi
fail=0
for m in "${MUTANTS[@]}"; do
  out="$(mktemp "${TMPDIR:-/var/tmp}/b395-mutant-XXXXXX.log")"
  "${HERE}/e2e-browser-cli.sh" "${APP_DIR}" --mutant "$m" > "$out" 2>&1; rc=$?
  verdict="$(grep -E '^VERDICT:|^\[mutant\].*restored|REFUSED' "$out" | tr '\n' ' ')"
  echo "[$m] rc=${rc} ${verdict}   (log ${out})"
  [[ $rc -eq 0 ]] || fail=1
done
exit $fail
