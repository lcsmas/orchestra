#!/usr/bin/env bash
# #207 release gate, sourced by release.sh: tsc -> `pnpm run test` (tests==pass, 0 fail/skipped/todo,
# readable summary) -> `pnpm run test:session-budget` (#208: the real session path + real CLI against a
# local fake API; rc 0 AND the `SESSION-BUDGET: PASS` terminator) -> tree == HEAD (tracked unchanged, no
# untracked files); then build:bus-abi (suite = node ABI 127, package = Electron 130).
# Opt-in: RELEASE_REAL_API_SMOKE_CONFIG_DIR=<account CLAUDE_CONFIG_DIR> adds ONE real cheap-model turn (real tokens).
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

# Judge a session-budget log + the suite's rc (#208). Prints the PASS detail on stdout and returns 0, or
# prints the REFUSED line on stderr and returns 1. rc 0 alone is not a pass: the suite's own terminator
# line must be present (a truncated log has no FAIL line either). rc 3 = VOID (the subject never mounted).
rg_judge_session_budget() { # log rc
  local log="$1" rc="$2" why
  if [ "$rc" -ne 0 ]; then
    why="$(grep -E 'BUDGET BROKEN|INSTRUMENT VOID|RUN BROKE|UNEXPECTED|VOID —|Missing script|ERR_PNPM' "$log" | head -3 | tr -s ' ' | tr '\n' ';')"
    _rg_refuse session-budget "'pnpm run test:session-budget' rc=$rc$([ "$rc" -eq 3 ] && echo ' (VOID: nothing was measured)') — ${why:-no diagnostic line}. Log: $log"
    return 1
  fi
  if grep -qx 'SESSION-BUDGET: PARTIAL' "$log"; then
    _rg_refuse session-budget "the suite printed 'SESSION-BUDGET: PARTIAL' — a partial (--arm) run never counts; the gate runs every arm. Log: $log"
    return 1
  fi
  if grep -qx 'SESSION-BUDGET: PASS-WEAK' "$log"; then
    _rg_refuse session-budget "the suite ran with WEAK egress containment (SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT=1) and printed 'SESSION-BUDGET: PASS-WEAK' — a release needs net+pid namespaces (bwrap). Log: $log"
    return 1
  fi
  if ! grep -qx 'SESSION-BUDGET: PASS' "$log"; then
    _rg_refuse session-budget "'pnpm run test:session-budget' rc=0 but no 'SESSION-BUDGET: PASS' terminator line, so a truncated run cannot be told from a pass (fails closed). Log: $log"
    return 1
  fi
  printf 'session budget held (%s)' "$(grep -m1 'requests before first reply' "$log" | sed 's/^[[:space:]]*//')"
}

# Run the gate on the tree in the current directory (release.sh cd's to the repo top).
rg_run_gate() {
  local dir head0; dir="$(mktemp -d "${TMPDIR:-/tmp}/release-gate.XXXXXX")" || return 1
  head0="$(git rev-parse HEAD)"
  local dirt; dirt="$(_rg_tree_dirt)"
  if [ -n "$dirt" ]; then _rg_refuse tree "$dirt"; return 1; fi
  echo "  gate 1/3: npx tsc --noEmit"
  if ! npx tsc --noEmit >"$dir/tsc.log" 2>&1; then
    _rg_refuse tsc "'npx tsc --noEmit' exited nonzero. Log: $dir/tsc.log"
    head -15 "$dir/tsc.log" >&2
    return 1
  fi
  echo "  ok: tsc clean"
  echo "  gate 2/3: pnpm run test"
  local rc=0 detail
  pnpm run test >"$dir/test.log" 2>&1 || rc=$?
  detail="$(rg_judge_test "$dir/test.log" "$rc")" || return 1
  echo "  ok: $detail"
  echo "  gate 3/3: pnpm run test:session-budget (real CLI vs a local fake API, zero tokens)"
  local sb_rc=0 sb_detail
  pnpm run test:session-budget >"$dir/session-budget.log" 2>&1 || sb_rc=$?
  sb_detail="$(rg_judge_session_budget "$dir/session-budget.log" "$sb_rc")" || return 1
  echo "  ok: $sb_detail"
  detail="$detail; $sb_detail"
  # Opt-in (#208): ONE tiny cheap-model turn on the CHOSEN account — the only step that spends real tokens.
  # Off unless RELEASE_REAL_API_SMOKE_CONFIG_DIR names the account's CLAUDE_CONFIG_DIR (never defaulted).
  if [ -n "${RELEASE_REAL_API_SMOKE_CONFIG_DIR:-}" ]; then
    echo "  gate 4 (opt-in): real-API smoke on account dir '${RELEASE_REAL_API_SMOKE_CONFIG_DIR##*/}' — spends real tokens (one tiny turn)"
    local sm_rc=0
    pnpm run smoke:session-budget-real --real-api --config-dir "$RELEASE_REAL_API_SMOKE_CONFIG_DIR" >"$dir/smoke.log" 2>&1 || sm_rc=$?
    if [ "$sm_rc" -ne 0 ] || ! grep -qx 'REAL-API-SMOKE: PASS' "$dir/smoke.log"; then
      _rg_refuse real-api-smoke "'pnpm run smoke:session-budget-real' rc=$sm_rc without a 'REAL-API-SMOKE: PASS' line — $(head -c 300 "$dir/smoke.log" | tr '\n' ' '). Log: $dir/smoke.log"
      return 1
    fi
    echo "  ok: real-API smoke passed ($(head -1 "$dir/smoke.log" | head -c 200))"
    detail="$detail; real-API smoke passed"
  fi
  dirt="$(_rg_tree_dirt)"
  if [ "$(git rev-parse HEAD)" != "$head0" ] || [ -n "$dirt" ]; then
    _rg_refuse tree "the tree changed while the gate ran, so it is not the tree that would be released: HEAD ${head0:0:8}->$(git rev-parse --short=8 HEAD) $dirt"
    return 1
  fi
  rm -rf "$dir"
  echo "release-gate: PASS — tsc clean; $detail; tree $(git rev-parse --short=12 'HEAD^{tree}')"
}

