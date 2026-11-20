#!/usr/bin/env bash
#
# verify-release-receipt.sh — rig for the #484 release-gate PASS receipt (release.sh skips the gate when
# scripts/release-gate.sh already PASSED on the same tree, package.json's version line masked).
#
# Scratch repo + local bare origin + fake `gh` + FAKE gate commands (stub tsc/test/session-budget/admission scripts that only log
# a step name): the real suite never runs, nothing real is tagged, pushed or published. Observable = rc, the ordered step log, the receipt dir.
# Must-PASS: hit_same_tree, hit_after_bump (+ explicit tree-equality proof), dry_run_skip_plan. Must-FAIL (the gate RUNS, steps = full list):
# miss_no_receipt, miss_tracked_change, miss_untracked_change, miss_other_gate_version, miss_other_tree (a receipt filed under another tree's name),
# miss_bump_plus_script / _plus_file / _reformat (a bump that changes more than the version field), miss_failed_gate_writes_none; bypass unchanged.
# `--mutants`: re-runs this rig against clause-mutated copies of the scripts and requires every mutant to turn it RED.
# Env: RG_SCRIPTS_DIR=<dir with release.sh, release-preflight.sh, release-gate.sh> (default: this repo's scripts/).
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SELF="$REPO/scripts/verify-release-receipt.sh"
BASE="${RG_RIG_BASE:-${TMPDIR:-/tmp}}"
mkdir -p "$BASE"

if [ "${1:-}" = "--mutants" ]; then
  M="$(mktemp -d "$BASE/release-receipt-mutants.XXXXXX")"; trap 'rm -rf "$M"' EXIT
  mutate() { # name file sed-expr   (the mutant must differ from the original, byte-checked)
    local n="$1" f="$2" e="$3"; mkdir -p "$M/$n"; cp "$REPO"/scripts/release{,-preflight,-gate}.sh "$M/$n/"
    sed -i -E "$e" "$M/$n/$f"; if cmp -s "$REPO/scripts/$f" "$M/$n/$f"; then echo "rig fault: mutant $n is a no-op"; exit 2; fi
  }
  mutate no_dirt_check    release-gate.sh 's|^  dirt="\$\(_rg_tree_dirt\)"; \[ -z "\$dirt" \] \|\| \{ echo "no receipt honoured.*$|  dirt=""|'
  mutate no_version_check release-gate.sh 's|^  \[ "\$rv" = "\$RG_GATE_VERSION" \] \|\| \{.*$|  true|'
  mutate raw_tree_only    release-gate.sh 's|^  raw="\$\(git rev-parse --verify -q "\$rev\^\{tree\}"\)" \|\| return 1$|  git rev-parse --verify -q "$rev^{tree}"; return 0|'
  mutate mask_whole_pkg   release-gate.sh 's|if \[ -n "\$mode" \] && git cat-file blob "\$raw:package.json" \| node -e .$|if [ -n "$mode" ] \&\& echo "{}" \| node -e '"'"'|;s|^      const raw = require\("node:fs"\).readFileSync\(0, "utf8"\);|      const raw = "{\\"version\\":\\"1\\"}";|'
  mutate no_norm_eq_check release-gate.sh 's|^  \[ "\$rnorm" = "\$norm" \] && \[ -n "\$rraw" \] \|\| \{.*$|  true|'
  mutate receipt_on_fail  release.sh 's|^    rg_run_gate \|\| exit 1$|    rg_run_gate \|\| true|'
  mutate always_skip      release.sh 's|if _rg_why="\$\(rg_receipt_check\)"; then$|if _rg_why="x"; then|'
  mutate bypass_ignored   release.sh 's|^elif \[ "\$SKIP_GATE" = 1 \]; then$|elif false; then|'
  bad=0
  for n in $(ls "$M"); do
    if RG_SCRIPTS_DIR="$M/$n" bash "$SELF" >"$M/$n.log" 2>&1; then echo "MUTANT SURVIVED  $n (rig stayed green)"; bad=1
    else echo "mutant killed    $n ($(grep -c '^  FAIL' "$M/$n.log") FAIL lines)"; fi
  done
  [ "$bad" = 0 ] && echo "#484 receipt mutants: ALL KILLED" || { echo "#484 receipt mutants: SURVIVOR"; exit 1; }
  exit 0
