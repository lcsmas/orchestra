#!/usr/bin/env bash
# M4-V0: capture the GTK half of the visual reference pair.
#
# Runs orchestra-gtk in MOCK mode (ORCHESTRA_GTK_MOCK=1) so it serves the
# compiled-in MockBackend fixture — the SAME state seed-store.mjs mirrors into
# the Electron store. Drives it over the --remote-control harness socket.
#
# Window size is pinned to 1600x1000 to match capture-electron.sh; the app is
# launched inside a HEADLESS sway so no window ever reaches the user's desktop.
# NOTE: sway must pick its OWN wayland-N socket (a bare `sway -c /dev/null`
# yields no display and the app dies with "Failed to open display"), and the
# config MUST set an output resolution.
#
# Usage: docs/visual-reference/capture-gtk.sh [outdir]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NATIVE="$REPO/native"
OUT="${1:-$HERE}"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-vref-gtk.XXXXXX")"
mkdir -p "$OUT"

APP_PID=""; SWAY_PID=""
STATUS=FAIL
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null || true
  if [ "$STATUS" = PASS ]; then rm -rf "$RUN"; else echo "FAIL — logs kept in $RUN" >&2; fi
}
trap cleanup EXIT

# shellcheck source=../../native/env.sh
source "$NATIVE/env.sh"
BIN="$NATIVE/target/release/orchestra-gtk"
[ -x "$BIN" ] || { echo "missing $BIN — run: source native/env.sh && cargo build -p orchestra-gtk --release --manifest-path native/Cargo.toml"; exit 1; }

echo "-- starting headless sway (1600x1000)"
echo "output HEADLESS-1 resolution 1600x1000" > "$RUN/sway.conf"
before="$RUN/sockets-before"; ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort > "$before" || true
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= SWAYSOCK="$RUN/sway.sock" \
  sway -c "$RUN/sway.conf" >"$RUN/sway.log" 2>&1 &
SWAY_PID=$!
WD=""
for _ in $(seq 1 50); do
  WD="$(ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort | comm -13 "$before" - | head -1)"
  [ -n "$WD" ] && break; sleep 0.2
done
[ -n "$WD" ] || { echo "headless sway produced no wayland socket"; exit 1; }
echo "-- headless sway up on $WD"

echo "-- launching orchestra-gtk (MOCK fixture)"
RC="$RUN/rc.sock"
# ORCHESTRA_HOME is NOT optional, and its absence was a real measurement bug.
#
# orchestra-gtk persists `sidebarWidth` to $ORCHESTRA_HOME/gtk-ui-state.json and
# restores it at startup (app.rs:729). Without this line the capture inherited
# the DEVELOPER'S OWN ~/.orchestra — so whatever width anyone had last dragged
# their sidebar to became the "measured" GTK width on every run.
#
# That is exactly what produced DESIGN-SYSTEM-AUDIT defect 3: captures showed a
# 518px sidebar against Electron's 337px and it was attributed to the header
# labels. A controlled A/B (same binary, same compositor, only the state file
# differing) gave 518px with the stale file and 338px with an empty home. The
# port's real width was always ~338px; the 179px "regression" was this leak.
#
# The Electron half already isolates its home for the same reason. A capture
# that reads developer state is not reproducible, and it fails SILENTLY — the
# number looks plausible, so it gets acted on rather than investigated.
export ORCHESTRA_HOME="$RUN/gtk-home"
mkdir -p "$ORCHESTRA_HOME"
ORCHESTRA_GTK_MOCK=1 GDK_BACKEND=wayland WAYLAND_DISPLAY="$WD" \
  "$BIN" --remote-control "$RC" >"$RUN/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do
  [ -S "$RC" ] && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "app died early:"; cat "$RUN/app.log"; exit 1; }
  sleep 0.2
done
[ -S "$RC" ] || { echo "remote-control socket never appeared"; cat "$RUN/app.log"; exit 1; }
sleep 2  # first paint + fixture render

if python3 "$HERE/drive-gtk.py" "$RC" "$OUT"; then
  STATUS=PASS
  echo "PASS — gtk captures in $OUT"
else
  echo "-- app log tail:"; tail -20 "$RUN/app.log" || true
  exit 1
fi
