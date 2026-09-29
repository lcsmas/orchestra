#!/usr/bin/env bash
#
# verify-release-gate.sh — rig for the #207 release gate (typecheck + full suite
# must pass on the exact tree being released, or release.sh refuses BEFORE tagging).
#
# Drives the REAL release.sh in a SANDBOX (local bare origin, fake `gh`, real tsc + `node --test`,
# stub build scripts): nothing real is tagged, pushed or published. Observable = rc, refusal text,
# sandbox tags/commits and the ordered step log.
#
# Arms: clean (steps EXACTLY `tsc test abi build gh-release`); tsc_error, test_fail, test_skipped,
# test_todo, test_rc_only, test_zero, test_swallow_fail/hang, test_no_summary, test_no_skipped_line,
# tree_dirtied, tree_moved, abi_fail -> REFUSED naming the check + nothing tagged/pushed; bypass
# (+notes-file, =form) -> proceeds with the reason in the notes; bypass_no_reason/blank/flag/ci_only
# -> rc 2; dry_run -> plan only. Must-FAIL on old code: RG_SCRIPTS_DIR=<dir with the old release.sh>.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SUT="${RG_SCRIPTS_DIR:-$REPO/scripts}"
BASE="${RG_RIG_BASE:-$HOME/.orchestra/tmp}"
mkdir -p "$BASE"
SB="$(mktemp -d "$BASE/release-gate-rig.XXXXXX")"
trap 'rm -rf "$SB"' EXIT
REAL_TSC="$REPO/node_modules/.bin/tsc"
[ -x "$REAL_TSC" ] || { echo "rig fault: $REAL_TSC missing — pnpm install first" >&2; exit 2; }

# Hermetic git: no user config/hooks/signing; identity from env.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=rig GIT_AUTHOR_EMAIL=rig@example.invalid
export GIT_COMMITTER_NAME=rig GIT_COMMITTER_EMAIL=rig@example.invalid

# Fake gh: auth ok, no releases, `release create` logs itself + captures the notes.
mkdir -p "$SB/bin"
cat > "$SB/bin/gh" <<'GH'
#!/bin/sh
case "$1 $2" in
  "auth status"|"release list") exit 0 ;;
  "release create")
    echo gh-release >> "$RG_FX_LOG"
    : > "$RG_FX_LOG.notes"
    prev=""
    for a in "$@"; do
      case "$prev" in
        --notes-file|-F) cat "$a" >> "$RG_FX_LOG.notes" ;;
        --notes|-n) printf '%s\n' "$a" >> "$RG_FX_LOG.notes" ;;
      esac
      prev="$a"
    done
    exit 0 ;;
esac
echo "rig gh stub: unexpected: $*" >&2; exit 9
GH
chmod +x "$SB/bin/gh"

FAILED=0
pass() { printf '  ok   %-34s %s\n' "$1" "$2"; }
fail() { printf '  FAIL %-34s %s\n' "$1" "$2"; FAILED=1; }

