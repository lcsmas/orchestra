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

# ---- Arm A: ref adds 0 beyond newest tag → REFUSE (duplicate) --------------
# ahead = _rp_log_count tag ref = 0 ; behind = _rp_log_count ref tag = 0
run_arm "export RP_LOG_COUNT_CMD='echo 0'" rp_two_way_discriminator v0.5.270 HEAD
assert "A tag==ref REFUSE" 3 "refuse to cut a duplicate"

# ---- Arm B: ref ahead by N, tag not diverged → PROCEED ---------------------
# ahead (tag..ref) = 5 ; behind (ref..tag) = 0. RP_LOG_COUNT_CMD sees $1 $2:
# when $1 is the tag we are in the tag..ref (ahead) direction → 5, else 0.
run_arm "export RP_LOG_COUNT_CMD='if [ \"\$1\" = v0.5.270 ]; then echo 5; else echo 0; fi'" \
        rp_two_way_discriminator v0.5.270 HEAD
assert "B ref-ahead PROCEED" 0 "ahead by 5 commits"

# ---- Arm C: first release (no origin tag) ----------------------------------
run_arm "export RP_LOG_COUNT_CMD='echo 0'" rp_two_way_discriminator "" HEAD
assert "C first-release" 0 "first release"

# ---- Arm D: instrument error (fail closed) ---------------------------------
run_arm "export RP_LOG_COUNT_CMD='echo ERR'" rp_two_way_discriminator v0.5.270 HEAD
assert "D instrument-error fail-closed" 4 "fail closed"

# ---- Arm F1 (review): compares against the REF-BEING-TAGGED, not origin/master.
# The canonical --to-master flow: at preflight time origin/master == newest tag
# (advanced only later), while HEAD carries the unreleased work. Simulate BOTH
# refs off ONE stub keyed on the RANGE ENDPOINTS ($1=A $2=B of A..B):
#   tag..origin/master → 0  (master not yet advanced → FALSE-refuse if we used it)
#   tag..HEAD          → 3  (HEAD really is ahead)
#   HEAD..tag / master..tag → 0 (not diverged)
# must-FAIL: discriminating against origin/master REFUSES a real release (rc 3);
# must-PASS: discriminating against HEAD PROCEEDS (rc 0). The fix is choosing HEAD.
F1_STUB='case "$1 $2" in "v0.5.270 origin/master") echo 0;; "v0.5.270 HEAD") echo 3;; *) echo 0;; esac'
run_arm "export RP_LOG_COUNT_CMD='$F1_STUB'" rp_two_way_discriminator v0.5.270 origin/master
assert "F1 vs-master would-FALSE-REFUSE" 3 "refuse to cut a duplicate"
run_arm "export RP_LOG_COUNT_CMD='$F1_STUB'" rp_two_way_discriminator v0.5.270 HEAD
assert "F1 vs-HEAD PROCEEDS (the fix)" 0 "ahead by 3 commits"

# ---- Arm F2 (review): DIVERGED tag → REFUSE --------------------------------
# ahead (tag..ref) = 2 (ref has new work) AND behind (ref..tag) = 4 (tag carries
# commits ref lacks → cut from a different line). Must refuse rather than silently
# orphan the tagged work. $1=tag → ahead=2, else behind=4.
run_arm "export RP_LOG_COUNT_CMD='if [ \"\$1\" = v0.5.270 ]; then echo 2; else echo 4; fi'" \
        rp_two_way_discriminator v0.5.270 HEAD
assert "F2 diverged-tag REFUSE" 6 "DIVERGED tag"

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

