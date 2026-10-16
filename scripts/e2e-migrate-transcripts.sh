#!/usr/bin/env bash
# #240 — every arm of scripts/e2e-migrate-transcripts.mjs against THIS tree (E2E_REPO to aim at another, e.g. a master worktree for the must-FAIL run).
# Scratch HOME/ORCHESTRA_HOME under $TMPDIR; never a live ~/.claude*. Exit 0 only if every arm passes (a rig that could not run is rc 3, never a pass).
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="${E2E_REPO:-$here}"
bad=0
for arm in slash tilde_default symlink shared_projects bindmount different concurrent_same concurrent_diff; do
  out="$(node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import "$repo/scripts/.r2-register.mjs" "$here/scripts/e2e-migrate-transcripts.mjs" "$arm" 2>&1)"
  rc=$?
  printf '%s\n' "$out" | grep -E '^(PASS|FAIL|RIG|[a-z_]+: [0-9]+/[0-9]+ clauses)' 
  [ "$rc" -eq 0 ] || { echo "ARM $arm: rc=$rc"; bad=$((bad+1)); }
done
echo "migrate-transcripts rig: $([ "$bad" -eq 0 ] && echo ALL ARMS PASS || echo "$bad ARM(S) NOT GREEN")"
exit "$bad"