# mk_fixture <name> <ts:ok|err> <test:pass|fail|skip|todo|nosummary|dirty|moved|rcfail|zero|abifail|swallowfail|swallowhang|noskipped|nofail|nopass|notests|mismatch|untrackedbytest|untracked|touch|touchbytest>
# Sets D W ORIGIN LOG. The fixture repo is at v0.5.270 with 1 commit of work ahead.
mk_fixture() {
  local name="$1" ts="$2" tv="$3"
  D="$SB/$name"; W="$D/work"; ORIGIN="$D/origin.git"; LOG="$D/log"
  mkdir -p "$W/scripts" "$W/src" "$W/test" "$W/node_modules/.bin"
  : > "$LOG"
  git init -q --bare "$ORIGIN"
  git init -q -b master "$W"
  for f in release.sh release-preflight.sh release-gate.sh; do
    [ -f "$SUT/$f" ] && cp "$SUT/$f" "$W/scripts/$f"
  done
  # tsc wrapper: log each invocation, then run the REAL compiler.
  printf '#!/bin/sh\necho tsc >> "$RG_FX_LOG"\nexec "%s" "$@"\n' "$REAL_TSC" > "$W/node_modules/.bin/tsc"
  chmod +x "$W/node_modules/.bin/tsc"
  local testcmd="node --test 'test/*.test.mjs'"
  [ "$tv" = nofail ] && testcmd="printf '# tests 3\\\\n# pass 3\\\\n# skipped 0\\\\n'"
  [ "$tv" = nopass ] && testcmd="printf '# tests 3\\\\n# fail 0\\\\n# skipped 0\\\\n'"
  [ "$tv" = notests ] && testcmd="printf '# pass 3\\\\n# fail 0\\\\n# skipped 0\\\\n'"
  [ "$tv" = mismatch ] && testcmd="printf '# tests 3\\\\n# pass 2\\\\n# fail 0\\\\n# cancelled 0\\\\n# skipped 0\\\\n# todo 0\\\\n'"
  [ "$tv" = nosummary ] && testcmd="echo all good"
  [ "$tv" = rcfail ] && testcmd="node --test 'test/*.test.mjs'; exit 3"
  [ "$tv" = swallowfail ] && testcmd="node --test 'test/*.test.mjs' || true"
  [ "$tv" = swallowhang ] && testcmd="node --test 'test/*.test.mjs' || true"
  [ "$tv" = noskipped ] && testcmd="printf '# tests 3\\\\n# pass 3\\\\n# fail 0\\\\n'"
  [ "$tv" = zero ] && testcmd="node --test 'test/none-*.test.mjs'"   # glob matches nothing: rc 0, '# tests 0'
  local abicmd='echo abi >> \"$RG_FX_LOG\"'
  [ "$tv" = abifail ] && abicmd='exit 7'
  cat > "$W/package.json" <<PKG
{ "name": "fx", "version": "0.5.270",
  "scripts": { "a":"a","b":"b","c":"c",
    "test": "$testcmd",
    "build:bus-abi": "$abicmd",
    "build": "echo build >> \"\$RG_FX_LOG\" && mkdir -p release && : > release/Orchestra.AppImage",
    "release": "bash scripts/release.sh" },
  "devDependencies": {}, "build": {} }
PKG
  printf 'node_modules/\nrelease/\n' > "$W/.gitignore"
  echo '{"compilerOptions":{"strict":true,"noEmit":true,"target":"es2022","module":"esnext","moduleResolution":"bundler","types":[]},"include":["src/**/*.ts"]}' > "$W/tsconfig.json"
  if [ "$ts" = err ]; then echo 'export const x: number = "not a number";' > "$W/src/a.ts"
  else echo 'export const x: number = 1;' > "$W/src/a.ts"; fi
  echo base > "$W/tracked.txt"
  {
    echo "import test from 'node:test'; import assert from 'node:assert'; import fs from 'node:fs';"
    echo "fs.appendFileSync(process.env.RG_FX_LOG, 'test\\n');"
    echo "test('ok', () => {});"
    case "$tv" in
      fail) echo "test('boom', () => assert.equal(1, 2));" ;;
      skip) echo "test.skip('later', () => {});" ;;
      todo) echo "test('later', { todo: true }, () => {});" ;;
      dirty) echo "fs.appendFileSync('tracked.txt', 'mutated by a test\\n');" ;;
      swallowfail) echo "test('boom', () => assert.equal(1, 2));" ;;
      swallowhang) echo "test('hang', () => new Promise(() => {}));" ;;
      touchbytest) echo "fs.utimesSync('tracked.txt', new Date(), new Date(Date.now() + 5000));" ;;
      untrackedbytest) echo "fs.writeFileSync('src/generated.ts', 'export const g = 1;\\n');" ;;
      moved) echo "import cp from 'node:child_process'; cp.execSync('git commit --allow-empty -qm moved');" ;;
    esac
  } > "$W/test/x.test.mjs"
  ( cd "$W" && git add -A && git commit -qm base && git tag v0.5.270 \
      && git remote add origin "$ORIGIN" && git push -q origin master --tags \
      && { [ -z "${FX_BRANCH:-}" ] || git checkout -q -b "$FX_BRANCH"; } \
      && echo work >> tracked.txt && git add -A && git commit -qm "work" ) >/dev/null 2>&1
  [ "$tv" = untracked ] && echo 'export const u = 1;' > "$W/src/untracked.ts"
  [ "$tv" = touch ] && { sleep 1; touch "$W/tracked.txt"; }   # mtime-only change
  # tracked.txt is committed once more above; the `dirty` test then mutates it again.
  # (the work commit means HEAD is ahead of tag v0.5.270, so the #78 preflight proceeds)
  HEAD0="$(git -C "$W" rev-parse HEAD)"
  ORIGIN0="$(git -C "$ORIGIN" rev-parse master)"
}