# ---- Arm F3 (review): release.sh FAILS CLOSED on fetch failure -------------
# The wrapper in release.sh used to `warn … skipping` when `git fetch origin`
# failed — a no-network release then shipped WITHOUT the guard (exactly how the
# 3rd race shape got through). Drive the real release.sh in an isolated temp repo
# whose `origin` points at a nonexistent path so the fetch fails, non-dry-run,
# and require it to REFUSE with 'fail closed' (rc != 0), NOT proceed past the
# preflight. This exercises the actual release.sh branch, not a copy.
#
# We stop the script AT the preflight: RP_LS_REMOTE_TAGS is irrelevant because a
# fetch failure must abort BEFORE reading tags. gh auth is real (already checked
# above by the caller's env). Everything before the preflight is satisfied by the
# temp repo: clean tree, on a branch, not behind (origin/<branch> unfetchable →
# behind-check warns and continues).
RELEASE_SH="$(cd "$(dirname "$0")/.." && pwd)/scripts/release.sh"
F3_TMP="$(mktemp -d /tmp/release-preflight-f3.XXXXXX)"
(
  cd "$F3_TMP"
  git init -q
  git config user.email t@t; git config user.name t
  # A package.json the release.sh integrity check + version read both accept.
  cat > package.json <<'PKG'
{ "name": "t", "version": "0.5.0",
  "scripts": { "a":"a","b":"b","c":"c","d":"d","e":"e","release":"bash scripts/release.sh" },
  "devDependencies": {}, "build": {} }
PKG
  mkdir -p scripts
  # release.sh sources scripts/release-preflight.sh via the repo toplevel — copy both.
  cp "$RELEASE_SH" scripts/release.sh
  cp "$(dirname "$RELEASE_SH")/release-preflight.sh" scripts/release-preflight.sh
  git add -A; git commit -qm init
  # origin that cannot be fetched → the preflight's fetch fails.
  git remote add origin "$F3_TMP/nonexistent-remote.git"
) >/dev/null 2>&1
f3_out="$(cd "$F3_TMP" && bash scripts/release.sh patch 2>&1)"; f3_rc=$?
if [ "$f3_rc" = 0 ]; then
  fail "F3 fetch-fail FAIL-CLOSED" "release.sh proceeded (rc 0) on a fetch failure — fails OPEN"
else
  case "$f3_out" in
    *"fail closed"*) pass "F3 fetch-fail FAIL-CLOSED" "rc=$f3_rc refused with 'fail closed'" ;;
    *) fail "F3 fetch-fail FAIL-CLOSED" "rc=$f3_rc but no 'fail closed' marker; out tail=[$(printf '%s' "$f3_out" | tail -3 | tr '\n' '|')]" ;;
  esac
fi

# ---- Arm F1-call-site (review): release.sh INVOKES the discriminator with HEAD -
# The library arms above prove rp_two_way_discriminator discriminates on whatever
# ref it is HANDED — but nothing there asserts release.sh's CALL SITE hands it
# HEAD rather than origin/master (the original F1 defect). Mutating the call site
# HEAD->origin/master leaves those arms green. So drive the REAL release.sh
# --dry-run in a temp repo whose state makes the two refs DIVERGE:
#   tag v0.5.270 == origin/master == commit T   (the --to-master pre-advance state)
#   HEAD         == T + 2 commits                (the unreleased work being tagged)
# As-shipped (call site = HEAD): tag..HEAD = 2 > 0 -> PROCEEDS ('ahead by 2').
# Mutant  (call site = origin/master): tag..origin/master = 0 -> REFUSES.
# RP_LS_REMOTE_TAGS is stubbed so rp_newest_origin_tag resolves v0.5.270 without a
# network; RP_GH_RELEASE_TAGS stubbed so next-version-free passes; RP_LOG_COUNT_CMD
# is UNSET so the discriminator computes the REAL git ranges — the whole point is
# which ref the call site feeds those real ranges.
CS_TMP="$(mktemp -d /tmp/release-preflight-cs.XXXXXX)"
ORIGIN_BARE="$CS_TMP/origin.git"
WORK="$CS_TMP/work"
(
  git init -q --bare "$ORIGIN_BARE"
  git init -q "$WORK"; cd "$WORK"
  git config user.email t@t; git config user.name t
  cat > package.json <<'PKG'
{ "name": "t", "version": "0.5.270",
  "scripts": { "a":"a","b":"b","c":"c","d":"d","e":"e","release":"bash scripts/release.sh" },
  "devDependencies": {}, "build": {} }
PKG
  mkdir -p scripts
  cp "$RELEASE_SH" scripts/release.sh
  cp "$(dirname "$RELEASE_SH")/release-preflight.sh" scripts/release-preflight.sh
  git add -A; git commit -qm "T: base"      # commit T
  git branch -M master
  git tag v0.5.270                            # tag == T
  git remote add origin "$ORIGIN_BARE"
  git push -q origin master --tags            # origin/master == T, tag on origin
  # HEAD moves 2 commits ahead of T (the work being released); master stays at T.
  echo a >> package.json.note && git add -A && git commit -qm "work 1"
  echo b >> package.json.note && git add -A && git commit -qm "work 2"
) >/dev/null 2>&1

