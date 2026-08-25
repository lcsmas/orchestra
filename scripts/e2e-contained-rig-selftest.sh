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
arm "CONTROL: normal operation PASSES and the child runs" 0 yes \
  "PREFLIGHT PASSED" \
  RIG_SELFTEST_CONTROL=1

echo
if (( fails == 0 )); then
  echo "SELF-TEST PASSED: 4 hostile arms aborted rc=90 without launching; the control launched."
  exit 0
fi
echo "SELF-TEST FAILED: ${fails} arm(s) did not behave as required."
exit 1
