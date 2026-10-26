#!/usr/bin/env bash
# Run each keyring arm as ONE gui-slot-wrapped rig invocation (hidden world is set by e2e-keyring.sh itself).
cd "$(git rev-parse --show-toplevel)"; V="$TMPDIR/v1"; export E2E_RIG_BASE="/var/tmp/v388-$(id -u)"; mkdir -p -m 700 "$E2E_RIG_BASE"
for a in forged unlocked locked nosvc recognised hung gnome relock isolated isolated-gnome; do
  grep -qE '^MemAvailable' /proc/meminfo && awk '/MemAvailable/{exit !($2 >= 6*1048576)}' /proc/meminfo || { echo "ARM $a SKIPPED: MemAvailable < 6 GB"; continue; }
  /var/tmp/orch-1000-b17728/gui-slot.sh bash scripts/e2e-keyring.sh "$PWD" --arms "$a" --out "$V/kr-shots-$a" --label "verifier-$a" > "$V/kr-arm-$a.log" 2>&1
  echo "ARM $a RC=$? $(grep -E '^VERDICT' "$V/kr-arm-$a.log" | tail -1 | cut -c1-120) clauses_pass=$(grep -cE '^  PASS' "$V/kr-arm-$a.log") clauses_fail=$(grep -cE '^  FAIL' "$V/kr-arm-$a.log")"
done
echo "ALL-ARMS-DONE"
