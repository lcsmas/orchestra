#!/usr/bin/env bash
# T0 — PROVE THE DETECTOR CAN FIRE.
#
# A DETECTOR NOBODY HAS SEEN FAIL IS NOT A DETECTOR. A whole-window diff whose
# probe is silently broken reports every region as matching — and "no regions
# differ" is indistinguishable from a real pass while being far more dangerous,
# because it retires the gate. The failure mode of this instrument is EXACTLY
# the answer its users hope for, which is the case where a control stops being
# optional.
#
# So: inject a KNOWN colour defect into the GTK theme, rebuild, and require the
# diff to (a) rank that region and (b) report the injected value. Then restore,
# rebuild, and run clean. BOTH DIRECTIONS, SAME REPORT.
#
# CHOOSING THE INJECTION TARGET IS THE SUBTLE PART, and two wrong choices came
# first — both of which produced a FALSE "the detector is broken" verdict:
#
#   1. Wrong SELECTOR FORM. `#main-area` is a GTK CSS *name* selector; the theme
#      styles that widget by CLASS (`.main-area`, theme.css:45/1075). The rule
#      parsed cleanly and did nothing — GTK CSS's third outcome, accepted and
#      inert, indistinguishable from "applied" by any validity check.
#
#   2. Wrong SURFACE. Even with `.main-area` correct, the injection still did not
#      show: main-area is almost entirely OCCLUDED by its own children
#      (`#terminal-stack`, `.term-scroll`, which paint @bg / #0b0d10 over it), so
#      its 94.4%-dominant reading was never main-area's own fill. Proof: a scan
#      of the whole composited frame found ZERO magenta pixels — the mutation
#      never reached the screen, so the probe was right to report no change.
#
# The lesson generalises past this script: a mutation test whose mutation does
# not actually alter the observable is not a weaker test, it is an INVERTED one —
# it accuses a working instrument. So the target is a real painting surface and
# the assertion requires the sentinel to appear IN THE FRAME, not merely in the
# binary.
#
#   3. Third constraint, added when the harness learned to reject uncomparable
#      regions: the target must be COMPARABLE. `.sidebar-footer` was the target
#      until the oracle started resolving paint provenance — it has NO
#      background rule of its own (styles.css:1005) and inherits `.sidebar`'s
#      gradient, so it is now correctly UNCOMPARABLE and never enters the
#      ranking. Asserting on it would have made this proof fail for a reason
#      unrelated to detection. The target is now `.sidebar` itself: hops=0, a
#      real gradient rule on the element, 70.6% dominance.
#
# It is also a region the harness reports as MATCHING at rest (Δ3, within
# threshold), so the test cannot pass on a pre-existing defect.
#
# Usage: prove-detector.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
CSS="$REPO/native/orchestra-gtk/src/theme.css"
BACKUP="$(mktemp /tmp/theme-css-backup.XXXXXX)"
SENTINEL="rgb(255,0,255)"   # magenta: impossible as a real theme value

# LOGS GO IN A PER-RUN PRIVATE DIR, NOT SHARED /tmp PATHS.
# The first version wrote /tmp/prove-{build-,}{dirty,clean}.log — fixed names on
# a machine where ~50 sibling agents run this same checked-in script. A sibling
# DID overwrite them: reading the shared build log after my own run showed
# a `Compiling` line from ANOTHER WORKTREE entirely. That is the worst shape a
# corruption can take — the file still parses, still looks like a build log, and
# a verdict read out of it is confidently wrong about the wrong subject. Nothing
# fails; the evidence is simply someone else's.
LOGDIR="$(mktemp -d "${XDG_RUNTIME_DIR:-/tmp}/prove-detector.XXXXXX")"

restore() {
  if [ -f "$BACKUP" ]; then
    cp "$BACKUP" "$CSS"
    rm -f "$BACKUP"
    echo "-- theme.css restored"
  fi
}
trap restore EXIT

cp "$CSS" "$BACKUP"

echo "============================================================"
echo "STEP 1 — inject a known defect into the GTK main pane"
echo "============================================================"
# Append an override so the injection cannot depend on matching an existing
# rule's exact text (which would break silently when the theme is edited).
# Appended LAST so it wins on order at equal specificity over the existing
# `.sidebar` rules.
cat >> "$CSS" <<EOF

