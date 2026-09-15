#!/usr/bin/env bash
# Issue #90 — the wedge repro + recovery gate, all four arms.
#
# Each arm runs in its OWN process: agent-sdk.ts module state (the sessions map,
# the injected query factory) is global, so arms sharing a process would
# contaminate each other.
#
# The four arms are a matrix, not a list. `control_healthy` proves the rig can
# observe a turn STARTING at all — without it, every other arm's `started:false`
# would be indistinguishable from a dead instrument. `control_busy` proves the
# gate release REFUSES a slow-but-live turn, which is the negative arm the
# ticket demands.
set -uo pipefail
cd "$(dirname "$0")/.."
export WEDGE_HOME="${WEDGE_HOME:-/tmp/wedge90-home-$$}"

# Guarded teardown: WEDGE_HOME is env-overridable (${VAR:-default}), so an
# exported WEDGE_HOME wins and a bare `rm -rf "$WEDGE_HOME"` would delete
# whatever the caller aimed it at (e.g. WEDGE_HOME=$HOME). Refuse anything not
# under the expected /tmp/wedge90-* prefix — the reference pattern from
# scripts/verify-disk-guard.mjs:197 (#87 / #100). Refusal prints to stderr and
# skips the delete (never exits) so the arm loop stays sane.
wedge_rmrf() {
  case "$1" in
    /tmp/wedge90-*)
      rm -rf "$1"
      ;;
    *)
      echo "[wedge-rig] refusing to remove unexpected path: $1" >&2
      ;;
  esac
}

wedge_rmrf "$WEDGE_HOME"
RC=0
for arm in control_healthy wedged control_busy busy_backdated recovered; do
  line=$(timeout 120 node --experimental-strip-types --import ./scripts/.r2-register.mjs \
           scripts/e2e-session-wedge.mjs "$arm" 2>/dev/null | tail -1)
  echo "$line"
  # A missing line is a FAILED arm, not a passed one — an empty result must
  # never read as success (the arm printed nothing when the rig crashed).
  if [ -z "$line" ]; then echo "ARM $arm produced NO OUTPUT — treating as FAIL"; RC=1; continue; fi
  echo "$line" | grep -q '"ok":true' || RC=1
done
wedge_rmrf "$WEDGE_HOME"
# Review R2 — parked messages delivered EXACTLY ONCE. Separate rig because it
# needs a real inbox file on disk and drives recycleSession rather than the gate.
for arm in exactly_once control_nodeliver hook_drain_race; do
  line=$(timeout 120 node --experimental-strip-types --import ./scripts/.r2-register.mjs \
           scripts/e2e-session-wedge-redelivery.mjs "$arm" 2>/dev/null | tail -1)
  echo "$line"
  if [ -z "$line" ]; then echo "ARM $arm produced NO OUTPUT — treating as FAIL"; RC=1; continue; fi
  echo "$line" | grep -q '"ok":true' || RC=1
done

if [ "$RC" -eq 0 ]; then echo "e2e-session-wedge: ALL ARMS OK"; else echo "e2e-session-wedge: FAILURES"; fi
exit "$RC"
