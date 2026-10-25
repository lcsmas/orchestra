#!/usr/bin/env bash
# Verifier #389 unit-level mutants (seat 1): one at a time via mut.sh against the keyring unit tests; prints the tests that reddened.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"; M="$TMPDIR/v1/mut389"
T=(src/shared/password-store.test.ts src/main/linux-keyring.test.ts src/main/secrets.test.ts src/main/keyring-wiring.test.ts src/shared/secrets-state.test.ts)
echo "unmutated: $(node --test --experimental-strip-types "${T[@]}" 2>&1 | grep -E '^# (tests|pass|fail|skipped)' | tr '\n' ' ')"
ONLY="${1:-}"
while IFS='|' read -r name file; do
  [[ -n "$ONLY" && "$name" != $ONLY ]] && continue
  out="$(MUT_TAIL=6000 bash "$TMPDIR/v1/rig/mut.sh" "$name" "$file" "$M/$name.old" "$M/$name.new" -- node --test --experimental-strip-types "${T[@]}" 2>&1)"
  echo "$out" | grep -E '^(APPLY|MUTANT-RESULT)' | sed -E 's/ restored=yes sha256=[0-9a-f]+ \(orig [0-9a-f]+\)/ restored=yes/' | tr '\n' ' '; echo
  echo "$out" | grep -E '^not ok' | head -3 | cut -c1-150 | sed 's/^/     /'
done < "$M/spec.txt"
git status --porcelain -uall | head -5; echo "tree clean check done"