/* ---- FAULT INJECTION (prove-detector.sh) — removed on restore ---- */
.sidebar { background-color: $SENTINEL; }
EOF

# Verify the injection reached the FILE before building (an append that failed
# would otherwise produce a "detector did not fire" that is really a setup bug).
if ! python3 -c "
import sys
s=open('$CSS').read()
sys.exit(0 if '$SENTINEL' in s else 1)
"; then
  echo "FAIL: sentinel never reached theme.css — setup bug, not a detector result"
  exit 1
fi
echo "-- sentinel $SENTINEL present in theme.css"

echo "-- rebuilding (theme.css is include_str!-embedded: a source edit is"
echo "   INVISIBLE to the running binary until it is recompiled)"
cd "$REPO"
# shellcheck source=../../../native/env.sh
source "$REPO/native/env.sh"
set +e
cargo build -p orchestra-gtk --release --manifest-path "$REPO/native/Cargo.toml" \
  > "$LOGDIR"/prove-build-dirty.log 2>&1
BUILD_RC=$?
set -e
[ "$BUILD_RC" -eq 0 ] || { echo "FAIL: build failed"; tail -20 "$LOGDIR"/prove-build-dirty.log; exit 1; }

# VERIFY BY CONTENT, NOT MTIME. "Did I rebuild" is not the question; "is the
# thing I am about to execute the thing I edited" is. Paired with a
# known-present positive control, because 0 hits and "the reader found nothing
# at all" are otherwise indistinguishable.
python3 - <<PY || { echo "FAIL: sentinel is NOT in the built binary — testing a stale artifact"; exit 1; }
import sys
d = open("$REPO/native/target/release/orchestra-gtk", "rb").read()
sentinel = d.count(b"255,0,255")
control  = d.count(b"main-area")          # known-present positive control
print(f"   binary check: sentinel={sentinel}  control(main-area)={control}")
sys.exit(0 if sentinel > 0 and control > 0 else 1)
PY
echo "-- injected binary confirmed by CONTENT"

echo
echo "-- running the diff against the DEFECTIVE build"
set +e
"$HERE/run-diff.sh" "$HERE/out-dirty" > "$LOGDIR"/prove-dirty.log 2>&1
DIRTY_RC=$?
set -e

# DISTINGUISH "THE HARNESS DID NOT RUN" FROM "THE DETECTOR DID NOT FIRE".
# These are opposite conclusions with opposite consequences, and they are
# trivially confusable: the first version of this script printed "THE DETECTOR
# DID NOT FIRE — every clean result is worthless" when the real cause was a CDP
# port collision, i.e. the harness never reached the subject at all. A false
# claim about a DETECTION TOOL is the expensive kind of wrong: it gets a real
# gate disabled. Exit code 1 means "regions differ" (the expected result here);
# anything else, or a missing result file, is a SETUP failure.
if [ ! -f "$HERE/out-dirty/diff-result.json" ]; then
  echo
  echo "SETUP FAILURE (not a detector verdict): the diff produced no result file."
  echo "The harness never reached the subject, so this run says NOTHING about"
  echo "whether the detector works. Cause, from the run log:"
  python3 - <<PY
lines = open("$LOGDIR/prove-dirty.log", errors="replace").read().splitlines()
skip = ("at ", "task:", "config:", "baseDir", "binary:", "maxConcurrent",
        "trimmed:", "}", "{", ")")
for l in lines:
    s = l.strip()
    if s and not s.startswith(skip) and "simple-git" not in s \
       and "GitConstructError" not in s:
        print("   " + l[:160])
PY
  exit 2
fi
if [ "$DIRTY_RC" -ne 1 ]; then
  echo "SETUP FAILURE (not a detector verdict): diff exited $DIRTY_RC, expected 1"
  exit 2
fi
sed -n '/RANKED REGION/,/^$/p' "$LOGDIR"/prove-dirty.log || true

# THE ASSERTION: the injected region must be RANKED and carry the injected
# value. Merely "the run exited nonzero" would also be satisfied by the
# pre-existing defects, so it proves nothing about detection.
python3 - <<PY || { echo; echo "FAIL: THE DETECTOR DID NOT FIRE on an injected defect."; echo "      Every clean result it produces is therefore worthless."; exit 1; }
import json, sys
sys.path.insert(0, "$HERE")
from framescan import read_png, count_magenta