# run_release <args...> -> OUT (stdout+stderr), RC
run_release() {
  OUT="$(cd "$W" && PATH="$SB/bin:$PATH" RG_FX_LOG="$LOG" bash scripts/release.sh "$@" 2>&1)"; RC=$?
}
steps() { tr '\n' ' ' < "$LOG" | sed 's/ $//'; }
nothing_shipped() { # name — no bump commit, no local/origin tag, origin master unmoved
  local n="$1" bad=""
  [ "$(git -C "$W" rev-parse HEAD)" = "$HEAD0" ] || bad="$bad HEAD-moved"
  [ -z "$(git -C "$W" tag -l v0.5.271)" ] || bad="$bad local-tag"
  [ -z "$(git -C "$ORIGIN" tag -l v0.5.271)" ] || bad="$bad origin-tag"
  [ "$(git -C "$ORIGIN" rev-parse master)" = "$ORIGIN0" ] || bad="$bad origin-master-moved"
  grep -q gh-release "$LOG" && bad="$bad gh-release"
  if [ -z "$bad" ]; then pass "$n nothing-shipped" "no bump commit, no tag, origin unmoved"
  else fail "$n nothing-shipped" "SHIPPED:$bad"; fi
}
refused() { # name check-name [extra-marker] [expected-steps]
  local n="$1" chk="$2" extra="${3:-}" want="${4:-}"
  if [ "$RC" = 0 ]; then fail "$n refused" "rc=0 — release PROCEEDED (steps: $(steps))"; return; fi
  case "$OUT" in
    *"release-gate: REFUSED"*"check '$chk'"*)
      if [ -n "$extra" ] && [[ "$OUT" != *"$extra"* ]]; then
        fail "$n refused" "rc=$RC names '$chk' but marker '$extra' missing: $(printf '%s' "$OUT" | grep -F 'REFUSED' | head -1)"; return; fi
      pass "$n refused" "rc=$RC naming '$chk'${extra:+ ($extra)}" ;;
    *) fail "$n refused" "rc=$RC but no REFUSED/check '$chk' marker; tail=[$(printf '%s' "$OUT" | tail -3 | tr '\n' '|')]"; return ;;
  esac
  if [ -n "$want" ]; then
    [ "$want" = "-" ] && want=""
    [ "$(steps)" = "$want" ] && pass "$n steps" "[$(steps)]" || fail "$n steps" "got [$(steps)] want [$want]"
  fi
}

# ── clean ────────────────────────────────────────────────────────────────────
mk_fixture clean ok pass; run_release 0.5.271
if [ "$RC" = 0 ] && [ "$(steps)" = "tsc test abi build gh-release" ]; then
  pass "clean proceeds, ordered, once" "rc=0 steps=[$(steps)]"
