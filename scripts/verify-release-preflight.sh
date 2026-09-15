#!/usr/bin/env bash
#
# verify-release-preflight.sh — fixture rig for the #78 tag-vs-master preflight.
#
# Exercises scripts/release-preflight.sh WITHOUT driving a real release: every
# external read (ls-remote tags, gh releases, commit-range counts) is stubbed
# through the RP_* env overrides the library exposes. NOTHING here pushes, tags,
# or touches origin — the "repo" is a set of canned command outputs.
#
# Arms (each asserts the PRINTED VERDICT TEXT, not just the exit code — a marker
# assertion as specific as the claim it certifies, carry-forward 2):
#
#   A  must-FAIL  tag == master (master adds 0 beyond newest tag)
#                 → rp_two_way_discriminator REFUSES: rc=3 AND prints
#                   'refuse to cut a duplicate'
#   B  must-PASS  master ahead by N  → rc=0 AND prints 'master ahead by N commits'
#   C  first release (no origin tag) → rc=0 AND prints 'first release'
#   D  instrument error (bad range)  → rc=4 AND prints 'fail closed' (fails closed)
#   E  newest-tag version order      → picks vN.N.270, NOT alphabetical vN.N.99
#   F  next-version free             → rc=0, 'is free'
#   G  next-version taken on tag     → rc=5, 'ALREADY TAKEN'
#   H  next-version taken on release → rc=5, 'ALREADY TAKEN' (gh-only race)
#
# Plus a MUTATION check (C3): inverting the refuse condition in the library must
# turn arm A GREEN — proving arm A actually detects the defect (a RED test).

set -uo pipefail
cd "$(dirname "$0")/.."
LIB="scripts/release-preflight.sh"

FAILED=0
pass() { printf '  ok   %-28s %s\n' "$1" "$2"; }
fail() { printf '  FAIL %-28s %s\n' "$1" "$2"; FAILED=1; }

# Run the library in a clean subshell with the given RP_* stubs preset, capture
# stdout+stderr and rc. Args after the fn name are passed to it.
# usage: run_arm "<env assignments>" <fn> [args...]
run_arm() {
  local env_pre="$1"; shift
  local out rc
  out="$(bash -c "
    set -uo pipefail
    $env_pre
    . '$LIB'
    \"\$@\"
  " _ "$@" 2>&1)"; rc=$?
  RUN_OUT="$out"; RUN_RC="$rc"
}

# assert rc == expected AND out contains the marker substring
assert() {
  local name="$1" want_rc="$2" marker="$3"
  if [ "$RUN_RC" != "$want_rc" ]; then
    fail "$name" "rc=$RUN_RC (want $want_rc) out=[$RUN_OUT]"; return
  fi
  case "$RUN_OUT" in
    *"$marker"*) pass "$name" "rc=$RUN_RC ok, marker '$marker' present" ;;
    *) fail "$name" "rc=$RUN_RC but marker '$marker' MISSING in out=[$RUN_OUT]" ;;
  esac
}

# Canned ls-remote output: three tags, deliberately NOT in version order to prove
# the version-sort (arm E). Alphabetical tail would be v0.5.99.
TAGS_OUTPUT='printf "aaa\trefs/tags/v0.5.99\nbbb\trefs/tags/v0.5.99^{}\nccc\trefs/tags/v0.5.270\nddd\trefs/tags/v0.5.268\n"'

# ---- Arm E: newest tag by version order ------------------------------------
run_arm "export RP_LS_REMOTE_TAGS='$TAGS_OUTPUT'" rp_newest_origin_tag
if [ "$RUN_RC" = 0 ] && [ "$RUN_OUT" = "v0.5.270" ]; then
  pass "E newest-tag-version-order" "picked $RUN_OUT (not alphabetical v0.5.99)"
else
  fail "E newest-tag-version-order" "got [$RUN_OUT] rc=$RUN_RC (want v0.5.270)"
fi

# ---- Arm A: tag == master (master adds 0) → REFUSE -------------------------
# ahead = _rp_log_count tag master = 0 ; behind = _rp_log_count master tag = 0
run_arm "export RP_LOG_COUNT_CMD='echo 0'" rp_two_way_discriminator v0.5.270 origin/master
assert "A tag==master REFUSE" 3 "refuse to cut a duplicate"

