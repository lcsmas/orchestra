#!/usr/bin/env bash
# Self-test for scripts/e2e-contained-rig.sh — proves the pre-flight assert can
# FAIL. A guard nobody has watched fire is indistinguishable from one that
# cannot, and the previous version of that assert PROVABLY could not: its
# `DISPLAY_IN_CHILD` branch was never assigned anywhere (unreachable
# decoration), and it was invoked as `preflight_assert "$MINE" "$MINE"`, i.e. a
# value compared to itself. Both were found in review; this file exists so the
# same class cannot come back unnoticed.
#
# Every arm runs the REAL rig script (no extracted copy — an extract can drift
# from what ships) with `true` as the child, so nothing but the rig is exercised.
# The positive terminator is the literal `PREFLIGHT PASSED` / `ABORT` line plus
# the exit code, and the child echoes a sentinel so we can tell "aborted before
# launch" from "launched and the child said nothing".
set -uo pipefail

RIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e-contained-rig.sh"
[[ -x "${RIG}" ]] || { echo "FATAL: ${RIG} not executable"; exit 2; }

# ── FAIL-CLOSED PRECONDITIONS (issue #76) ──────────────────────────────────
# This self-test needs a REAL compositor: every arm boots the rig's own sway and
# decodes a painted marker. It therefore cannot live in `pnpm run test`, which
# must stay runnable on a headless CI box.
#
# The failure mode being designed against is NOT "it errors on CI" — it is a
# SELF-SKIP that reports a comfortable green. Wave-6 shipped exactly that shape:
# 12 CLI tests self-skipped on a missing build artifact inside a suite reported
# as "1039 pass", silently omitting every CLI regression test. A test that skips
# itself is an ABSENT FAILURE wearing a pass.
#
# So this script NEVER skips. A missing dependency is a NAMED, non-zero exit
# (rc=2, distinct from rc=1 "an arm failed"), and the outcome is emitted as a
# single machine-readable RIG-SELFTEST: line that a caller can grep. Absence of
# that line is itself a detectable outcome — silence is never scored as success.
missing=()
for dep in sway swaymsg grim python3; do
  command -v "${dep}" >/dev/null 2>&1 || missing+=("${dep}")
done
if (( ${#missing[@]} > 0 )); then
  echo "RIG-SELFTEST: PRECONDITION-UNMET missing=${missing[*]}"
  cat >&2 <<EOF
FATAL: cannot run the rig self-test — missing: ${missing[*]}

  This self-test boots a real headless sway compositor and decodes a painted
  marker from a screenshot; it cannot be simulated. It is deliberately NOT part
  of \`pnpm run test\` for that reason.

  Run it on a host with sway available:   pnpm run test:rig-selftest

  It exits 2 (precondition unmet) rather than skipping, because a self-skipping
  test reports a green that hides an absent gate. (issue #76)
EOF
  exit 2
fi

SENTINEL='CHILD-LAUNCHED-SENTINEL-64'
fails=0
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s — %s\n' "$1" "$2"; fails=$((fails + 1)); }

# $1 label · $2 expected rc · $3 expect-launch (yes|no) · $4 REQUIRED reason
# substring · $5.. env assignments.
#
# The reason match is load-bearing: an arm that aborts for a DIFFERENT reason
# than the one it was written to test is a right answer from the wrong check,
# and it protects nothing. That happened for real here — a "bogus socket" arm
# passed because a SIBLING agent was painting the same marker colour at that
# instant, tripping the disambiguation guard instead of the mismatch check.
arm() {
  local label="$1" want_rc="$2" want_launch="$3" want_reason="$4"; shift 4
  local out rc
  out="$(env "$@" "${RIG}" /bin/sh -c "echo ${SENTINEL}" 2>&1)"; rc=$?
  local launched='no'
  grep -q "${SENTINEL}" <<<"${out}" && launched='yes'
  local line
  line="$(grep -E 'PREFLIGHT (PASSED|FAILED)|ABORT' <<<"${out}" | tail -1)"

  if [[ "${rc}" != "${want_rc}" ]]; then
    fail "${label}" "rc=${rc}, expected ${want_rc}"; printf '        %s\n' "${line}"; return
  fi
  if [[ "${launched}" != "${want_launch}" ]]; then
    fail "${label}" "child launched=${launched}, expected ${want_launch}"; return
  fi
  if [[ -n "${want_reason}" ]] && ! grep -qF "${want_reason}" <<<"${out}"; then
    fail "${label}" "aborted/passed for the WRONG reason (wanted '${want_reason}')"
    printf '        got: %s\n' "${line}"; return
  fi
  pass "${label} (rc=${rc}, launched=${launched}, reason verified)"
  printf '        %s\n' "${line}"
}

echo "== self-test: the pre-flight assert must ABORT on hostile input =="

# 1. The human's real compositor. The single most important arm.
arm "forcing WAYLAND_DISPLAY=wayland-1 (the human's screen) ABORTS" 90 no \
  "refusing wayland-1" \
  RIG_SELFTEST_FORCE_WAYLAND=wayland-1

# 2. A plausible-but-wrong socket: a sibling agent's headless compositor. Passing
#    here would mean gating against another agent's build.
arm "forcing a SIBLING socket (wayland-4) ABORTS" 90 no \
  "!= my marker-verified socket" \
  RIG_SELFTEST_FORCE_WAYLAND=wayland-4

# 3. Outright bogus value.
arm "forcing a bogus socket (wayland-999) ABORTS on the MISMATCH check" 90 no \
  "!= my marker-verified socket" \
  RIG_SELFTEST_FORCE_WAYLAND=wayland-999

# 4. THE PREVIOUSLY-DEAD BRANCH. This is the arm that proves the DISPLAY check is
#    now reachable at all: the old one could not fire because the variable it
#    read was never assigned.
arm "adding DISPLAY=:0 to the child env ABORTS (branch is now REACHABLE)" 90 no \
  "X11 must be unreachable by construction" \
  RIG_SELFTEST_ADD_DISPLAY=:0

# 5. POSITIVE CONTROL — normal operation must still reach the child. Without
#    this, an assert that aborts unconditionally would score 4/4 above.
#    It injects NO hostile env at all, which is the whole point: the control is
#    carried by the OUTCOME (rc=0 + launched=yes + "PREFLIGHT PASSED"), not by
#    any variable. It used to pass `RIG_SELFTEST_CONTROL=1`, which no code
#    anywhere read (0 consumers tree-wide) — inert decoration that made the arm
#    read as if it selected a mode in the rig. Removed; the arm is unchanged in
#    what it proves. (issue #76 review finding)
arm "CONTROL: normal operation PASSES and the child runs" 0 yes \
  "PREFLIGHT PASSED"

echo
if (( fails == 0 )); then
  echo "SELF-TEST PASSED: 4 hostile arms (3 distinct refusal clauses; arm 3 is a data variant of arm 2) aborted rc=90 without launching; the control launched."
  echo "RIG-SELFTEST: PASSED arms=5"
  exit 0
fi
echo "SELF-TEST FAILED: ${fails} arm(s) did not behave as required."
echo "RIG-SELFTEST: FAILED arms=5 failed=${fails}"
exit 1