else fail "clean proceeds, ordered, once" "rc=$RC steps=[$(steps)] want [tsc test abi build gh-release]; tail=[$(printf '%s' "$OUT" | tail -3 | tr '\n' '|')]"; fi
[ "$(git -C "$W" log -1 --format=%s)" = "chore: bump version to 0.5.271" ] && pass "clean bump message unchanged" "chore: bump version to 0.5.271" || fail "clean bump message unchanged" "$(git -C "$W" log -1 --format=%s)"
[ -n "$(git -C "$ORIGIN" tag -l v0.5.271)" ] && pass "clean tag-pushed" "v0.5.271 on the sandbox origin" || fail "clean tag-pushed" "no v0.5.271 on origin"
case "$OUT" in *"release-gate: PASS"*) pass "clean pass-line" "$(printf '%s' "$OUT" | grep -F 'release-gate: PASS' | head -1)" ;; *) fail "clean pass-line" "no 'release-gate: PASS' line" ;; esac
if grep -qi 'bypass' "$LOG.notes" 2>/dev/null; then fail "clean notes-untouched" "bypass text in a clean release's notes"; else pass "clean notes-untouched" "no gate text in notes (as today)"; fi

# ── refusals ─────────────────────────────────────────────────────────────────
mk_fixture tsc_error err pass; run_release 0.5.271
refused tsc_error tsc "" "tsc"; nothing_shipped tsc_error

mk_fixture test_fail ok fail; run_release 0.5.271
refused test_fail test "fail" "tsc test"; nothing_shipped test_fail

mk_fixture test_skipped ok skip; run_release 0.5.271
refused test_skipped test "a partial green is not a pass" "tsc test"; nothing_shipped test_skipped

mk_fixture test_todo ok todo; run_release 0.5.271
refused test_todo test "a partial green is not a pass" "tsc test"; nothing_shipped test_todo

mk_fixture test_swallow_fail ok swallowfail; run_release 0.5.271
refused test_swallow_fail test "Failing:" "tsc test"; nothing_shipped test_swallow_fail

mk_fixture test_swallow_hang ok swallowhang; run_release 0.5.271
refused test_swallow_hang test "Failing:" "tsc test"; nothing_shipped test_swallow_hang

mk_fixture test_no_skipped_line ok noskipped; run_release 0.5.271
refused test_no_skipped_line test "summary" "tsc"; nothing_shipped test_no_skipped_line

mk_fixture test_no_summary ok nosummary; run_release 0.5.271
refused test_no_summary test "summary" "tsc"; nothing_shipped test_no_summary

mk_fixture test_rc_only ok rcfail; run_release 0.5.271
refused test_rc_only test "rc=3" "tsc test"; nothing_shipped test_rc_only

mk_fixture test_zero ok zero; run_release 0.5.271
refused test_zero test "0 tests ran" "tsc"; nothing_shipped test_zero

mk_fixture tree_dirtied ok dirty; run_release 0.5.271
refused tree_dirtied tree "" "tsc test"
[ "$(git -C "$W" rev-parse HEAD)" = "$HEAD0" ] && [ -z "$(git -C "$ORIGIN" tag -l v0.5.271)" ] \
  && pass "tree_dirtied nothing-shipped" "no bump, no tag" || fail "tree_dirtied nothing-shipped" "shipped"

mk_fixture tree_moved ok moved; run_release 0.5.271
refused tree_moved tree "" "tsc test"
[ -z "$(git -C "$ORIGIN" tag -l v0.5.271)" ] && [ "$(git -C "$ORIGIN" rev-parse master)" = "$ORIGIN0" ] \
  && pass "tree_moved nothing-pushed" "no tag, origin unmoved" || fail "tree_moved nothing-pushed" "pushed"

mk_fixture abi_fail ok abifail; run_release 0.5.271
refused abi_fail "build:bus-abi" "" "tsc test"; nothing_shipped abi_fail

mk_fixture test_no_fail_line ok nofail; run_release 0.5.271
refused test_no_fail_line test "readable summary" "tsc"; nothing_shipped test_no_fail_line
mk_fixture test_no_pass_line ok nopass; run_release 0.5.271
refused test_no_pass_line test "readable summary" "tsc"; nothing_shipped test_no_pass_line
mk_fixture test_no_tests_line ok notests; run_release 0.5.271
refused test_no_tests_line test "readable summary" "tsc"; nothing_shipped test_no_tests_line
mk_fixture test_mismatch ok mismatch; run_release 0.5.271
refused test_mismatch test "!= pass" "tsc"; nothing_shipped test_mismatch