# After the suite (node ABI 127) and before the packaged build (Electron ABI 130). Sets _RG_NATIVE_READY for rg_ui_idle_budget.
rg_prepare_native() {
  local log; log="$(mktemp "${TMPDIR:-/tmp}/release-gate-abi.XXXXXX")" || return 1
  echo "  pnpm run build:bus-abi (the packaged build needs the Electron ABI, the suite leaves node's)"
  if ! pnpm run build:bus-abi >"$log" 2>&1; then
    _rg_refuse build:bus-abi "'pnpm run build:bus-abi' exited nonzero. Log: $log"
    tail -15 "$log" >&2
    return 1
  fi
  rm -f "$log"
  _RG_NATIVE_READY=1
}

# UI idle budget (#215): the built app under its OWN headless sway (no visible window) must do zero per-frame work on idle panes.
# Builds this tree's bundles, then scripts/e2e-ui-idle-budget.sh: rc 0 pass, 1 budget breached, 4 a control refused, else a rig fault.
rg_ui_idle_budget() {
  local dir rc=0 head0 dirt; dir="$(mktemp -d "${TMPDIR:-/tmp}/release-gate-ui.XXXXXX")" || return 1
  head0="$(git rev-parse HEAD)"
  echo "  gate: UI idle budget (pnpm run build:bundles -> scripts/e2e-ui-idle-budget.sh, own headless sway)"
  [ "${_RG_NATIVE_READY:-0}" = 1 ] || rg_prepare_native || return 1
  if ! pnpm run build:bundles >"$dir/bundles.log" 2>&1; then
    _rg_refuse ui-idle-budget "'pnpm run build:bundles' exited nonzero. Log: $dir/bundles.log"; tail -15 "$dir/bundles.log" >&2; return 1
  fi
  # Bounded (#215 F7): one wedged compositor or renderer must not hang a release. RG_UI_TIMEOUT is the rig's test seam (default 600 s).
  timeout -k 30 "${RG_UI_TIMEOUT:-600}" bash scripts/e2e-ui-idle-budget.sh --require-bus --json "$dir/ui.json" >"$dir/ui.log" 2>&1 || rc=$?   # the shipped app has a fleet bus: a run without it proves less
  local lines; lines="$(grep -E '^(FAIL|REFUSE|REFUSED|ABORT|ui-idle-budget:)' "$dir/ui.log" | cut -c1-400 | head -8 | tr '\n' ';' || true)"
  case "$rc" in
    0) : ;;
    1) _rg_refuse ui-idle-budget "an idle pane does per-frame work: $lines Log: $dir/ui.log"; return 1 ;;
    4) _rg_refuse ui-idle-budget "a positive control refused, so the run proves nothing (fails closed): $lines Log: $dir/ui.log"; return 1 ;;
    124) _rg_refuse ui-idle-budget "timed out after ${RG_UI_TIMEOUT:-600} s (a wedged compositor or renderer): $(tail -3 "$dir/ui.log" | tr '\n' ';') Log: $dir/ui.log"; return 1 ;;
    *) _rg_refuse ui-idle-budget "the rig itself failed (rc=$rc): $(tail -3 "$dir/ui.log" | tr '\n' ';') Log: $dir/ui.log"; return 1 ;;
  esac
  # rc 0 alone is not a pass (a silent or truncated run also exits 0): the rig's own terminator line, and separately its JSON verdict, must be there.
  if ! grep -q '^ui-idle-budget: PASS' "$dir/ui.log"; then
    _rg_refuse ui-idle-budget "rc=0 but no 'ui-idle-budget: PASS' terminator line, so a silent or truncated run cannot be told from a pass (fails closed). Log: $dir/ui.log"; return 1
  fi
  if ! grep -q '"verdict": "PASS"' "$dir/ui.json" 2>/dev/null; then
    _rg_refuse ui-idle-budget "rc=0 and a PASS line but the JSON verdict is missing or not PASS ($dir/ui.json) (fails closed). Log: $dir/ui.log"; return 1
  fi
  dirt="$(_rg_tree_dirt)"
  if [ "$(git rev-parse HEAD)" != "$head0" ] || [ -n "$dirt" ]; then
    _rg_refuse tree "the tree changed while the UI budget ran: HEAD ${head0:0:8}->$(git rev-parse --short=8 HEAD) $dirt"; return 1
  fi
  echo "  ok: $(grep -E '^ui-idle-budget: PASS' "$dir/ui.log" | head -1 | cut -c1-300)"
  rm -rf "$dir"
}

# The record appended to the release notes when the gate is bypassed.
rg_bypass_record() { # reason
  printf '\n## ⚠ Release gate bypassed\n\nCut with `--skip-release-gate`: `npx tsc --noEmit`, the full test suite, the session-budget suite and the UI idle budget were **not run** on this tree.\n\n- reason: %s\n- tree: %s\n- date: %s\n' \
    "$1" "$(git rev-parse --short=12 'HEAD^{tree}')" "$(date -u +%Y-%m-%dT%H:%MZ)"
}