fi

SUT="${RG_SCRIPTS_DIR:-$REPO/scripts}"
SB="$(mktemp -d "$BASE/release-receipt-rig.XXXXXX")"
trap 'rm -rf "$SB"' EXIT
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
export GIT_AUTHOR_NAME=rig GIT_AUTHOR_EMAIL=rig@example.invalid GIT_COMMITTER_NAME=rig GIT_COMMITTER_EMAIL=rig@example.invalid

mkdir -p "$SB/bin"
cat > "$SB/bin/gh" <<'GH'
#!/bin/sh
case "$1 $2" in
  "auth status"|"release list") exit 0 ;;
  "release create") echo gh-release >> "$RG_FX_LOG"; : > "$RG_FX_LOG.notes"
    prev=""; for a in "$@"; do case "$prev" in --notes-file|-F) cat "$a" >> "$RG_FX_LOG.notes" ;; esac; prev="$a"; done; exit 0 ;;
esac
echo "rig gh stub: unexpected: $*" >&2; exit 9
GH
chmod +x "$SB/bin/gh"

FAILED=0
pass() { printf '  ok   %-40s %s\n' "$1" "$2"; }
fail() { printf '  FAIL %-40s %s\n' "$1" "$2"; FAILED=1; }
FULL="tsc test session-budget admission-hold admission-wake"
SHIP="abi build gh-release"

# mk_fixture <name> [failtest]  -> D W ORIGIN LOG. v0.5.270 tagged + pushed, one `work` commit ahead; gate commands are FAKE (stub.sh logs a step name).
mk_fixture() {
  D="$SB/$1"; W="$D/work"; ORIGIN="$D/origin.git"; LOG="$D/log"
  mkdir -p "$W/scripts" "$W/node_modules/.bin"; : > "$LOG"
  git init -q --bare "$ORIGIN"; git init -q -b master "$W"
  for f in release.sh release-preflight.sh release-gate.sh; do cp "$SUT/$f" "$W/scripts/$f"; done
  printf '#!/bin/sh\necho tsc >> "$RG_FX_LOG"\n' > "$W/node_modules/.bin/tsc"; chmod +x "$W/node_modules/.bin/tsc"
  cat > "$W/scripts/stub.sh" <<'STUB'
echo "$1" >> "$RG_FX_LOG"
case "$1" in
  test) if [ -n "${RG_FX_FAIL_TEST:-}" ]; then printf '# tests 3\n# pass 2\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n'; exit 1; fi
        printf '# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n' ;;
  session-budget) echo '   requests before first reply: model=1 count_tokens=0 other=0'; echo 'SESSION-BUDGET: PASS' ;;
  admission-hold) echo "ADMISSION RIG: ALL PASS (17/17) tree $(pwd -P)" ;;
  admission-wake) echo "ADMISSION-WAKE RIG: ALL PASS (15/15) tree $(pwd -P)" ;;
  build) mkdir -p release && : > release/Orchestra.AppImage ;;
