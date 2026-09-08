#!/usr/bin/env bash
# Issue #117 — the wake E2E matrix. Runs every arm and requires ALL to pass.
#
# Each arm drives the REAL sweep against a REAL SQLite bus and a REAL structured
# session, counting the `user-message` events the reader's transcript would
# render. No window is opened: this is main-process code only, no Electron.
#
# WHICH ARMS ACTUALLY DISCRIMINATE (stated, not implied — a matrix where every
# arm is counted as a gate hides which ones are decoration):
#   coalesce      kills the dedup guard        (3 turns instead of 1)
#   switch_off    kills the switch check       (fires with the switch off)
#   fires         kills a body leak            (bodyLeaks 1)
#   check_no_ack  kills a host-side ack        (1 turn instead of 2)
#   control_second proves the rig can see turn #2 — without it, every
#                 "exactly 1" above would also pass on a rig that renders
#                 nothing after the first turn.
#   ack_clears    reported for coverage; it does NOT discriminate on its own
#                 (the dedup ledger already suppresses a second wake, so it
#                 passes on a build that ignores the ack entirely).
set -uo pipefail
cd "$(dirname "$0")/.."
ARMS=(fires switch_off coalesce ack_clears control_second check_no_ack)
FAILED=0
for arm in "${ARMS[@]}"; do
  out="$(node --experimental-strip-types --import ./scripts/.r2-register.mjs \
          scripts/e2e-bus-wake.mjs "$arm" 2>/dev/null | tail -1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '  FAIL %-16s rc=%s %s\n' "$arm" "$rc" "$out"
    FAILED=1
  else
    printf '  ok   %-16s %s\n' "$arm" "$out"
  fi
done
if [ "$FAILED" -ne 0 ]; then
  echo "#117 wake E2E: FAILED"
  exit 1
fi
echo "#117 wake E2E: PASS — ${#ARMS[@]}/${#ARMS[@]} arms"
