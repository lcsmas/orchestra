#!/usr/bin/env bash
# #207 release gate, sourced by release.sh: tsc -> `pnpm run test` (tests==pass, 0 fail/skipped/todo,
# readable summary) -> `pnpm run test:session-budget` (#208: the real session path + real CLI against a
# local fake API; rc 0 AND the `SESSION-BUDGET: PASS` terminator) -> `pnpm run test:admission-hold` + `pnpm run test:admission-wake`
# (#286/#287: the Admission rigs — real modules, fake memory source; rc 0 AND `… ALL PASS (N/N)` with N==N>0, ~35 s together)
# -> tree == HEAD (tracked unchanged, no untracked files); then build:bus-abi (suite = node ABI 127, package = Electron 130).
# Opt-in: RELEASE_REAL_API_SMOKE_CONFIG_DIR=<account CLAUDE_CONFIG_DIR> adds ONE real cheap-model turn (real tokens).
# Refusal: `release-gate: REFUSED — check '<name>' failed: <why>` on stderr. Rig: verify-release-gate.sh.
# #484 RECEIPT: a full PASS writes `<git-common-dir>/release-gate-receipts/<tree>` (the gated tree with package.json's `version` line masked + the
# gate version); release.sh skips the gate when HEAD's masked tree has a receipt of this gate version (rg_receipt_check). Standalone: `bash scripts/release-gate.sh`.
# Rig: verify-release-receipt.sh.
# #595: rg_full_ci_check — the tag's tree also needs a green FULL rig run (a `workflow_dispatch` run of ci.yml on a commit with the same tree); release.sh refuses without it. Rig: verify-release-gate.sh `ci_*` arms.

# Bump this when the gate's checks change meaning: every receipt of another version stops counting (#484).
RG_GATE_VERSION=1

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

# ---------------------------------------------------------------- #484 receipt ---
# Receipt dir: outside the working tree (shared by every worktree of the repo); RELEASE_GATE_RECEIPT_DIR overrides it (rig).
_rg_receipt_dir() { printf '%s\n' "${RELEASE_GATE_RECEIPT_DIR:-$(git rev-parse --path-format=absolute --git-common-dir)/release-gate-receipts}"; }

# Prints the id of <rev>'s tree with package.json's top-level `"version"` line masked (the ONLY thing a release bump changes). Two trees share this id iff
# they are byte-identical except that one line. If package.json has no single top-level version line the id is the raw tree id (fails closed: a bump then
# changes it). The masked tree is built in a scratch index + object dir (alternates = the real one), so the repo gains no objects.
rg_norm_tree() { # [rev=HEAD]
  local rev="${1:-HEAD}" raw tmp mode objs norm=""
  raw="$(git rev-parse --verify -q "$rev^{tree}")" || return 1
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/rg-norm.XXXXXX")" || { printf '%s\n' "$raw"; return 0; }
  mode="$(git ls-tree "$raw" -- package.json | awk '{print $1}')"
  if [ -n "$mode" ] && git cat-file blob "$raw:package.json" | node -e '
      const raw = require("node:fs").readFileSync(0, "utf8");
      let v; try { v = JSON.parse(raw).version; } catch { process.exit(1); }
      if (typeof v !== "string") process.exit(1);
      const re = /^( {2}|\t)"version"[ \t]*:[ \t]*"([^"\\]*)"(,?[ \t]*)$/gm;
      const hits = [...raw.matchAll(re)];
      if (hits.length !== 1 || hits[0][2] !== v) process.exit(1);
      process.stdout.write(raw.replace(re, "$1\"version\": \"0.0.0-masked\"$3"));' > "$tmp/pkg" 2>/dev/null; then
    objs="$(git rev-parse --path-format=absolute --git-path objects)"; mkdir -p "$tmp/obj"
    norm="$(GIT_INDEX_FILE="$tmp/index" GIT_OBJECT_DIRECTORY="$tmp/obj" GIT_ALTERNATE_OBJECT_DIRECTORIES="$objs" sh -c '
      git read-tree "$1" && b="$(git hash-object -w --stdin < "$3")" && git update-index --add --cacheinfo "$2,$b,package.json" && git write-tree' _ "$raw" "$mode" "$tmp/pkg" 2>/dev/null)" || norm=""
  fi
  rm -rf "$tmp"
  printf '%s\n' "${norm:-$raw}"
}

_rg_receipt_field() { sed -n "s/^$2=//p" "$1" | head -1; }