esac
STUB
  cat > "$W/package.json" <<'PKG'
{
  "name": "fx",
  "version": "0.5.270",
  "scripts": {
    "a": "a",
    "b": "b",
    "c": "c",
    "test": "bash scripts/stub.sh test",
    "test:session-budget": "bash scripts/stub.sh session-budget",
    "test:admission-hold": "bash scripts/stub.sh admission-hold",
    "test:admission-wake": "bash scripts/stub.sh admission-wake",
    "build:bus-abi": "bash scripts/stub.sh abi",
    "build": "bash scripts/stub.sh build",
    "release": "bash scripts/release.sh"
  },
  "devDependencies": {},
  "build": {}
}
PKG
  printf 'node_modules/\nrelease/\n' > "$W/.gitignore"; echo base > "$W/tracked.txt"
  ( cd "$W" && git add -A && git commit -qm base && git tag v0.5.270 && git remote add origin "$ORIGIN" && git push -q origin master --tags \
      && echo work >> tracked.txt && git add -A && git commit -qm work ) >/dev/null 2>&1
  HEAD0="$(git -C "$W" rev-parse HEAD)"; RDIR="$W/.git/release-gate-receipts"
}
gate() { OUT="$(cd "$W" && PATH="$SB/bin:$PATH" RG_FX_LOG="$LOG" bash scripts/release-gate.sh 2>&1)"; RC=$?; }   # the vague's final gate (standalone)
release() { OUT="$(cd "$W" && PATH="$SB/bin:$PATH" RG_FX_LOG="$LOG" bash scripts/release.sh "$@" 2>&1)"; RC=$?; }
steps() { tr '\n' ' ' < "$LOG" | sed 's/ $//'; }
commit() { git -C "$W" add -A && git -C "$W" commit -qm "$1"; }
bump() { ( cd "$W" && PATH="$SB/bin:$PATH" pnpm version "$1" --no-git-tag-version >/dev/null 2>&1 ) && commit "bump $1"; }
shipped() { [ -n "$(git -C "$ORIGIN" tag -l "$1")" ]; }
# expect <name> <want-steps> <tag> : release must have rc 0, the exact step list, the tag pushed
expect_release() {
  if [ "$RC" = 0 ] && [ "$(steps)" = "$2" ] && shipped "$3"; then pass "$1" "rc=0 steps=[$(steps)]"
  else fail "$1" "rc=$RC steps=[$(steps)] want [$2] tag=$(shipped "$3" && echo pushed || echo none); tail=[$(printf '%s' "$OUT" | tail -3 | tr '\n' '|')]"; fi
}

# ── must-PASS: hit on the same tree ─────────────────────────────────────────────
mk_fixture hit_same_tree; gate
if [ "$RC" = 0 ] && [ "$(steps)" = "$FULL" ] && [ "$(ls "$RDIR" | wc -l)" = 1 ] && [ -z "$(git -C "$W" status --porcelain -uall)" ]; then
  pass "gate_standalone writes the receipt" "steps=[$(steps)], 1 receipt under .git, working tree still clean"
else fail "gate_standalone writes the receipt" "rc=$RC steps=[$(steps)] receipts=[$(ls "$RDIR" 2>/dev/null)] status=[$(git -C "$W" status --porcelain -uall)] tail=[$(printf '%s' "$OUT" | tail -3 | tr '\n' '|')]"; fi
: > "$LOG"; release 0.5.271
expect_release "hit_same_tree: gate skipped, build+ship run" "$SHIP" v0.5.271
[[ "$OUT" == *"release-gate: SKIPPED"*"is the gated tree"* ]] && pass "hit_same_tree: says why" "SKIPPED + same-tree proof line" || fail "hit_same_tree: says why" "no SKIPPED/proof line: $(printf '%s' "$OUT" | grep -i receipt | head -2)"

# ── must-PASS: hit after a bump that changes the version field only — tree equality proved explicitly ──
mk_fixture hit_after_bump; gate; G_RAW="$(git -C "$W" rev-parse 'HEAD^{tree}')"; G_VER=0.5.270
bump 0.5.271; B_RAW="$(git -C "$W" rev-parse 'HEAD^{tree}')"
CHANGED="$(git -C "$W" diff-tree -r --name-only "$G_RAW" "$B_RAW")"
NLINES="$(git -C "$W" diff "$G_RAW" "$B_RAW" -U0 | grep -cE '^[-+][^-+]')"
MASK_G="$(cd "$W" && . scripts/release-gate.sh && rg_norm_tree "$G_RAW")"; MASK_B="$(cd "$W" && . scripts/release-gate.sh && rg_norm_tree "$B_RAW")"
if [ "$G_RAW" != "$B_RAW" ] && [ "$CHANGED" = package.json ] && [ "$NLINES" = 2 ] && [ -n "$MASK_G" ] && [ "$MASK_G" = "$MASK_B" ] && [ "$MASK_G" != "$G_RAW" ]; then
  pass "tree equality: HEAD minus bump == gated tree" "raw ${G_RAW:0:10}!=${B_RAW:0:10}; diff = package.json, 2 lines (-/+ version); masked ${MASK_G:0:10}==${MASK_B:0:10}"