# GATE 0 — DID THE MUTATION REACH THE SCREEN AT ALL?
# Without this, a mutation that silently fails to paint (wrong selector form,
# an occluding child) is reported as "the detector is broken" — an inverted
# test that accuses a working instrument. Both of those happened before this
# gate existed. A sentinel absent from the FRAME means the setup failed, which
# is a different conclusion with a different fix than a detector that missed it.
w, h, px = read_png("$HERE/out-dirty/gtk-frame.png")
mag = count_magenta(px)
print(f"   sentinel pixels in the composited frame: {mag}")
if mag == 0:
    print("   SETUP FAILURE, NOT A DETECTOR VERDICT: the injected colour never")
    print("   painted (inert selector, or the surface is occluded by a child).")
    print("   This run says nothing about whether the detector works.")
    sys.exit(2)

# GATE 1 — did the DIFF rank it and report the injected value?
d = json.load(open("$HERE/out-dirty/diff-result.json"))
row = next((r for r in d["rows"] if r["id"] == "sidebar-body"), None)
if row is None:
    print("   sidebar-body was not compared at all")
    sys.exit(1)
print(f"   sidebar-body: gtk=rgb{tuple(row['gtk'])} delta={row['delta']}")
ok = tuple(row["gtk"]) == (255, 0, 255) and row["delta"] > d["threshold"]
print("   DETECTOR FIRED" if ok else "   detector did NOT report the injected colour")
sys.exit(0 if ok else 1)
PY
echo "-- STEP 1 PASS: the diff detects an injected defect"

echo
echo "============================================================"
echo "STEP 2 — restore, rebuild, and confirm the region goes clean"
echo "============================================================"
restore
# RC captured on its OWN line. `cmd; [ $? -eq 0 ]` under `set -e` is doubly
# broken: set -e already aborts on failure so the test never runs, and if it did
# run after any intervening command it would read THAT command's code.
set +e
cargo build -p orchestra-gtk --release --manifest-path "$REPO/native/Cargo.toml" \
  > "$LOGDIR"/prove-build-clean.log 2>&1
CLEAN_BUILD_RC=$?
set -e
[ "$CLEAN_BUILD_RC" -eq 0 ] || { echo "FAIL: clean rebuild failed"; tail -20 "$LOGDIR"/prove-build-clean.log; exit 1; }

python3 - <<PY || { echo "FAIL: sentinel still in the binary after restore"; exit 1; }
import sys
d = open("$REPO/native/target/release/orchestra-gtk", "rb").read()
sentinel = d.count(b"255,0,255")
control  = d.count(b"main-area")
print(f"   binary check: sentinel={sentinel} (want 0)  control={control} (want >0)")
sys.exit(0 if sentinel == 0 and control > 0 else 1)
PY

set +e
"$HERE/run-diff.sh" "$HERE/out-clean" > "$LOGDIR"/prove-clean.log 2>&1
set -e

python3 - <<PY || { echo "FAIL: sidebar-body did not return to matching after restore"; exit 1; }
import json, sys
sys.path.insert(0, "$HERE")
from framescan import read_png, count_magenta

w, h, px = read_png("$HERE/out-clean/gtk-frame.png")
mag = count_magenta(px)
print(f"   sentinel pixels in the clean frame: {mag} (want 0)")
if mag != 0:
    print("   the injected colour is STILL painting — restore did not take")
    sys.exit(1)

d = json.load(open("$HERE/out-clean/diff-result.json"))
row = next((r for r in d["rows"] if r["id"] == "sidebar-body"), None)
if row is None:
    print("   sidebar-body missing from the clean run")
    sys.exit(1)
print(f"   sidebar-body: gtk=rgb{tuple(row['gtk'])} delta={row['delta']}")
sys.exit(0 if row["delta"] <= d["threshold"] else 1)
PY
echo "-- STEP 2 PASS: the same region reads clean once the defect is removed"

echo
echo "============================================================"
echo "BOTH DIRECTIONS PROVEN — the detector fires on a defect and"
echo "clears when it is removed. Its clean results carry weight."
echo "============================================================"
