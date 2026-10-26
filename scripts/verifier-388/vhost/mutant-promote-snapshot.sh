#!/usr/bin/env bash
# Verifier seat 1: the POSITIVE CONTROL for the logout-vs-promotion arm — mutant "promote the event snapshot": persistSignIns() writes the cookie the EVENT carried instead of the
# live re-read one. Expect the sweep RED (hundreds of resurrections) while `ctl/ephemeral-workspace-never-resurrects` stays GREEN.
# usage (repo root, tree CLEAN, GUI slot free): mutant-promote-snapshot.sh [arm=vhost-sweep]
# Always ends with src byte-exact (cmp + git diff) and a CLEAN rebuild. NOTE: apply it on the source that holds the fix — if the fix replaced the find-string, adapt `old` below
# to the equivalent line (the mutant must reach the bundle; the arm RED is the proof).
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"; HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; ARM="${1:-vhost-sweep}"
F=src/main/browser-panel.ts; BK="$(mktemp)"; cp -p "$F" "$BK"
restore() { cp -p "$BK" "$F"; cmp -s "$BK" "$F" && git diff --quiet -- "$F"; }
trap 'restore >/dev/null 2>&1; rm -f "$ROOT"/scripts/zz-verifier-vhost.*' EXIT
[[ -z "$(git status --porcelain)" ]] || { echo "ABORT: tree not clean"; exit 2; }
python3 -I - "$F" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "        const p = own ? promoteSessionCookie(own, Date.now() / 1000) : null;"
assert s.count(old) == 1, f"find-string occurs {s.count(old)}x"
open(p, "w").write(s.replace(old, "        void own;\n        const p = promoteSessionCookie(cookie, Date.now() / 1000);"))
print("MUTANT applied (promote the event snapshot)")
PY
nice -n 10 pnpm run build:bundles >"${TMPDIR:-/var/tmp}/mut-promote-build.log" 2>&1
restore && echo "src restored byte-exact" || { echo "RESTORE FAILED"; exit 3; }
bash "$HERE/mk-vhost.sh" "$ROOT"
export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/v400-$(id -u)}" RIG_HIDE_REAL_RUNTIME=1
mkdir -p -m 700 "$E2E_RIG_BASE"
OUT="${TMPDIR:-/var/tmp}/mut-promote-out"; mkdir -p "$OUT"
set +e
/var/tmp/orch-1000-b17728/gui-slot.sh bash scripts/zz-verifier-vhost.sh "$ROOT" --arms "$ARM" --label verifier-mut-promote --out "$OUT" 2>&1 | grep -E '^(VERDICT|REFUSED|ABORT)|MEASURED \[vhost\]|\[vhost\] (logout-never|ctl/ephemeral|rotating)'
set -e
rm -f scripts/zz-verifier-vhost.*
nice -n 10 pnpm run build:bundles >"${TMPDIR:-/var/tmp}/mut-promote-clean.log" 2>&1 && echo "CLEAN rebuild done"
