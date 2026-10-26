#!/usr/bin/env bash
# Verifier seat 1 (#400 fix gate): rebuilt-app mutants of the post-write reconciliation, each judged by MY logout-vs-promotion arm in the hidden world.
# usage (repo root, tree CLEAN, bundles + bus-abi built): run-fix-mutants.sh [arm=vhost-band] [mutant ...]   (default: all four)
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT"; V="$TMPDIR/v1"; ARM="${1:-vhost-band}"; shift || true
F=src/main/browser-panel.ts; BK="$(mktemp)"; cp -p "$F" "$BK"
restore() { cp -p "$BK" "$F"; cmp -s "$BK" "$F" && git diff --quiet -- "$F"; }
trap 'restore >/dev/null 2>&1; rm -f "$ROOT"/scripts/zz-verifier-vhost.*' EXIT
[[ -z "$(git status --porcelain)" ]] || { echo "ABORT: tree not clean"; exit 2; }
ALL=(snapshot p22-no-compensation only-immediate-removed only-settle-removed); LIST=("${@:-${ALL[@]}}")
export E2E_RIG_BASE=/var/tmp/v400-$(id -u) RIG_HIDE_REAL_RUNTIME=1; mkdir -p -m 700 "$E2E_RIG_BASE"
for m in "${LIST[@]}"; do
  python3 -I - "$F" "$m" <<'PY' || { echo "MUTANT $m: APPLY FAILED"; restore; continue; }
import sys
p, m = sys.argv[1:3]; s = open(p).read()
IMM = "        reconcile(key, p, domain, path, started);\n"
SETTLE = "        const t = setTimeout(() => {\n          settling.delete(t);\n          reconcile(key, p, domain, path, started);\n        }, RECONCILE_SETTLE_MS);\n        settling.add(t);\n"
M = {
  'snapshot': ("        const p = own ? promoteSessionCookie(own, Date.now() / 1000) : null;", "        void own;\n        const p = promoteSessionCookie(cookie, Date.now() / 1000);"),
  'p22-no-compensation': (IMM + SETTLE, ""),
  'only-immediate-removed': (IMM + SETTLE, SETTLE),
  'only-settle-removed': (IMM + SETTLE, IMM),
}
old, new = M[m]
assert s.count(old) == 1, f"{m}: find-string occurs {s.count(old)}x"
open(p, "w").write(s.replace(old, new)); print(f"MUTANT {m} applied")
PY
  nice -n 10 pnpm run build:bundles >"$V/fixmut-$m-build.log" 2>&1 || echo "build RC!=0"
  restore && echo "src restored byte-exact" || { echo "RESTORE FAILED"; exit 3; }
  bash "$V/rig/vhost/mk-vhost.sh" "$ROOT" >/dev/null
  /var/tmp/orch-1000-b17728/gui-slot.sh bash scripts/zz-verifier-vhost.sh "$ROOT" --arms "$ARM" --label "fixmut-$m" --out "$V/vhost-shots" > "$V/fixmut-$m-rig.log" 2>&1
  echo "RESULT $m: $(grep -E 'MEASURED \[vhost\] profile, logout' "$V/fixmut-$m-rig.log" | sed -E 's/.*RESURRECTED after logout: ([0-9]+).*/resurrected=\1/') | $(grep -E '\[vhost\] (logout-never|ctl/ephemeral|rotating)' "$V/fixmut-$m-rig.log" | sed -E 's/^ +//' | cut -c1-140 | tr '\n' ';')"
  rm -f scripts/zz-verifier-vhost.*
done
nice -n 10 pnpm run build:bundles >"$V/fixmut-clean-build.log" 2>&1 && echo "CLEAN rebuild done"
echo "FIXMUT-DONE"
