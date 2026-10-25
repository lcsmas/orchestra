#!/usr/bin/env bash
# Verifier mutation runner (seat 1): mut.sh <name> <file> <old-string-file> <new-string-file> -- <command...>
# Verifies the mutant string LIVE (old occurs exactly once; after the edit new is present and old is not), runs the command, ALWAYS restores byte-exact and cmp's
# against the pre-mutation backup + `git diff --quiet` on the file. Prints MUTANT-RESULT name=… killed=yes|no cmd_rc=… restored=yes|no.
set -uo pipefail
NAME="$1"; FILE="$2"; OLDF="$3"; NEWF="$4"; shift 4; [[ "$1" == "--" ]] && shift
ROOT="$(git rev-parse --show-toplevel)"; cd "$ROOT" || exit 90
BK="$(mktemp -p "${TMPDIR:-/var/tmp}" "mut-$NAME.XXXXXX")"
cp -p "$FILE" "$BK"; SHA0="$(sha256sum "$FILE" | cut -d' ' -f1)"
restore() { cp -p "$BK" "$FILE"; cmp -s "$BK" "$FILE" && [[ "$(sha256sum "$FILE" | cut -d' ' -f1)" == "$SHA0" ]] && git diff --quiet -- "$FILE"; }
trap 'restore >/dev/null 2>&1' EXIT
python3 - "$FILE" "$OLDF" "$NEWF" <<'PY' || { echo "MUTANT-RESULT name=$NAME killed=n/a APPLY-FAILED"; restore; exit 91; }
import sys
f, o, n = sys.argv[1:4]
s = open(f).read(); old = open(o).read().rstrip('\n'); new = open(n).read().rstrip('\n')
if s.count(old) != 1: print(f"APPLY: old string occurs {s.count(old)}x (need exactly 1)"); sys.exit(1)
t = s.replace(old, new)
if old in t and old not in new: print("APPLY: old still present after edit"); sys.exit(1)
if new not in t: print("APPLY: new not present after edit"); sys.exit(1)
open(f, 'w').write(t); print(f"APPLY: ok ({len(old)}B -> {len(new)}B)")
PY
echo "MUTANT-DIFF $(git diff --stat -- "$FILE" | tail -1)"
"$@" > "$BK.out" 2>&1; RC=$?
tail -n "${MUT_TAIL:-12}" "$BK.out" | cut -c1-260
restore && R=yes || R=NO
echo "MUTANT-RESULT name=$NAME cmd_rc=$RC killed=$([[ $RC -ne 0 ]] && echo yes || echo NO) restored=$R sha256=$(sha256sum "$FILE" | cut -c1-12) (orig ${SHA0:0:12})"
trap - EXIT; rm -f "$BK" "$BK.out"