# ---- Arm B: master ahead by N → PROCEED ------------------------------------
# ahead (tag..master) = 5 ; behind (master..tag) = 0. RP_LOG_COUNT_CMD sees $1 $2.
run_arm "export RP_LOG_COUNT_CMD='if [ \"\$1\" = v0.5.270 ]; then echo 5; else echo 0; fi'" \
        rp_two_way_discriminator v0.5.270 origin/master
assert "B master-ahead PROCEED" 0 "master ahead by 5 commits"

# ---- Arm C: first release (no origin tag) ----------------------------------
run_arm "export RP_LOG_COUNT_CMD='echo 0'" rp_two_way_discriminator "" origin/master
assert "C first-release" 0 "first release"

# ---- Arm D: instrument error (fail closed) ---------------------------------
run_arm "export RP_LOG_COUNT_CMD='echo ERR'" rp_two_way_discriminator v0.5.270 origin/master
assert "D instrument-error fail-closed" 4 "fail closed"

# ---- Arm F: next version free ----------------------------------------------
run_arm "export RP_LS_REMOTE_TAGS='$TAGS_OUTPUT'; export RP_GH_RELEASE_TAGS='printf \"v0.5.270\nv0.5.268\n\"'" \
        rp_next_version_free v0.5.271
assert "F next-version-free" 0 "is free"

# ---- Arm G: next version taken on origin tag -------------------------------
run_arm "export RP_LS_REMOTE_TAGS='$TAGS_OUTPUT'; export RP_GH_RELEASE_TAGS='printf \"\n\"'" \
        rp_next_version_free v0.5.270
assert "G next-version-taken-tag" 5 "ALREADY TAKEN"

# ---- Arm H: next version taken on gh release only (the v0.5.253 race) -------
# Free on origin tags, but a release already claimed it mid-flight.
run_arm "export RP_LS_REMOTE_TAGS='printf \"\n\"'; export RP_GH_RELEASE_TAGS='printf \"v0.5.271\n\"'" \
        rp_next_version_free v0.5.271
assert "H next-version-taken-release" 5 "ALREADY TAKEN"

# ---- MUTATION check (C3): invert the refuse condition, arm A must go GREEN --
# Copy the lib, flip `-eq 0` to `-ne 0` in the discriminator, re-run arm A. A
# correctly-detecting test now sees the tag==master case PROCEED (rc=0) instead
# of refuse — i.e. the arm's rc-3 assertion would FAIL on the mutant. We assert
# the mutant is DETECTED: under the mutation, arm A's condition no longer fires.
MUT="$(mktemp /tmp/release-preflight-mut.XXXXXX.sh)"
trap 'rm -f "$MUT"' EXIT
sed 's/if \[ "\$ahead" -eq 0 \]; then/if [ "$ahead" -ne 0 ]; then/' "$LIB" > "$MUT"
if ! grep -q 'if \[ "\$ahead" -ne 0 \]; then' "$MUT"; then
  fail "MUT mutation-applied" "sed did not flip the condition — mutation string not present in $MUT"
else
  mout="$(bash -c "
    set -uo pipefail
    export RP_LOG_COUNT_CMD='echo 0'
    . '$MUT'
    rp_two_way_discriminator v0.5.270 origin/master
  " 2>&1)"; mrc=$?
  # On the mutant, ahead=0 no longer triggers refuse (rc=3); it falls through to
  # the 'shipping them' branch (rc=0). So arm A's rc-3 assertion would fail → the
  # test DETECTS the mutant.
  if [ "$mrc" != 3 ]; then
    pass "MUT arm-A-detects-mutation" "mutant rc=$mrc≠3 → arm A would FAIL on it (RED test)"
  else
    fail "MUT arm-A-detects-mutation" "mutant still rc=3 — arm A is blind to the flipped condition"
  fi
fi

echo
if [ "$FAILED" -ne 0 ]; then
  echo "#78 release-preflight rig: FAILED"
  exit 1
fi
echo "#78 release-preflight rig: PASS — all arms + mutation check green"
