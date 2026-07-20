#!/usr/bin/env bash
# M4-V0: capture the ELECTRON half of the visual reference pair.
#
# Seeds the shared fixture (seed-store.mjs — mirrors the GTK MockBackend) into a
# throwaway ORCHESTRA_HOME, launches Electron inside a HEADLESS sway (never on
# the user's desktop), and screenshots each surface over CDP.
#
# Window size is pinned to 1600x1000 to match capture-gtk.sh — a pair captured
# at different sizes compares nothing.
#
# Usage: docs/visual-reference/capture-electron.sh [outdir]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
OUT="${1:-$HERE/mainpane}"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-vref-electron.XXXXXX")"
HOME_DIR="$RUN/ohome"
PORT="${ORCHESTRA_DEBUG_PORT:-9377}"
mkdir -p "$OUT" "$HOME_DIR/.claude"

APP_PID=""; SWAY_PID=""
STATUS=FAIL
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null || true
  if [ "$STATUS" = PASS ]; then rm -rf "$RUN"; else echo "FAIL — logs kept in $RUN" >&2; fi
}
trap cleanup EXIT

[ -f "$REPO/dist-electron/main.js" ] || { echo "dist-electron missing — run: npx vite build"; exit 1; }

echo "-- seeding the shared fixture into $HOME_DIR"
if [ "${ORCHESTRA_WELCOME_RUN:-0}" = "1" ]; then
  # EMPTY store: the genuine first-run state the welcome screen serves. The
  # welcome screen renders only when no workspace is active (App.tsx:380) and
  # the store auto-selects workspaces[0] at boot, so a seeded run can never
  # show it. This is the honest state-match for GTK's mainpane.clear-active.
  mkdir -p "$HOME_DIR/userData/orchestra"
  echo '{"repos":[],"workspaces":[],"accounts":[],"selfTuneRuns":[]}' \
    > "$HOME_DIR/userData/orchestra/store.json"
  echo "-- seeded an EMPTY store (welcome-screen run)"
else
  node "$HERE/seed-store.mjs" "$HOME_DIR"
fi

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

echo "-- launching Electron (isolated home, CDP :$PORT)"
cd "$REPO"
WAYLAND_DISPLAY="$WD" ELECTRON_OZONE_PLATFORM_HINT=wayland \
  ORCHESTRA_HOME="$HOME_DIR" HOME="$HOME_DIR" ORCHESTRA_DEBUG_PORT="$PORT" \
  npx electron . --ozone-platform=wayland >"$RUN/app.log" 2>&1 &
APP_PID=$!

for _ in $(seq 1 100); do
  curl -sf "http://127.0.0.1:$PORT/json" >/dev/null 2>&1 && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "electron died early:"; cat "$RUN/app.log"; exit 1; }
  sleep 0.3
done
curl -sf "http://127.0.0.1:$PORT/json" >/dev/null || { echo "CDP never came up"; cat "$RUN/app.log"; exit 1; }
echo "-- CDP up; driving"

if node "$HERE/drive-electron-mainpane.mjs" "$PORT" "$OUT"; then
  STATUS=PASS
  echo "PASS — electron captures in $OUT"
else
  echo "-- app log tail:"; tail -20 "$RUN/app.log" || true
  exit 1
fi
