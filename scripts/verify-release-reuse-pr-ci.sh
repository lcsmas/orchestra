#!/usr/bin/env bash
# verify-release-reuse-pr-ci.sh — rig for the release gate's rule 1 (reuse-pr-ci): rg_full_ci_check accepts a green pull_request ci.yml run when its
# MERGE-REF tree == the tag's tree (version line masked). Scratch repo + bare origin + fake `gh`; nothing real is run or pushed.
# Arms: same_tree -> reuse (rc 0, names the mutant caveat, no dispatch); other_tree (base moved) -> dispatch; red_pr_run -> dispatch; not_ancestor (squash) -> dispatch.
set -uo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${RG_RIG_BASE:-${TMPDIR:-/tmp}}"; mkdir -p "$BASE"
W="$(mktemp -d "$BASE/reuse-pr-ci.XXXXXX")"; trap 'rm -rf "$W"' EXIT
FAILS=0; N=0
ok() { N=$((N+1)); echo "  ok   $1"; }; ko() { N=$((N+1)); FAILS=$((FAILS+1)); echo "  FAIL $1 — $2"; }
G() { git -C "$W/wt" -c user.email=r@r -c user.name=r "$@"; }

git init -q --bare "$W/origin.git"; git -C "$W/origin.git" config uploadpack.allowAnySHA1InWant true
git init -q -b master "$W/wt"; G remote add origin "$W/origin.git"
printf '{\n  "name": "x",\n  "version": "1.0.0"\n}\n' > "$W/wt/package.json"; echo base > "$W/wt/f"
G add -A; G commit -qm base; BASE_SHA="$(G rev-parse HEAD)"
G checkout -q -b pr; echo pr > "$W/wt/pr.txt"; G add -A; G commit -qm pr; PR_SHA="$(G rev-parse HEAD)"
G checkout -q master
# the merge GitHub tested (refs/pull/9/merge) — a real merge commit, published so `git fetch origin <sha>` finds it
G merge -q --no-ff -m "Merge $PR_SHA into $BASE_SHA" pr; MERGE_SHA="$(G rev-parse HEAD)"
G push -q origin "$MERGE_SHA:refs/heads/tested-merge"; G push -q origin pr
mk_tag_commit() { # bump the version line on top of HEAD
  sed -i 's/"version": "1.0.0"/"version": "1.0.1"/' "$W/wt/package.json"; G commit -qam bump; }

mkdir -p "$W/bin"
cat > "$W/bin/gh" <<'GH'
#!/usr/bin/env bash
echo "$*" >> "$RG_FX_LOG"
case "$*" in
  "run list --workflow ci.yml --event pull_request --status success"*)
    [ "${RG_FX_RED:-0}" = 1 ] && { echo '[]'; exit 0; }
    printf '[{"databaseId":1,"headSha":"%s","url":"https://example.invalid/pr-run/1"}]\n' "$RG_FX_PR"; exit 0 ;;
  "run list --workflow ci.yml --event workflow_dispatch --branch"*)
    if grep -q '^workflow run' "$RG_FX_LOG"; then printf '[{"databaseId":77,"headSha":"%s","status":"in_progress","conclusion":"","url":"https://example.invalid/run/77"}]\n' "$(git rev-parse HEAD)"; else echo '[]'; fi; exit 0 ;;
  "run list --workflow ci.yml --status success"*|"run list --workflow mutants.yml --status success"*) echo '[]'; exit 0 ;;
  "api repos/{owner}/{repo}/actions/runs/1/jobs"*) echo 5; exit 0 ;;
  "api repos/{owner}/{repo}/actions/jobs/5/logs"*) echo "git -c protocol.version=2 fetch --no-tags origin +$RG_FX_MERGE:refs/remotes/pull/9/merge"; exit 0 ;;
  "workflow run ci.yml"*) exit 0 ;;
  "run view 77"*) echo '{"status":"completed","conclusion":"success"}'; exit 0 ;;
esac
echo "rig gh stub: unexpected: $*" >&2; exit 9
GH
chmod +x "$W/bin/gh"

run_check() { # name expected-rc substring-in-output substring-in-gh-log(or '!x' = absent) — runs rg_full_ci_check at the wt HEAD
  local name="$1" rc="$2" want="$3" glog="$4" out got
  : > "$W/log"
  out="$(cd "$W/wt" && RG_GH="$W/bin/gh" RG_FX_LOG="$W/log" RG_FX_PR="$PR_SHA" RG_FX_MERGE="$MERGE_SHA" RG_FULL_CI_POLL=0 RG_FULL_CI_WAIT=20 \
    bash -c 'source "$1/scripts/release-gate.sh"; _rg_refuse() { echo "REFUSED $*" >&2; }; rg_full_ci_check' _ "$REPO" 2>&1)"; got=$?
  if [ "$got" != "$rc" ]; then ko "$name" "rc=$got want $rc: $(printf '%s' "$out" | tail -2 | tr '\n' '|')"; return; fi
  [[ "$out" == *"$want"* ]] || { ko "$name" "output lacks [$want]: $(printf '%s' "$out" | tail -2 | tr '\n' '|')"; return; }
  case "$glog" in !*) grep -q -- "${glog#!}" "$W/log" && { ko "$name" "gh log has [${glog#!}]"; return; } ;; *) grep -q -- "$glog" "$W/log" || { ko "$name" "gh log lacks [$glog]"; return; } ;; esac
  ok "$name"
}

# same_tree: master == the tested merge + a version bump (tree equal modulo the version line) -> reuse, no dispatch
mk_tag_commit
run_check same_tree 0 "mutant rigs NOT in this run" '!workflow run'
# red_pr_run: the only PR run is not green (gh --status success lists nothing) -> falls through to the dispatch
G push -q origin HEAD:refs/heads/master -f
RG_FX_RED=1 run_check red_pr_run 0 "dispatched by the release" 'workflow run ci.yml'
# other_tree: master moved after the PR ran (a commit not in the tested merge) -> trees differ -> dispatch
echo moved > "$W/wt/moved.txt"; G add -A; G commit -qm moved; G push -q origin HEAD:refs/heads/master -f
run_check other_tree 0 "dispatched by the release" 'workflow run ci.yml'
# not_ancestor: the PR head is not reachable from HEAD (squash merge) -> never read, dispatch
G checkout -q -b squash "$BASE_SHA"; echo sq > "$W/wt/pr.txt"; G add -A; G commit -qm squash; G push -q origin HEAD:refs/heads/master -f
run_check not_ancestor 0 "dispatched by the release" '!actions/jobs'

echo "release-reuse-pr-ci: $((N-FAILS))/$N"
[ "$FAILS" = 0 ] && echo "RELEASE-REUSE-PR-CI: ALL PASS ($N/$N)" || exit 1
