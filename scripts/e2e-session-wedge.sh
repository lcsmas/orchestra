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
rm -rf "$WEDGE_HOME"
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
rm -rf "$WEDGE_HOME"
if [ "$RC" -eq 0 ]; then echo "e2e-session-wedge: ALL ARMS OK"; else echo "e2e-session-wedge: FAILURES"; fi
exit "$RC"