# Called after a full PASS on a clean tree (rg_run_gate): record it. Atomic (tmp + mv); a failed write never fails the gate.
rg_receipt_write() { # head0 detail — head0 = the commit the gate JUDGED; nothing is recorded if HEAD is no longer it
  local head0="$1" dir norm raw tmp; dir="$(_rg_receipt_dir)" || return 0
  if [ "$(git rev-parse HEAD)" != "$head0" ]; then echo "  receipt: NOT recorded — HEAD moved from ${head0:0:8} to $(git rev-parse --short=8 HEAD) after the gate ran"; return 0; fi
  norm="$(rg_norm_tree "$head0")" || return 0; raw="$(git rev-parse "$head0^{tree}")"
  mkdir -p "$dir" 2>/dev/null && tmp="$(mktemp "$dir/.tmp.XXXXXX" 2>/dev/null)" || return 0
  {
    printf 'gate_version=%s\nnorm_tree=%s\nraw_tree=%s\nhead=%s\nversion=%s\ndate=%s\ndetail=%s\n' \
      "$RG_GATE_VERSION" "$norm" "$raw" "$head0" "$(git show "$head0:package.json" 2>/dev/null | node -p "JSON.parse(require('node:fs').readFileSync(0,'utf8')).version" 2>/dev/null)" "$(date -u +%Y-%m-%dT%H:%MZ)" "$2"
  } > "$tmp" && mv -f "$tmp" "$dir/$norm" || { rm -f "$tmp"; echo "  receipt: NOT recorded (write failed)"; return 0; }
  echo "  receipt: PASS recorded for tree ${norm:0:12} (gate v$RG_GATE_VERSION)"
}

