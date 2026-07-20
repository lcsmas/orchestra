#!/usr/bin/env bash
# Regenerate the SHARED-BACKEND visual-reference pair (both frontends on ONE
# Electron backend, so the data is identical by construction) and record its
# provenance.
#
# This is the sibling of recapture.sh. recapture.sh regenerates the MOCK pair
# (GTK on its compiled-in fixture, Electron on the real backend against absent
# repos) — a pair that exercises the rich pill zoo but whose two halves show
# DIFFERENT data, so most of its "differences" are state, not rendering. This
# script regenerates the pair whose halves show the SAME data, so every
# remaining difference is a real rendering / layout / feature difference. Keep
# BOTH: the mock pair is the deterministic E2E reference and the only one that
# renders the pill zoo; the shared pair is the only one that is apples-to-apples.
#
# Output goes to docs/visual-reference/real-backend/ so it never overwrites the
# top-level mock pair. A separate CAPTURED-AT.json there records provenance the
# same way, and check-fresh.sh --dir can be pointed at it.
#
# The row pin (recapture.sh's rationale applies verbatim): the app auto-selects
# a row at boot and WHICH row differs between builds, so a pair that quietly
# differs in selected row still looks rigorous. ws-row-ws-3 (chime-volume) is
# present under the same id/name on both halves and is not auto-selected.
#
# Usage: docs/visual-reference/recapture-real.sh
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="$HERE/real-backend"
export ORCHESTRA_CAPTURE_ROW="${ORCHESTRA_CAPTURE_ROW:-ws-row-ws-3}"

if ! git -C "$REPO" diff --quiet HEAD -- native/orchestra-gtk src; then
  echo "WARNING: uncommitted changes under native/orchestra-gtk or src/." >&2
  echo "  The captures will show them, but the manifest will record HEAD — so the" >&2
  echo "  recorded provenance would be a lie. Commit first." >&2
  exit 1
fi

mkdir -p "$OUT"
echo "== regenerating the SHARED-BACKEND pair at $(git -C "$REPO" rev-parse --short HEAD)"
echo "== pinned row: $ORCHESTRA_CAPTURE_ROW"

# Rebuild the artifacts the capture actually execs (same discipline as
# recapture.sh): capture-real-pair.sh runs the RELEASE gtk binary and the
# Electron bundle, and neither `cargo test` nor a stale dist refreshes them.
echo "-- building orchestra-gtk (release — the binary the capture execs)"
# shellcheck source=../../native/env.sh
source "$REPO/native/env.sh"
cargo build -p orchestra-gtk --release --manifest-path "$REPO/native/Cargo.toml"

echo "-- building the Electron bundle"
(cd "$REPO" && npx vite build >/dev/null)

"$HERE/capture-real-pair.sh" "$OUT"

node "$HERE/write-manifest.mjs" "$OUT"

echo "== done — shared-backend pair + manifest written to $OUT"
