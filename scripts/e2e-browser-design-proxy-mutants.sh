#!/usr/bin/env bash
# #398 — run every mutant of scripts/e2e-browser-design-proxy.sh in turn (each boots the built app under its own headless sway and
# patches the BUILT bundle in place, restored byte-exact + cmp'd by the driver). Exit 0 only if every mutant was KILLED.
# Usage: [GUI_SLOT_CMD=/path/to/gui-slot.sh] scripts/e2e-browser-design-proxy-mutants.sh <app-dir> [mutant ...]    (default: all)
#   GUI_SLOT_CMD wraps EACH mutant run (the fleet's GUI semaphore, one slot per run so slots rotate).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${1:-}"; [[ -n "${APP_DIR}" ]] || { echo "usage: $0 <app-dir> [mutant ...]" >&2; exit 2; }
shift
if [[ $# -gt 0 ]]; then MUTANTS=("$@"); else read -r -a MUTANTS <<< "$("${HERE}/e2e-browser-design-proxy.sh" --list | sed -n 's/^mutants: //p')"; fi
fail=0
for m in "${MUTANTS[@]}"; do
  out="$(mktemp "${TMPDIR:-/var/tmp}/b398-mutant-XXXXXX.log")"
  # rc=90 = the contained rig could not prove its display (a sibling's marker raced ours): infrastructure, not a verdict — retry up to 3x
  for attempt in 1 2 3; do
    ${GUI_SLOT_CMD:-} "${HERE}/e2e-browser-design-proxy.sh" "${APP_DIR}" --mutant "$m" > "$out" 2>&1; rc=$?
    [[ $rc -eq 90 ]] || break
    echo "[$m] rig abort rc=90 (attempt ${attempt}) — retrying" >&2
  done
  verdict="$(grep -E '^VERDICT:|^\[mutant\].*restored|REFUSED' "$out" | tr '\n' ' ')"
  echo "[$m] rc=${rc} ${verdict}   (log ${out})"
  [[ $rc -eq 0 ]] || fail=1
done
exit $fail