# Is there a PASS receipt for HEAD? Returns 0 (hit: the gate need not run; proof lines on stdout) or 1 (miss: why on stdout; run the gate).
# Hit = tree has no tracked/untracked change AND a receipt exists for HEAD's masked tree AND it is this gate version AND (explicit proof) HEAD's tree
# equals the gated tree outright or differs from it by package.json's version line only.
rg_receipt_check() {
  local dirt dir norm raw f rv rnorm rraw changed
  dirt="$(_rg_tree_dirt)"; [ -z "$dirt" ] || { echo "no receipt honoured — $dirt"; return 1; }
  dir="$(_rg_receipt_dir)"; norm="$(rg_norm_tree HEAD)" || { echo "no receipt honoured — cannot resolve HEAD's tree"; return 1; }
  raw="$(git rev-parse 'HEAD^{tree}')"; f="$dir/$norm"
  [ -f "$f" ] || { echo "no receipt for tree ${norm:0:12}"; return 1; }
  rv="$(_rg_receipt_field "$f" gate_version)"; rnorm="$(_rg_receipt_field "$f" norm_tree)"; rraw="$(_rg_receipt_field "$f" raw_tree)"
  [ "$rv" = "$RG_GATE_VERSION" ] || { echo "receipt for tree ${norm:0:12} is gate v${rv:-?}, this gate is v$RG_GATE_VERSION"; return 1; }
  [ "$rnorm" = "$norm" ] && [ -n "$rraw" ] || { echo "receipt for tree ${norm:0:12} is malformed (norm_tree/raw_tree)"; return 1; }
  if [ "$rraw" = "$raw" ]; then
    echo "PASS receipt: HEAD tree ${raw:0:12} is the gated tree (gate v$RG_GATE_VERSION, gated $(_rg_receipt_field "$f" date))"; return 0
  fi
  if git cat-file -e "$rraw^{tree}" 2>/dev/null; then
    changed="$(git diff-tree -r --name-only "$rraw" "$raw" | tr '\n' ' ' | sed 's/ $//')"
    [ "$changed" = package.json ] || { echo "receipt tree ${rraw:0:12} vs HEAD tree ${raw:0:12} differ in [$changed], not package.json alone"; return 1; }
  fi
  echo "PASS receipt: HEAD tree ${raw:0:12} == gated tree ${rraw:0:12} except package.json version ($(_rg_receipt_field "$f" version) -> $(node -p "require('./package.json').version" 2>/dev/null)); masked tree ${norm:0:12} (gate v$RG_GATE_VERSION)"
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

# Judge an Admission-rig log + the rig's rc (#286/#287 follow-up F2). Prints the PASS detail on stdout and returns 0, or prints the REFUSED line on stderr and
# returns 1. rc 0 alone is not a pass: the driver's own terminator `<label> ALL PASS (N/N) tree <path>` must be present with N==N>0 (a RIG_ARMS subset or a
# truncated log has no FAIL line either) and name THIS tree (a RIG_REPO pointing elsewhere would gate the wrong code).
rg_judge_admission_rig() { # check-name label log rc
  local name="$1" label="$2" log="$3" rc="$4" line n m tree
  if [ "$rc" -ne 0 ]; then
    local why; why="$(grep -E '^FAIL |: RED |rig fault|SAFETY|Missing script|ERR_PNPM|not acquired' "$log" | head -3 | tr -s ' ' | tr '\n' ';')"
    _rg_refuse "$name" "'pnpm run test:$name' rc=$rc — ${why:-no diagnostic line}. Log: $log"
    return 1
  fi
  line="$(grep -E "^${label} ALL PASS \([0-9]+/[0-9]+\) tree " "$log" | tail -1)"
  if [ -z "$line" ]; then
    _rg_refuse "$name" "'pnpm run test:$name' rc=0 but no '${label} ALL PASS (N/N)' terminator line, so a truncated run cannot be told from a pass (fails closed). Log: $log"
    return 1
  fi
  n="$(printf '%s' "$line" | sed -E 's/^.*\(([0-9]+)\/([0-9]+)\).*$/\1/')"
  m="$(printf '%s' "$line" | sed -E 's/^.*\(([0-9]+)\/([0-9]+)\).*$/\2/')"
  if [ "$n" != "$m" ] || [ "$m" -le 0 ]; then
    _rg_refuse "$name" "terminator '${line}' is a partial run (${n}/${m}) — the gate runs every arm. Log: $log"
    return 1
  fi
  tree="${line##* tree }"
  if [ "$(cd "$tree" 2>/dev/null && pwd -P)" != "$(pwd -P)" ]; then
    _rg_refuse "$name" "the rig exercised '$tree', not this tree ($(pwd -P)) — an inherited RIG_REPO must not gate other code. Log: $log"
    return 1
  fi
  printf '%s %s/%s arms' "$name" "$n" "$m"
}

# Run the gate on the tree in the current directory (release.sh cd's to the repo top).
rg_run_gate() {
  local dir head0; dir="$(mktemp -d "${TMPDIR:-/tmp}/release-gate.XXXXXX")" || return 1
  head0="$(git rev-parse HEAD)"
  local dirt; dirt="$(_rg_tree_dirt)"
  if [ -n "$dirt" ]; then _rg_refuse tree "$dirt"; return 1; fi
  echo "  gate 1/5: npx tsc --noEmit"
  if ! npx tsc --noEmit >"$dir/tsc.log" 2>&1; then
    _rg_refuse tsc "'npx tsc --noEmit' exited nonzero. Log: $dir/tsc.log"
    head -15 "$dir/tsc.log" >&2
    return 1
  fi
  echo "  ok: tsc clean"
  echo "  gate 2/5: pnpm run test"
  local rc=0 detail
  pnpm run test >"$dir/test.log" 2>&1 || rc=$?
  detail="$(rg_judge_test "$dir/test.log" "$rc")" || return 1
  echo "  ok: $detail"
  echo "  gate 3/5: pnpm run test:session-budget (real CLI vs a local fake API, zero tokens)"
  local sb_rc=0 sb_detail
  pnpm run test:session-budget >"$dir/session-budget.log" 2>&1 || sb_rc=$?
  sb_detail="$(rg_judge_session_budget "$dir/session-budget.log" "$sb_rc")" || return 1
  echo "  ok: $sb_detail"
  detail="$detail; $sb_detail"
  # #286/#287 Admission rigs (F2): every arm of the hold rig and the wake rig, on THIS tree. RIG_ARMS / RIG_REPO are unset for them — an inherited subset or
  # foreign tree must not turn the gate into a partial or wrong-tree pass.
  local ar_rc ar_detail
  echo "  gate 4/5: pnpm run test:admission-hold (Admission hold rig, fake memory source)"
  ar_rc=0; env -u RIG_ARMS -u RIG_REPO pnpm run test:admission-hold >"$dir/admission-hold.log" 2>&1 || ar_rc=$?
  ar_detail="$(rg_judge_admission_rig admission-hold 'ADMISSION RIG:' "$dir/admission-hold.log" "$ar_rc")" || return 1
  echo "  ok: $ar_detail"
  detail="$detail; $ar_detail"
  echo "  gate 5/5: pnpm run test:admission-wake (Admission wake rig, fake memory source)"
  ar_rc=0; env -u RIG_ARMS -u RIG_REPO pnpm run test:admission-wake >"$dir/admission-wake.log" 2>&1 || ar_rc=$?
  ar_detail="$(rg_judge_admission_rig admission-wake 'ADMISSION-WAKE RIG:' "$dir/admission-wake.log" "$ar_rc")" || return 1
  echo "  ok: $ar_detail"
  detail="$detail; $ar_detail"
  # Opt-in (#208): ONE tiny cheap-model turn on the CHOSEN account — the only step that spends real tokens.
  # Off unless RELEASE_REAL_API_SMOKE_CONFIG_DIR names the account's CLAUDE_CONFIG_DIR (never defaulted).
  if [ -n "${RELEASE_REAL_API_SMOKE_CONFIG_DIR:-}" ]; then
    echo "  gate 6 (opt-in): real-API smoke on account dir '${RELEASE_REAL_API_SMOKE_CONFIG_DIR##*/}' — spends real tokens (one tiny turn)"
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
  rg_receipt_write "$head0" "tsc clean; $detail"
  echo "release-gate: PASS — tsc clean; $detail; tree $(git rev-parse --short=12 "$head0^{tree}")"
}

# #595 FULL RIG RUN: a pull request runs only the rigs its files select, so the tag's tree needs one green run of EVERY rig. `ci.yml` has a `workflow_dispatch` trigger = the full run (no path
# selection); the tag's tree must equal (package.json's version line masked, as the #484 receipt) the tree of a commit with a green dispatch run. A pull_request run never counts (path-selected).
# Prints the proof on stdout and returns 0, or prints the REFUSED line on stderr and returns 1 (fails closed: an unreadable list is a refusal). RG_GH overrides `gh` (rig).
rg_full_ci_check() {
  local gh="${RG_GH:-gh}" want rows sha url norm n=0 lines
  want="$(rg_norm_tree HEAD)" || { _rg_refuse full-ci "cannot resolve HEAD's tree"; return 1; }
  if ! rows="$("$gh" run list --workflow ci.yml --event workflow_dispatch --status success --limit 40 --json headSha,url 2>/dev/null)"; then
    _rg_refuse full-ci "'gh run list --workflow ci.yml --event workflow_dispatch' failed, so a green full rig run cannot be proven (fails closed). Check 'gh auth status'."; return 1
  fi
  lines="$(printf '%s' "$rows" | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{for(const r of JSON.parse(t))if(r&&/^[0-9a-f]{7,40}$/.test(r.headSha||""))console.log(r.headSha+"\t"+(r.url||""))}catch{process.exit(1)}})')" \
    || { _rg_refuse full-ci "'gh run list' printed something that is not the expected JSON (fails closed)"; return 1; }
  while IFS=$'\t' read -r sha url; do
    [ -n "$sha" ] || continue; n=$((n + 1))
    git cat-file -e "$sha^{commit}" 2>/dev/null || git fetch -q origin "$sha" 2>/dev/null || continue
    norm="$(rg_norm_tree "$sha")" || continue
    if [ "$norm" = "$want" ]; then
      echo "full rig run PASS: $url (ci.yml workflow_dispatch on ${sha:0:8}, tree ${want:0:12}, package.json version line masked)"; return 0
    fi
  done <<<"$lines"
  _rg_refuse full-ci "no green workflow_dispatch run of ci.yml (every rig, no path selection) on a commit with this tree (${want:0:12}; $n recent green dispatch run(s) checked). A pull-request run is path-selected and never counts. Run it, wait for green, then release again: gh workflow run ci.yml --ref <branch-or-master> ; gh run watch — or --skip-release-gate \"<reason>\" (recorded in the release notes)."
  return 1
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
  printf '\n## ⚠ Release gate bypassed\n\nCut with `--skip-release-gate`: `npx tsc --noEmit`, the full test suite, the session-budget suite and the Admission rigs were **not run** on this tree.\n\n- reason: %s\n- tree: %s\n- date: %s\n' \
    "$1" "$(git rev-parse --short=12 'HEAD^{tree}')" "$(date -u +%Y-%m-%dT%H:%MZ)"
}

# Standalone (`bash scripts/release-gate.sh`): the vague's final gate — runs the gate on this tree and leaves the #484 receipt release.sh honours.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  cd "$(git rev-parse --show-toplevel)" && rg_run_gate
  exit $?
fi
