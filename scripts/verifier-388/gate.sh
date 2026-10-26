#!/usr/bin/env bash
# Verifier gate runner (seat 1, vague #388): gate.sh <candidate-branch> [--no-test] [--no-drive]
# G1 state · G2 tsc · G3 pnpm run test (+ isolated reruns of any failing file x3) · G4 build:bundles · 3 stub harnesses · G5 baseline drive + G10 before/after.
# Writes logs under $TMPDIR/gate-<branch>/ and prints ONE summary block. Never edits tracked files.
set -uo pipefail
BR="$1"; shift || true
NOTEST=0; NODRIVE=0; for a in "$@"; do [[ "$a" == --no-test ]] && NOTEST=1; [[ "$a" == --no-drive ]] && NODRIVE=1; done
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT" || exit 90
RIGDIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; L="${TMPDIR:-/var/tmp}/gate-${BR//\//_}"; mkdir -p "$L"
INT=ops-browser-orca-388
echo "== G1 STATE"
git fetch -q origin "$INT" "$BR" 2>&1 | tail -2
TIP="$(git ls-remote origin "refs/heads/$BR" | cut -f1)"; ITIP="$(git ls-remote origin "refs/heads/$INT" | cut -f1)"
git fetch -q origin "$BR" && git checkout -q --detach FETCH_HEAD || exit 91
HEAD_SHA="$(git rev-parse HEAD)"; MB="$(git merge-base "$ITIP" "$HEAD_SHA" 2>/dev/null || echo none)"
echo "G1 branch=$BR ls-remote=${TIP:0:8} HEAD=${HEAD_SHA:0:8} integration(ls-remote)=${ITIP:0:8} merge-base=${MB:0:8} rebased=$([[ "$MB" == "$ITIP" ]] && echo YES || echo NO) ahead=$(git rev-list --count "$ITIP..$HEAD_SHA" 2>/dev/null)"
git diff --stat "$ITIP" "$HEAD_SHA" | tail -1
pnpm install --frozen-lockfile --prefer-offline > "$L/install.log" 2>&1; echo "install RC=$?"
echo "== G2"; nice -n 10 npx tsc --noEmit > "$L/tsc.log" 2>&1; echo "G2 tsc RC=$? errors=$(grep -c 'error TS' "$L/tsc.log")"
if (( ! NOTEST )); then
  echo "== G3"; nice -n 10 pnpm run test > "$L/test.log" 2>&1; echo "G3 RC=$? tests=$(grep -E '^# tests' "$L/test.log" | awk '{print $3}') pass=$(grep -E '^# pass' "$L/test.log" | awk '{print $3}') fail=$(grep -E '^# fail' "$L/test.log" | awk '{print $3}') skipped=$(grep -E '^# skipped' "$L/test.log" | awk '{print $3}')"
  grep -E '^not ok' "$L/test.log" | cut -c1-200
  for f in $(grep -E "^\s+location: " "$L/test.log" | sed -E "s/.*'(.*):[0-9]+:[0-9]+'.*/\1/" | sort -u); do
    for i in 1 2 3; do nice -n 10 node --test --experimental-strip-types "$f" > "$L/iso-$i-$(basename "$f").log" 2>&1; echo "  isolated rerun $i of ${f#$ROOT/}: RC=$? $(grep -E '^# (pass|fail)' "$L/iso-$i-$(basename "$f").log" | tr '\n' ' ')"; done
  done
fi
echo "== G4"; rm -rf dist dist-electron; nice -n 10 pnpm run build:bundles > "$L/bundles.log" 2>&1; echo "G4 build:bundles RC=$?"
echo "== harnesses"
for h in verify-archive-browser-panel verify-browser-panel-dead-view verify-browser-panel-focus-steal; do node --experimental-strip-types "scripts/$h.mjs" > "$L/$h.log" 2>&1; echo "$h RC=$? $(grep -E 'passed$' "$L/$h.log")"; done
if (( ! NODRIVE )); then
  echo "== G5/G10 baseline drive on the BUILT candidate"
  node "$RIGDIR/g10.mjs" snap "$L/g10-before.json"; [[ "${G10B:-0}" == 1 ]] && node "$RIGDIR/g10b.mjs" snap "$L/g10b-before.json"
  export E2E_RIG_BASE="/var/tmp/v388-$(id -u)"; mkdir -p -m 700 "$E2E_RIG_BASE"; export CLAUDE_CONFIG_DIR_PIN="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
  nice -n 10 bash scripts/e2e-contained-rig.sh node "$RIGDIR/bp-drive.mjs" "$ROOT" "cand-${HEAD_SHA:0:8}" > "$L/drive.log" 2>&1; echo "drive RC=$?"
  grep -E '^(FAIL|RIG-RESULT)' "$L/drive.log" | cut -c1-300
  node "$RIGDIR/g10.mjs" snap "$L/g10-after.json"; node "$RIGDIR/g10.mjs" diff "$L/g10-before.json" "$L/g10-after.json"; [[ "${G10B:-0}" == 1 ]] && { node "$RIGDIR/g10b.mjs" snap "$L/g10b-after.json" >/dev/null; node "$RIGDIR/g10b.mjs" diff "$L/g10b-before.json" "$L/g10b-after.json" "bp-drive"; } || echo "G10b SUSPENDED (OPS freeze Q2: no contact with the real bus/keyring)"
fi
echo "logs: $L"