else fail "tree equality: HEAD minus bump == gated tree" "raw $G_RAW vs $B_RAW changed=[$CHANGED] lines=$NLINES masked $MASK_G vs $MASK_B"; fi
: > "$LOG"; release 0.5.272
expect_release "hit_after_bump: gate skipped" "$SHIP" v0.5.272
[[ "$OUT" == *"release-gate: SKIPPED"*"except package.json version (0.5.270 -> 0.5.271)"* ]] && pass "hit_after_bump: proof line printed" "names the version change" || fail "hit_after_bump: proof line printed" "$(printf '%s' "$OUT" | grep -i receipt | head -2)"

# ── must-PASS: dry-run reports the skip and still changes nothing ─────────────────
mk_fixture dry_run_skip_plan; gate; : > "$LOG"; release 0.5.271 --dry-run
if [ "$RC" = 0 ] && [ -z "$(steps)" ] && [[ "$OUT" == *"release gate: would be SKIPPED"* ]] && [ "$(git -C "$W" rev-parse HEAD)" = "$HEAD0" ]; then pass "dry_run_skip_plan" "plan says SKIPPED, nothing ran"
else fail "dry_run_skip_plan" "rc=$RC steps=[$(steps)] tail=[$(printf '%s' "$OUT" | tail -3 | tr '\n' '|')]"; fi

# ── must-FAIL arms: the gate RUNS (full step list) and the release still ships on green ────────────────
mk_fixture miss_no_receipt; release 0.5.271
expect_release "miss_no_receipt: gate runs" "$FULL $SHIP" v0.5.271

mk_fixture miss_tracked_change; gate; echo more >> "$W/tracked.txt"; commit "post-receipt change"; : > "$LOG"; release 0.5.271
expect_release "miss_tracked_change (committed): gate runs" "$FULL $SHIP" v0.5.271
mk_fixture miss_tracked_dirty; gate; echo more >> "$W/tracked.txt"; : > "$LOG"; release 0.5.271
if [ "$RC" != 0 ] && [ -z "$(steps)" ] && ! shipped v0.5.271; then pass "miss_tracked_change (uncommitted): refused" "dirty tree refused before any step, nothing shipped"
else fail "miss_tracked_change (uncommitted): refused" "rc=$RC steps=[$(steps)]"; fi
CHK="$(cd "$W" && . scripts/release-gate.sh && rg_receipt_check)"; RCHK=$?
[ "$RCHK" = 1 ] && [[ "$CHK" == *"tracked files changed"* ]] && pass "miss_tracked_change: rg_receipt_check itself says no" "$CHK" || fail "miss_tracked_change: rg_receipt_check itself says no" "rc=$RCHK $CHK"

mk_fixture miss_untracked_change; gate; echo x > "$W/untracked.txt"; : > "$LOG"; release 0.5.271
if [ "$RC" != 0 ] && [ -z "$(steps)" ] && [[ "$OUT" == *"receipt: no receipt honoured — untracked files"* ]] && [[ "$OUT" == *"REFUSED"*"untracked"* ]] && ! shipped v0.5.271; then
  pass "miss_untracked_change: gate runs (and refuses the tree)" "receipt not honoured; REFUSED check 'tree'"
else fail "miss_untracked_change: gate runs (and refuses the tree)" "rc=$RC steps=[$(steps)] tail=[$(printf '%s' "$OUT" | tail -3 | tr '\n' '|')]"; fi

