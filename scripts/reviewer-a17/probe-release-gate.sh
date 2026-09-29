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

# mk_fixture <name> <ts:ok|err> <test:pass|fail|skip|todo|nosummary|dirty|moved|rcfail|zero|abifail|swallowfail|swallowhang|noskipped>
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
      moved) echo "import cp from 'node:child_process'; cp.execSync('git commit --allow-empty -qm moved');" ;;
    esac
  } > "$W/test/x.test.mjs"
  ( cd "$W" && git add -A && git commit -qm base && git tag v0.5.270 \
      && git remote add origin "$ORIGIN" && git push -q origin master --tags \
      && echo work >> tracked.txt && git add -A && git commit -qm "work" ) >/dev/null 2>&1
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
    [ "$(steps)" = "$want" ] && pass "$n steps" "[$(steps)]" || fail "$n steps" "got [$(steps)] want [$want]"
  fi
}

# ---------------- a17 reviewer probes ----------------
which_probe="${1:-all}"
tomaster_fixture() { # name ts tv -> feature branch
  mk_fixture "$1" "$2" "$3"; git -C "$W" checkout -q -b feat
}
if [ "$which_probe" = all ] || [ "$which_probe" = tomaster ]; then
  echo "== P1a --to-master + type error (canonical ship flow: --to-master)"
  tomaster_fixture tm_tsc err pass; run_release 0.5.271 --to-master
  echo "rc=$RC steps=[$(steps)] origin-master-moved=$([ "$(git -C "$ORIGIN" rev-parse master)" = "$ORIGIN0" ] && echo NO || echo YES) origin-tag=$(git -C "$ORIGIN" tag -l v0.5.271)"
  printf '%s\n' "$OUT" | grep -F 'REFUSED' | head -1
  echo "== P1b --to-master + failing test"
  tomaster_fixture tm_fail ok fail; run_release 0.5.271 --to-master
  echo "rc=$RC steps=[$(steps)] origin-master-moved=$([ "$(git -C "$ORIGIN" rev-parse master)" = "$ORIGIN0" ] && echo NO || echo YES) origin-tag=$(git -C "$ORIGIN" tag -l v0.5.271)"
  echo "== P1c --to-master clean"
  tomaster_fixture tm_ok ok pass; run_release 0.5.271 --to-master
  echo "rc=$RC steps=[$(steps)] origin-master==HEAD=$([ "$(git -C "$ORIGIN" rev-parse master)" = "$(git -C "$W" rev-parse HEAD)" ] && echo YES || echo NO) origin-tag=$(git -C "$ORIGIN" tag -l v0.5.271)"
fi
if [ "$which_probe" = all ] || [ "$which_probe" = cionly ]; then
  echo "== P2 --ci-only + failing test"
  mk_fixture ci_fail ok fail; run_release 0.5.271 --ci-only
  echo "rc=$RC steps=[$(steps)] origin-tag=$(git -C "$ORIGIN" tag -l v0.5.271)"
  printf '%s\n' "$OUT" | grep -F 'REFUSED' | head -1
  echo "== P2b --ci-only + clean"
  mk_fixture ci_ok ok pass; run_release 0.5.271 --ci-only
  echo "rc=$RC steps=[$(steps)] origin-tag=$(git -C "$ORIGIN" tag -l v0.5.271)"
fi
if [ "$which_probe" = all ] || [ "$which_probe" = untracked ]; then
  echo "== P3 untracked imported file"
  mk_fixture untr ok pass
  ( cd "$W" && printf 'import { y } from "./b";\nexport const x: number = y;\n' > src/a.ts && git add src/a.ts && git commit -qm "a imports b" && printf 'export const y: number = 1;\n' > src/b.ts )
  git -C "$W" status --porcelain
  HEAD0="$(git -C "$W" rev-parse HEAD)"
  run_release 0.5.271
  echo "rc=$RC steps=[$(steps)] origin-tag=$(git -C "$ORIGIN" tag -l v0.5.271)"
  echo "b.ts in the tagged tree? $(git -C "$W" ls-tree -r --name-only v0.5.271 2>/dev/null | grep -c '^src/b.ts$') (0 = tag lacks the file the gate's tsc/tests saw)"
fi
if [ "$which_probe" = all ] || [ "$which_probe" = argswallow ]; then
  echo "== P4 --skip-release-gate patch (next positional swallowed as reason)"
  mk_fixture swallow err pass; run_release --skip-release-gate patch
  echo "rc=$RC steps=[$(steps)]"; grep -i 'reason' "$LOG.notes" | head -2
fi
if [ "$which_probe" = all ] || [ "$which_probe" = swallowminor ]; then
  echo "== P5 --dry-run --skip-release-gate minor  (bump keyword AFTER the flag)"
  mk_fixture sw2 ok pass; run_release --dry-run --skip-release-gate minor
  printf '%s\n' "$OUT" | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'Releasing|BYPASSED' | cut -c1-200
  echo "== P5b --dry-run minor --skip-release-gate why (bump keyword BEFORE the flag)"
  run_release --dry-run minor --skip-release-gate why
  printf '%s\n' "$OUT" | sed 's/\x1b\[[0-9;]*m//g' | grep -E 'Releasing|BYPASSED' | cut -c1-200
fi
