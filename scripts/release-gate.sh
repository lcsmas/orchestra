#!/usr/bin/env bash
# #207 release gate, sourced by release.sh: tsc -> `pnpm run test` (tests==pass, 0 fail/skipped/todo,
# readable summary) -> tree == HEAD (tracked unchanged, no untracked files); then build:bus-abi (suite =
# node ABI 127, package = Electron 130).
# Refusal: `release-gate: REFUSED — check '<name>' failed: <why>` on stderr. Rig: verify-release-gate.sh.

# Sum the node --test summary counters (TAP `# key N` or spec `ℹ key N`) over the whole log.
# Prints `tests=N pass=N fail=N cancelled=N skipped=N todo=N`; rc 3 if a required key is absent.
rg_test_summary() {
  awk '
    /^(# |ℹ )(tests|pass|fail|cancelled|skipped|todo) [0-9]+[ \t]*$/ { k = $2; n[k] += $3; seen[k] = 1 }
    END {
      if (!seen["tests"] || !seen["pass"] || !seen["fail"] || !seen["skipped"]) exit 3
      printf "tests=%d pass=%d fail=%d cancelled=%d skipped=%d todo=%d\n",
        n["tests"], n["pass"], n["fail"], n["cancelled"], n["skipped"], n["todo"]
    }' "$1"
}

_rg_refuse() { # check-name detail
  printf "release-gate: REFUSED — check '%s' failed: %s\n" "$1" "$2" >&2
}

# Prints why the tree is not exactly HEAD (a tag carries only tracked, committed files), or nothing.
_rg_tree_dirt() {
  git update-index -q --refresh 2>/dev/null || true   # an mtime-only touch is not a change
  git diff-index --quiet HEAD -- || echo "tracked files changed: $(git status --short --untracked-files=no | head -5 | tr '\n' ';')"
  local u; u="$(git ls-files --others --exclude-standard | head -5 | tr '\n' ';')"
  [ -z "$u" ] || echo "untracked files not ignored (the tag would lack them): $u"
}

# Judge a test log + the test command's rc. Prints the PASS detail on stdout and returns 0,
# or prints the REFUSED line on stderr and returns 1.
rg_judge_test() { # log rc
  local log="$1" rc="$2" s
  if ! s="$(rg_test_summary "$log")"; then
    _rg_refuse test "'pnpm run test' (rc=$rc) printed no readable summary, so 0 failures / 0 skipped cannot be verified (fails closed). Log: $log"
    return 1
  fi
  local tests pass fail cancelled skipped todo
  IFS=' =' read -r _ tests _ pass _ fail _ cancelled _ skipped _ todo <<<"$s"
  if [ "$rc" -ne 0 ] || [ "$fail" -gt 0 ] || [ "$cancelled" -gt 0 ]; then
    _rg_refuse test "'pnpm run test' rc=$rc — $s. Failing: $(grep -E '^[[:space:]]*not ok' "$log" | head -5 | tr -s ' ' | tr '\n' ';'). Log: $log"
    return 1
  fi
  if [ "$tests" -eq 0 ]; then
    _rg_refuse test "0 tests ran — $s. Log: $log"; return 1
  fi
  if [ "$skipped" -gt 0 ] || [ "$todo" -gt 0 ]; then
    _rg_refuse test "$skipped skipped / $todo todo — a partial green is not a pass ($s). Log: $log"
    return 1
  fi
  if [ "$tests" -ne "$pass" ]; then
    _rg_refuse test "tests=$tests != pass=$pass — every test must pass ($s). Log: $log"; return 1
  fi
  printf 'tests %s pass / 0 fail / 0 skipped' "$pass"
}

# Run the gate on the tree in the current directory (release.sh cd's to the repo top).
rg_run_gate() {
  local dir head0; dir="$(mktemp -d "${TMPDIR:-/tmp}/release-gate.XXXXXX")" || return 1
  head0="$(git rev-parse HEAD)"
  local dirt; dirt="$(_rg_tree_dirt)"
  if [ -n "$dirt" ]; then _rg_refuse tree "$dirt"; return 1; fi
  echo "  gate 1/2: npx tsc --noEmit"
  if ! npx tsc --noEmit >"$dir/tsc.log" 2>&1; then
    _rg_refuse tsc "'npx tsc --noEmit' exited nonzero. Log: $dir/tsc.log"
    head -15 "$dir/tsc.log" >&2
    return 1
  fi
  echo "  ok: tsc clean"
  echo "  gate 2/2: pnpm run test"
  local rc=0 detail
  pnpm run test >"$dir/test.log" 2>&1 || rc=$?
  detail="$(rg_judge_test "$dir/test.log" "$rc")" || return 1
  echo "  ok: $detail"
  dirt="$(_rg_tree_dirt)"
  if [ "$(git rev-parse HEAD)" != "$head0" ] || [ -n "$dirt" ]; then
    _rg_refuse tree "the tree changed while the gate ran, so it is not the tree that would be released: HEAD ${head0:0:8}->$(git rev-parse --short=8 HEAD) $dirt"
    return 1
  fi
  rm -rf "$dir"
  echo "release-gate: PASS — tsc clean; $detail; tree $(git rev-parse --short=12 'HEAD^{tree}')"
}

# After the suite (node ABI 127) and before the packaged build (Electron ABI 130).
rg_prepare_native() {
  local log; log="$(mktemp "${TMPDIR:-/tmp}/release-gate-abi.XXXXXX")" || return 1
  echo "  pnpm run build:bus-abi (the packaged build needs the Electron ABI, the suite leaves node's)"
  if ! pnpm run build:bus-abi >"$log" 2>&1; then
    _rg_refuse build:bus-abi "'pnpm run build:bus-abi' exited nonzero. Log: $log"
    tail -15 "$log" >&2
    return 1
  fi
  rm -f "$log"
}

# The record appended to the release notes when the gate is bypassed.
rg_bypass_record() { # reason
  printf '\n## ⚠ Release gate bypassed\n\nCut with `--skip-release-gate`: `npx tsc --noEmit` and the full test suite were **not run** on this tree.\n\n- reason: %s\n- tree: %s\n- date: %s\n' \
    "$1" "$(git rev-parse --short=12 'HEAD^{tree}')" "$(date -u +%Y-%m-%dT%H:%MZ)"
}
