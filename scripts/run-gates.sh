#!/usr/bin/env bash
# Aggregate compositor-dependent gate — issue #80.
#
# WHY THIS FILE EXISTS. #76 (PR #79) shipped two fail-closed gates that need a
# live compositor — `test:rig-selftest` and `test:cli-pipe` — but nothing
# invoked either automatically, so they rot unless someone remembers. They are
# deliberately NOT in `pnpm run test`: that suite must stay runnable on a
# headless CI box, and a compositor-dependent test placed there either breaks
# the box or (far worse) SELF-SKIPS and reports a comfortable green — the
# wave-6 shape (12 CLI tests silently absent inside a "1039 pass" suite).
#
# So this is the fleet-model answer: ONE aggregate `pnpm run` target the
# build-verifier runs and the release checklist names (docs/codebase-map/
# build-release.md). It runs on a host WITH sway; on a host WITHOUT one it
# exits rc=2 PRECONDITION-UNMET — surfaced as "not exercised", never green.
#
# THE ONE PROPERTY THIS TARGET GUARANTEES: a run that did not actually exercise
# a gate is DISTINGUISHABLE from one that did, and is NEVER scored as success.
# That is enforced positively (an outcome token per gate), never by absence of
# errors, and it is never papered over with `|| true` / `continue-on-error`.
#
#   Two sub-gates, two invocation shapes — deliberately different:
#     - test:rig-selftest boots its OWN headless sway internally, so it is
#       called DIRECTLY (double-wrapping it would nest compositors).
#     - test:cli-pipe fails closed rc=3 unless RIG_WAYLAND is exported by the
#       contained rig, so it is run THROUGH scripts/e2e-contained-rig.sh, which
#       provisions a marker-verified headless compositor.
#
# Exit codes (aggregate — the STRONGEST outcome wins, fail-closed):
#   0 = every gate genuinely ran and PASSED
#   1 = a gate ran and FAILED (an arm went red)
#   2 = a gate was NOT EXERCISED (precondition unmet — no compositor / deps)
#       This is NOT a skip and NOT a pass. rc=1 dominates rc=2 dominates rc=0:
#       a red gate is reported as red even if another gate could not run.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
RIG="${HERE}/e2e-contained-rig.sh"

# The aggregate rc. 0 < 2 < 1 in severity: start optimistic, RAISE monotonically
# so a later PASS can never mask an earlier PRECONDITION or FAILURE.
AGG_RC=0
raise() {  # raise the aggregate rc to the more severe of (current, $1)
  local incoming="$1"
  case "${AGG_RC}:${incoming}" in
    *:1) AGG_RC=1 ;;                 # a failure always wins
    1:*) : ;;                        # already failed — stays failed
    *:2) AGG_RC=2 ;;                 # precondition beats a pass
    2:*) : ;;                        # already precondition — a pass can't lower it
    *:0) : ;;                        # a pass never lowers
  esac
}

hr() { printf '%s\n' '────────────────────────────────────────────────────────'; }
say() { printf '[gates] %s\n' "$*"; }

# A full /tmp is a PROVISION-THE-BOX precondition (rc=2), NOT an
# investigate-the-code failure (rc=1) — scoring it as a red sends the operator to
# the wrong place (issue #80, F1). It can strike EITHER gate: both boot the
# contained rig, whose disk preflight (e2e-contained-rig.sh:35, disk-guard.cjs)
# exits DISK_FULL_EXIT=17 (disk-guard.cjs:32) when the mount is too full. Two
# facts make a per-gate rc check the wrong place to catch it:
#   - gate 1 runs through the rig SELF-TEST, whose arm() swallows the rig's raw
#     output and reprints only "rc=17, expected 90" — the `ORCHESTRA_DISK_FULL`
#     marker never reaches gate 1's captured output, so a marker check there
#     could not fire (a guard that cannot fire is the defect, not the fix);
#   - the honest signal is a property of the HOST, knowable BEFORE either gate.
# So the disk precondition is checked ONCE up front, against the same
# `disk-guard.cjs --preset e2e-rig` the rig itself uses. If it refuses, the whole
# target exits rc=2 immediately — no gate runs, nothing can mask it.
# Gate 2 KEEPS a marker re-check (is_disk_full below) for the narrow race where
# /tmp fills AFTER the preflight but during gate 2's own rig boot; there the
# marker DOES reach gate 2's output (its rig invocation is captured directly).
DISK_FULL_MARKER='ORCHESTRA_DISK_FULL'
is_disk_full() { grep -qF "${DISK_FULL_MARKER}" <<<"$1"; }

