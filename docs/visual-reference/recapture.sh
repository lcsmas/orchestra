#!/usr/bin/env bash
# Regenerate BOTH halves of the visual reference pair at the current HEAD and
# record their provenance, so the set can always answer "which commit am I?".
#
# Capturing one half alone is a trap: the pair's whole value is that both sides
# show the SAME state at the SAME size, so a half-regenerated set compares a
# fresh frontend against a stale one and calls the difference a parity defect.
# This wrapper exists so "regenerate the reference" is one command that cannot
# be done halfway.
#
# The row pin is NOT optional and NOT a retry knob. The app auto-selects a row
# at boot and WHICH row differs between BUILDS, not just between runs; a pair
# that quietly differs in selected row still looks like a rigorous comparison.
# Auto-selection only ever lands on TREE-TOP rows (orch-1, orch-scratch-kid,
# ws-2), so the pin must be a MID-LIST row that is never auto-selected.
# drive-gtk.py refuses an absent row and refuses an already-active one rather
# than falling back to a racy scan.
#
# Usage: docs/visual-reference/recapture.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
export ORCHESTRA_CAPTURE_ROW="${ORCHESTRA_CAPTURE_ROW:-ws-row-ws-4}"

if ! git -C "$REPO" diff --quiet HEAD -- native/orchestra-gtk src; then
  echo "WARNING: uncommitted changes under native/orchestra-gtk or src/." >&2
  echo "  The captures will show them, but the manifest will record HEAD — so the" >&2
  echo "  recorded provenance would be a lie. Commit first." >&2
  exit 1
fi

echo "== regenerating the visual reference pair at $(git -C "$REPO" rev-parse --short HEAD)"
echo "== pinned row: $ORCHESTRA_CAPTURE_ROW"

# Rebuild the artifacts the harnesses actually exec. capture-gtk.sh resolves
# target/RELEASE, and `cargo test` does NOT refresh it — a stale binary
# reproduces a false result perfectly.
echo "-- building orchestra-gtk (release — the binary capture-gtk.sh execs)"
# shellcheck source=../../native/env.sh
source "$REPO/native/env.sh"
cargo build -p orchestra-gtk --release --manifest-path "$REPO/native/Cargo.toml"

echo "-- building the Electron bundle"
(cd "$REPO" && npx vite build >/dev/null)

"$HERE/capture-gtk.sh" "$HERE"
"$HERE/capture-electron.sh" "$HERE"

node "$HERE/write-manifest.mjs" "$HERE"

# Prove the set we just wrote actually passes its own freshness check, rather
# than assuming it does because we just captured.
"$HERE/check-fresh.sh"
echo "== done"