mk_fixture miss_other_gate_version; gate; sed -i 's/^gate_version=.*/gate_version=0/' "$RDIR"/*; : > "$LOG"; release 0.5.271
expect_release "miss_other_gate_version: gate runs" "$FULL $SHIP" v0.5.271
[[ "$OUT" == *"is gate v0, this gate is v"* ]] && pass "miss_other_gate_version: says why" "names both versions" || fail "miss_other_gate_version: says why" "$(printf '%s' "$OUT" | grep -i receipt | head -2)"

mk_fixture miss_other_tree; gate; R="$(ls "$RDIR")"; echo more >> "$W/tracked.txt"; commit "other tree"
OTHER="$(cd "$W" && . scripts/release-gate.sh && rg_norm_tree HEAD)"; cp "$RDIR/$R" "$RDIR/$OTHER"; : > "$LOG"; release 0.5.271   # receipt of tree A filed under tree B's name
expect_release "miss_other_tree: gate runs" "$FULL $SHIP" v0.5.271
mk_fixture miss_other_tree2; gate; echo more >> "$W/tracked.txt"; commit "other tree"; : > "$LOG"; release 0.5.271
expect_release "miss_other_tree (receipt for the parent): gate runs" "$FULL $SHIP" v0.5.271

# a bump that changes anything besides the version field
mk_fixture miss_bump_plus_script; gate; sed -i 's/"a": "a"/"a": "changed"/' "$W/package.json"; bump 0.5.271; : > "$LOG"; release 0.5.272
expect_release "miss_bump_plus_script: gate runs" "$FULL $SHIP" v0.5.272
mk_fixture miss_bump_plus_file; gate; echo y >> "$W/tracked.txt"; bump 0.5.271; : > "$LOG"; release 0.5.272
expect_release "miss_bump_plus_file: gate runs" "$FULL $SHIP" v0.5.272
mk_fixture miss_bump_reformat; gate; ( cd "$W" && node -e 'const p=require("./package.json");p.version="0.5.271";require("fs").writeFileSync("package.json",JSON.stringify(p))' ) && commit "bump + reformat"; : > "$LOG"; release 0.5.272
expect_release "miss_bump_reformat (whitespace): gate runs" "$FULL $SHIP" v0.5.272
mk_fixture miss_nested_version; gate; sed -i 's/"build": {}/"build": {"version": "2"}/' "$W/package.json"; commit "nested version key"; : > "$LOG"; release 0.5.271
expect_release "miss_nested_version (other 'version' key): gate runs" "$FULL $SHIP" v0.5.271

# a failed gate leaves no receipt
mk_fixture miss_failed_gate_writes_none; OUT="$(cd "$W" && PATH="$SB/bin:$PATH" RG_FX_LOG="$LOG" RG_FX_FAIL_TEST=1 bash scripts/release-gate.sh 2>&1)"; RC=$?
if [ "$RC" != 0 ] && [ -z "$(ls "$RDIR" 2>/dev/null)" ]; then pass "miss_failed_gate_writes_none" "rc=$RC, no receipt"; else fail "miss_failed_gate_writes_none" "rc=$RC receipts=[$(ls "$RDIR" 2>/dev/null)]"; fi
: > "$LOG"; release 0.5.271; expect_release "  …then release runs the gate" "$FULL $SHIP" v0.5.271

# --skip-release-gate semantics unchanged: with a receipt present it still bypasses loudly and records the reason
mk_fixture bypass_unchanged; gate; : > "$LOG"; release 0.5.271 --skip-release-gate "rig: reason"
if [ "$RC" = 0 ] && [ "$(steps)" = "$SHIP" ] && [[ "$OUT" == *"release-gate: BYPASSED"* ]] && grep -qF 'rig: reason' "$LOG.notes"; then pass "bypass_unchanged" "BYPASSED banner, reason in notes, no SKIPPED"
else fail "bypass_unchanged" "rc=$RC steps=[$(steps)] tail=[$(printf '%s' "$OUT" | tail -3 | tr '\n' '|')]"; fi

echo
if [ "$FAILED" -ne 0 ]; then echo "#484 release-receipt rig: FAILED"; exit 1; fi
echo "#484 release-receipt rig: PASS — all arms green"