mk_fixture untracked ok untracked; run_release 0.5.271
refused untracked tree "untracked" "-"; nothing_shipped untracked
mk_fixture untracked_by_test ok untrackedbytest; run_release 0.5.271
refused untracked_by_test tree "untracked" "tsc test"; nothing_shipped untracked_by_test

mk_fixture mtime_touch ok touch; run_release 0.5.271
if [ "$RC" = 0 ] && [ "$(steps)" = "tsc test abi build gh-release" ]; then pass "mtime-only touch is not dirty" "rc=0, released"
else fail "mtime-only touch is not dirty" "rc=$RC steps=[$(steps)] tail=[$(printf '%s' "$OUT" | tail -3 | tr '\n' '|')]"; fi

mk_fixture mtime_by_test ok touchbytest; run_release 0.5.271
if [ "$RC" = 0 ] && [ "$(steps)" = "tsc test abi build gh-release" ]; then pass "mtime-only touch by a test is not dirty" "rc=0, released"
else fail "mtime-only touch by a test is not dirty" "rc=$RC steps=[$(steps)] tail=[$(printf '%s' "$OUT" | tail -3 | tr '\n' '|')]"; fi

# ── --ci-only / --to-master ordering (the gate is neither skipped nor late) ───
mk_fixture ci_only_refused err pass; run_release 0.5.271 --ci-only
refused ci_only_refused tsc "" "tsc"; nothing_shipped ci_only_refused
mk_fixture ci_only_clean ok pass; run_release 0.5.271 --ci-only
if [ "$RC" = 0 ] && [ "$(steps)" = "tsc test" ] && [ -n "$(git -C "$ORIGIN" tag -l v0.5.271)" ]; then
  pass "ci_only clean: gate runs, no local build" "rc=0 steps=[$(steps)] tag pushed"
else fail "ci_only clean: gate runs, no local build" "rc=$RC steps=[$(steps)]"; fi

FX_BRANCH=feat mk_fixture to_master_refused err pass; run_release 0.5.271 --to-master
refused to_master_refused tsc "" "tsc"; nothing_shipped to_master_refused
FX_BRANCH=feat mk_fixture to_master_clean ok pass; run_release 0.5.271 --to-master
if [ "$RC" = 0 ] && [ "$(steps)" = "tsc test abi build gh-release" ] \
   && [ "$(git -C "$ORIGIN" rev-parse master)" = "$(git -C "$W" rev-parse HEAD)" ]; then
  pass "to_master clean: master fast-forwarded" "rc=0 origin/master == bump commit"
else fail "to_master clean: master fast-forwarded" "rc=$RC steps=[$(steps)] tail=[$(printf '%s' "$OUT" | tail -3 | tr '\n' '|')]"; fi

# ── escape hatch ─────────────────────────────────────────────────────────────
mk_fixture bypass err fail; run_release 0.5.271 --skip-release-gate "rig: emergency hotfix"
if [ "$RC" = 0 ] && [ "$(steps)" = "abi build gh-release" ] && [ -n "$(git -C "$ORIGIN" tag -l v0.5.271)" ]; then
  pass "bypass proceeds, no check ran" "rc=0 steps=[$(steps)] tag pushed"
else fail "bypass proceeds, no check ran" "rc=$RC steps=[$(steps)]; tail=[$(printf '%s' "$OUT" | tail -3 | tr '\n' '|')]"; fi
if grep -qF 'rig: emergency hotfix' "$LOG.notes" 2>/dev/null && grep -qi 'release gate bypassed' "$LOG.notes" 2>/dev/null; then
  pass "bypass recorded in release notes" "notes carry the banner + reason"
