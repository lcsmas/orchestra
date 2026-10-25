#!/usr/bin/env bash
# Run the verifier's #392 mutants one at a time against the census test file; restore + cmp each time.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"; M="$TMPDIR/v1/mut392"
echo "baseline (unmutated) x1: $(node --test --experimental-strip-types src/shared/browser-usage-census.test.ts 2>&1 | grep -E '^# (pass|fail|skipped)' | tr '\n' ' ')"
for o in "$M"/*.old; do n="$(basename "$o" .old)"
  out="$(MUT_TAIL=3000 bash "$TMPDIR/v1/rig/mut.sh" "$n" scripts/browser-usage-census.mjs "$o" "${o%.old}.new" -- node --test --experimental-strip-types src/shared/browser-usage-census.test.ts 2>&1)"
  echo "$out" | grep -E '^(APPLY|MUTANT-RESULT)' | tr '\n' ' '; echo; echo "$out" | grep -E '^not ok' | cut -c1-110 | sed 's/^/     reddened: /'
done
git status --porcelain | head -3; echo "tree clean check done"