# Env that makes the newest-tag + gh reads hermetic while the ranges stay REAL.
CS_ENV="export RP_LS_REMOTE_TAGS='printf \"x\trefs/tags/v0.5.270\n\"'; export RP_GH_RELEASE_TAGS='printf \"v0.5.270\n\"'"

# As-shipped: must PROCEED with 'ahead by 2'.
cs_out="$(cd "$WORK" && bash -c "$CS_ENV; bash scripts/release.sh 0.5.271 --dry-run" 2>&1)"; cs_rc=$?
case "$cs_rc:$cs_out" in
  0:*"ahead by 2 commits"*) pass "F1-callsite ships-HEAD" "real release.sh --dry-run proceeded 'ahead by 2' (call site passes HEAD)" ;;
  *) fail "F1-callsite ships-HEAD" "rc=$cs_rc out tail=[$(printf '%s' "$cs_out" | grep -i 'release-preflight\|refuse\|ahead' | tr '\n' '|')]" ;;
esac

# must-FAIL control: mutate the call site HEAD->origin/master in the temp copy and
# re-drive. It must now REFUSE (rc!=0, 'refuse to cut a duplicate') — proving the
# ships-HEAD arm actually depends on the call site's ref, not just the library.
sed -i 's#rp_two_way_discriminator "\$RP_NEWEST_TAG" "HEAD"#rp_two_way_discriminator "$RP_NEWEST_TAG" "origin/master"#' "$WORK/scripts/release.sh"
# Commit the mutation: release.sh's own dirty-tree preflight would otherwise abort
# BEFORE the #78 block, masking the call-site defect behind a dirty-tree error.
( cd "$WORK" && git add -A && git commit -qm "mutate call site" ) >/dev/null 2>&1
if ! grep -q 'rp_two_way_discriminator "\$RP_NEWEST_TAG" "origin/master"' "$WORK/scripts/release.sh"; then
  fail "F1-callsite mutation-applied" "sed did not flip the call site — mutation string absent"
else
  cs_mout="$(cd "$WORK" && bash -c "$CS_ENV; bash scripts/release.sh 0.5.271 --dry-run" 2>&1)"; cs_mrc=$?
  case "$cs_mrc:$cs_mout" in
    0:*) fail "F1-callsite mutant-REFUSES" "mutant STILL proceeded (rc 0) — ships-HEAD arm is blind to the call site ref" ;;
    *"refuse to cut a duplicate"*) pass "F1-callsite mutant-REFUSES" "call site->origin/master REFUSED (rc=$cs_mrc) → ships-HEAD arm detects it (RED)" ;;
    *) fail "F1-callsite mutant-REFUSES" "rc=$cs_mrc but no refuse marker; tail=[$(printf '%s' "$cs_mout" | grep -i 'release-preflight\|refuse\|ahead' | tr '\n' '|')]" ;;
  esac
fi

# ---- MUTATION check (C3): invert the refuse condition, arm A must go GREEN --
# Copy the lib, flip `-eq 0` to `-ne 0` in the discriminator, re-run arm A. A
# correctly-detecting test now sees the tag==master case PROCEED (rc=0) instead
# of refuse — i.e. the arm's rc-3 assertion would FAIL on the mutant. We assert
# the mutant is DETECTED: under the mutation, arm A's condition no longer fires.
MUT="$(mktemp /tmp/release-preflight-mut.XXXXXX.sh)"
trap 'rm -f "$MUT"; rm -rf "$F3_TMP" "$CS_TMP"' EXIT
sed 's/if \[ "\$ahead" -eq 0 \]; then/if [ "$ahead" -ne 0 ]; then/' "$LIB" > "$MUT"
if ! grep -q 'if \[ "\$ahead" -ne 0 \]; then' "$MUT"; then
  fail "MUT mutation-applied" "sed did not flip the condition — mutation string not present in $MUT"
else
  mout="$(bash -c "
    set -uo pipefail
    export RP_LOG_COUNT_CMD='echo 0'
    . '$MUT'
    rp_two_way_discriminator v0.5.270 HEAD
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