else fail "bypass recorded in release notes" "notes=[$(tr '\n' '|' < "$LOG.notes" 2>/dev/null)]"; fi
case "$OUT" in *"release-gate: BYPASSED"*) pass "bypass loud" "stderr banner present" ;; *) fail "bypass loud" "no 'release-gate: BYPASSED' banner" ;; esac
if [[ "$(git -C "$W" log -1 --format=%s)" == *"bump version to 0.5.271"*"release gate bypassed: rig: emergency hotfix"* ]] \
   && [[ "$(git -C "$W" tag -l --format='%(contents)' v0.5.271)" == *"release gate bypassed: rig: emergency hotfix"* ]]; then
  pass "bypass stamped in bump commit + tag" "$(git -C "$W" log -1 --format=%s)"
else fail "bypass stamped in bump commit + tag" "commit=[$(git -C "$W" log -1 --format=%s)] tag=[$(git -C "$W" tag -l --format='%(contents)' v0.5.271 | head -1)]"; fi

mk_fixture bypass_eq err pass; run_release 0.5.271 "--skip-release-gate=rig: equals form"
if [ "$RC" = 0 ] && [ "$(steps)" = "abi build gh-release" ] && grep -qF 'rig: equals form' "$LOG.notes" 2>/dev/null; then
  pass "bypass (=reason form)" "rc=0, reason in notes"
else fail "bypass (=reason form)" "rc=$RC steps=[$(steps)] notes=[$(tr '\n' '|' < "$LOG.notes" 2>/dev/null)]"; fi

mk_fixture bypass_notes_file err pass; printf 'Hand-written notes.\n' > "$D/notes.md"
run_release 0.5.271 --skip-release-gate "rig: notes-file variant" --notes-file "$D/notes.md"
if [ "$RC" = 0 ] && grep -qF 'Hand-written notes.' "$LOG.notes" && grep -qF 'rig: notes-file variant' "$LOG.notes" \
   && [ "$(cat "$D/notes.md")" = 'Hand-written notes.' ]; then
  pass "bypass + --notes-file" "user notes kept, record appended, user's file untouched"
else fail "bypass + --notes-file" "rc=$RC notes=[$(tr '\n' '|' < "$LOG.notes" 2>/dev/null)]"; fi

usage_err() { # name marker
  if [ "$RC" = 2 ] && [ -z "$(steps)" ] && [[ "$OUT" == *"$2"* ]]; then pass "$1 usage-error" "rc=2, nothing ran, '$2'"
  else fail "$1 usage-error" "rc=$RC steps=[$(steps)] tail=[$(printf '%s' "$OUT" | tail -2 | tr '\n' '|')]"; fi
}
mk_fixture bypass_no_reason err pass; run_release 0.5.271 --skip-release-gate
usage_err bypass_no_reason "a non-empty reason is required"; nothing_shipped bypass_no_reason
mk_fixture bypass_flag_as_reason err pass; run_release 0.5.271 --skip-release-gate --dry-run
usage_err bypass_flag_as_reason "a non-empty reason is required"
mk_fixture bypass_bump_word err pass; run_release 0.5.271 --skip-release-gate minor
usage_err bypass_bump_word "not a reason"
mk_fixture bypass_version_word err pass; run_release 0.5.271 --skip-release-gate 1.2.3
usage_err bypass_version_word "not a reason"
mk_fixture bypass_blank err pass; run_release 0.5.271 --skip-release-gate "   "
usage_err bypass_blank_reason "a non-empty reason is required"
mk_fixture bypass_ci_only err pass; run_release 0.5.271 --ci-only --skip-release-gate "x"
usage_err bypass_ci_only "can't be combined with --ci-only"

# ── dry-run ──────────────────────────────────────────────────────────────────
mk_fixture dry_run err fail; run_release 0.5.271 --dry-run
if [ "$RC" = 0 ] && [ -z "$(steps)" ] && [[ "$OUT" == *"[dry-run] release gate"* ]]; then
  pass "dry_run prints plan, runs nothing" "rc=0, no check executed"
else fail "dry_run prints plan, runs nothing" "rc=$RC steps=[$(steps)]"; fi
nothing_shipped dry_run

echo
if [ "$FAILED" -ne 0 ]; then echo "#207 release-gate rig: FAILED"; exit 1; fi
echo "#207 release-gate rig: PASS — all arms green"
