#!/usr/bin/env bash
# Verifier #389 FINAL mutants (seat 1): probe-hunk mutants vs MY live probe attacks; rig-world mutants vs the member's tests AND my adversarial table.
# usage: run389f.sh   (from inside the worktree). Every mutant: verified-live find-string, byte-exact restore + cmp (mut.sh). Unmutated controls before/after.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"; V="$TMPDIR/v1"; M="$V/mut389f"
PROBE=(node --no-warnings --experimental-strip-types "$V/rig/probe-final.mjs" "$PWD")
TABLE=(node --no-warnings --experimental-strip-types "$V/rig/attack-keyring-pure.mjs" "$PWD")
MEMBER=(node --test --experimental-strip-types src/shared/keyring-rig-world.test.ts src/main/keyring-rig-driver.test.ts src/main/rig-socket-paths.test.ts src/main/rig-paths.test.ts src/main/linux-keyring.test.ts)
ctl() { "$@" > "$V/ctl.out" 2>&1; echo "rc=$? $(grep -E '^(SUMMARY|# (pass|fail|skipped))' "$V/ctl.out" | tr '\n' ' ')"; }
echo "CONTROL(before) probe-final: $(ctl "${PROBE[@]}")"
echo "CONTROL(before) my table:    $(ctl "${TABLE[@]}")"
echo "CONTROL(before) member tests:$(ctl "${MEMBER[@]}")"
while IFS='|' read -r name file; do
  [[ -z "$name" ]] && continue
  if [[ "$name" == pm* ]]; then cmds=("probe-final"); elif [[ "$name" == pa* ]]; then cmds=("member-tests" "phys-final"); else cmds=("member-tests" "my-table"); fi
  line="$(printf '%-38s' "$name")"
  for c in "${cmds[@]}"; do
    case "$c" in probe-final) cmd=("${PROBE[@]}");; member-tests) cmd=("${MEMBER[@]}");; my-table) cmd=("${TABLE[@]}");; phys-final) cmd=(node "$V/rig/phys-final.mjs" "$PWD");; esac
    out="$(MUT_TAIL=4000 bash "$V/rig/mut.sh" "$name" "$file" "$M/$name.old" "$M/$name.new" -- "${cmd[@]}" 2>&1)"
    rc=$(sed -nE 's/.*cmd_rc=([0-9]+).*/\1/p' <<<"$out" | tail -1); rs=$(grep -c 'restored=yes' <<<"$out"); ap=$(grep -c '^APPLY: ok' <<<"$out")
    line+=" | $c: $([[ "$ap" == 1 ]] || echo NOAPPLY; [[ -n "$rc" && "$rc" != 0 ]] && echo KILLED || echo survived) restored=$rs"
    if [[ -n "$rc" && "$rc" != 0 ]]; then first="$(grep -E '^(BAD|not ok)' <<<"$out" | head -1 | cut -c1-110)"; [[ -n "$first" ]] && line+=" [$first]"; fi
  done
  echo "$line"
done < "$M/spec.txt"
echo "CONTROL(after) probe-final: $(ctl "${PROBE[@]}")"
echo "CONTROL(after) my table:    $(ctl "${TABLE[@]}")"
echo "CONTROL(after) member tests:$(ctl "${MEMBER[@]}")"
git status --porcelain -uall | head -5; echo "tree clean check done"
