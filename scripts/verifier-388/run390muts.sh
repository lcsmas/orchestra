#!/usr/bin/env bash
# Verifier #390 mutant runner (seat 1): one mutant at a time via mut.sh, each against the test/arm meant to redden it; prints the first failing lines.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"; M="$TMPDIR/v1/mut390"
UNIT=(node --test --experimental-strip-types src/shared/keeper-runtime.test.ts src/main/keeper-runtime-install.test.ts)
rig() { echo node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --import ./scripts/.r2-register.mjs scripts/e2e-pinned-node.mjs "$1"; }
declare -A CMD=(
  [a-noexec-default-true]="rig:noexec_bin_refused"
  [b-install-hash-off]="unit" [c-install-arch-off]="unit" [d-picker-bundled-off]="unit" [e-path-node-everywhere]="unit"
  [f-pack-hash-off]="rig:pack_corrupt_byte" [g-pack-size-off]="rig:pack_truncated" [h-pack-exec-bit-off]="rig:pack_not_executable" [i-pack-manifest-off]="rig:pack_manifest_mismatch"
  [j-smoke-version-off]="rig:smoke_wrong_version" [k-smoke-exe-identity-off]="rig:smoke_exec_proxy"
  [l-dl-tarball-hash-off]="rig:fetch_corrupt_download" [m-cache-tarball-hash-off]="rig:fetch_poisoned_cache" [n-extracted-hash-off]="rig:extract_binary_tamper"
)
ONLY="${1:-}"
while IFS='|' read -r name file; do
  [[ -n "$ONLY" && "$name" != $ONLY ]] && continue
  c="${CMD[$name]:-}"; [[ -z "$c" ]] && { echo "SKIP $name (packaged: run separately)"; continue; }
  if [[ "$c" == unit ]]; then cmd=("${UNIT[@]}"); else cmd=($(rig "${c#rig:}")); fi
  out="$(MUT_TAIL=4000 bash "$TMPDIR/v1/rig/mut.sh" "$name" "$file" "$M/$name.old" "$M/$name.new" -- "${cmd[@]}" 2>&1)"
  echo "$out" | grep -E '^(APPLY|MUTANT-RESULT)' | tr '\n' ' '; echo
  echo "$out" | grep -E '^(not ok|PINNED-NODE: (FAIL|ALL)|FAIL )|PINNED-NODE.*FAIL|^  *FAIL' | head -4 | cut -c1-200 | sed 's/^/     /'
done < "$M/spec.txt"
git status --porcelain -uall | head -5; echo "tree clean check done"