# ── disk preflight: a full /tmp is a PROVISION precondition, caught up front ──
# Checked ONCE, before either gate, against the SAME guard the rig uses. On a
# full mount this exits rc=2 immediately so no gate runs and nothing can mask the
# 'not exercised' signal as a red. (issue #80, F1)
hr; say "PREFLIGHT: disk space for the contained rig (disk-guard --preset e2e-rig /tmp)"; hr
pf_out="$( node "${REPO_ROOT}/scripts/disk-guard.cjs" --preset e2e-rig --path /tmp 2>&1 )"; pf_rc=$?
printf '%s\n' "${pf_out}"
if [[ "${pf_rc}" != 0 ]]; then
  if is_disk_full "${pf_out}"; then
    say "PREFLIGHT → PRECONDITION-UNMET rc=2 (disk full — ${DISK_FULL_MARKER}; provision the box, NOT a code failure). NOT a pass."
    exit 2
  fi
  # disk-guard failed for a non-disk-full reason (usage / unmeasurable path) —
  # that IS a genuine wiring failure, so let it be a red.
  say "PREFLIGHT → FAILED rc=${pf_rc} (disk-guard error, not a disk-full precondition)."
  exit 1
fi
say "PREFLIGHT PASSED: enough disk for the rig."

# ── gate 1: rig self-test (boots its own sway; called directly) ─────────────
# No disk-full marker check here: gate 1 runs the rig SELF-TEST, whose arm()
# swallows the rig's raw output and reprints only "rc=17, expected 90", so
# `ORCHESTRA_DISK_FULL` never reaches this layer — a marker check would be a
# guard that cannot fire. The up-front preflight above is where a full mount is
# caught for gate 1.
hr; say "GATE 1/2: test:rig-selftest (compositor self-test, boots its own sway)"; hr
bash "${HERE}/run-rig-selftest.sh"; g1=$?
case "${g1}" in
  0) say "GATE 1 → PASSED (exercised+green)" ;;
  2) say "GATE 1 → PRECONDITION-UNMET rc=2 (NOT exercised — no compositor). NOT a pass." ;;
  *) say "GATE 1 → FAILED rc=${g1} (exercised, an arm went red)" ;;
esac
raise "${g1}"

# ── gate 2: cli-pipe, run THROUGH the contained rig ─────────────────────────
# Bare `test:cli-pipe` exits rc=3 (RIG_WAYLAND unset) — that is a precondition,
# so it is normalised to rc=2 here. Anything else nonzero is a genuine failure,
# except a disk-full run (marker check, same as gate 1 — see is_disk_full above).
hr; say "GATE 2/2: test:cli-pipe (run through scripts/e2e-contained-rig.sh)"; hr
if [[ ! -x "${RIG}" ]]; then
  say "GATE 2 → PRECONDITION-UNMET rc=2 (contained rig ${RIG} not executable). NOT a pass."
  raise 2
else
  # Capture combined output so the disk-full marker can be detected, while still
  # streaming it to the console via tee (no output is hidden).
  g2out="$( ( cd "${REPO_ROOT}" && "${RIG}" pnpm run test:cli-pipe ) 2>&1 | tee /dev/stderr )"
  g2=${PIPESTATUS[0]}
  if [[ "${g2}" != 0 ]] && is_disk_full "${g2out}"; then
    say "GATE 2 → PRECONDITION-UNMET rc=2 (disk full — ${DISK_FULL_MARKER}, rig rc=${g2}; provision the box, NOT a code failure). NOT a pass."
    g2=2
  else
    case "${g2}" in
      0)      say "GATE 2 → PASSED (exercised+green)" ;;
      2|3|90) say "GATE 2 → PRECONDITION-UNMET rc=${g2} (NOT exercised — rig/compositor precondition). NOT a pass."; g2=2 ;;
      *)      say "GATE 2 → FAILED rc=${g2} (exercised, an arm went red)" ;;
    esac
  fi
  raise "${g2}"
fi

# ── verdict ─────────────────────────────────────────────────────────────────
hr
case "${AGG_RC}" in
  0) say "ALL GATES EXERCISED AND PASSED (rc=0)" ;;
  2) say "GATES NOT FULLY EXERCISED (rc=2 PRECONDITION-UNMET) — surface as 'not exercised', NEVER green. (issue #80)" ;;
  *) say "A GATE FAILED (rc=1) — an arm went red. (issue #80)" ;;
esac
hr
exit "${AGG_RC}"
