#!/usr/bin/env bash
# Capture the GTK main-pane + overlay surfaces against a REAL DAEMON.
#
# WHY NOT THE MOCK: Resources/Insights/Help were gated on a backend existing
# synchronously at init and were dead no-ops in every real session until the
# overlay-gating fix. Anyone who "verified" them did so under ORCHESTRA_GTK_MOCK,
# which is precisely the standard that failed. This script therefore runs the
# app with NO mock flag, against the real headless daemon (dist-electron/
# daemon.js) reading the SAME seeded store the Electron half reads — so the pair
# compares like with like AND the overlays see real backend data.
#
# The app auto-spawns the daemon itself: discovery finds no socket under the
# isolated ORCHESTRA_HOME, so it runs $ORCHESTRA_DAEMON_CMD (app.rs:351).
#
# Window size pinned to 1600x1000 to match capture-electron.sh — a pair captured
# at different sizes compares nothing. Runs inside a HEADLESS sway so no window
# ever reaches the user's desktop.
#
# Usage: docs/visual-reference/capture-gtk-mainpane.sh [outdir]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NATIVE="$REPO/native"
OUT="${1:-$HERE/mainpane}"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-mp-gtk.XXXXXX")"
HOME_DIR="$RUN/ohome"
mkdir -p "$OUT" "$HOME_DIR/.claude"

APP_PID=""; SWAY_PID=""
STATUS=FAIL
cleanup() {
  # Kill by RECORDED PID, never by pattern: pgrep/pkill -f inside this tool
  # matches its own wrapper shell.
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null || true
  sleep 0.5
  # The app was told to stop the daemon it spawned; sweep the home's socket too.
  if [ "$STATUS" = PASS ]; then rm -rf "$RUN"; else echo "FAIL — logs kept in $RUN" >&2; fi
}
trap cleanup EXIT

# shellcheck source=../../native/env.sh
source "$NATIVE/env.sh"
BIN="$NATIVE/target/release/orchestra-gtk"
[ -x "$BIN" ] || { echo "missing $BIN — run: source native/env.sh && cargo build -p orchestra-gtk --release --manifest-path native/Cargo.toml"; exit 1; }
[ -f "$REPO/dist-electron/daemon.js" ] || { echo "missing dist-electron/daemon.js — run: pnpm run build:daemon"; exit 1; }

echo "-- seeding the shared fixture into $HOME_DIR"
if [ "${ORCHESTRA_WELCOME_RUN:-0}" = "1" ]; then
  # EMPTY store, to STATE-MATCH the Electron welcome run. Electron's welcome
  # screen renders only when no workspace is active and its store auto-selects
  # workspaces[0], so its only honest welcome state is an empty store. Driving
  # GTK's clear-active against a SEEDED store would compare a populated sidebar
  # against an empty one — a mismatched pair is convincing and worthless.
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

echo "-- launching orchestra-gtk against a REAL daemon (no mock flag)"
RC="$RUN/rc.sock"
# NO ORCHESTRA_GTK_MOCK here — that is the whole point of this script.
GDK_BACKEND=wayland WAYLAND_DISPLAY="$WD" \
  ORCHESTRA_HOME="$HOME_DIR" HOME="$HOME_DIR" \
  ORCHESTRA_DAEMON_CMD="node $REPO/dist-electron/daemon.js" \
  "$BIN" --remote-control "$RC" --stop-daemon-on-exit >"$RUN/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do
  [ -S "$RC" ] && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "app died early:"; cat "$RUN/app.log"; exit 1; }
  sleep 0.2
done
[ -S "$RC" ] || { echo "remote-control socket never appeared"; cat "$RUN/app.log"; exit 1; }

# The attach flow is ASYNC (discovery -> spawn -> handshake). Wait for the
# daemon's UI socket to actually exist before driving, so "empty overlay"
# cannot simply mean "backend had not attached yet".
echo "-- waiting for the daemon's UI socket under the isolated home"
for _ in $(seq 1 100); do
  if find "$HOME_DIR" -maxdepth 2 -name '*.sock' 2>/dev/null | grep -q .; then break; fi
  sleep 0.3
done
find "$HOME_DIR" -maxdepth 2 -name '*.sock' 2>/dev/null | sed 's/^/   socket: /' || true
sleep 3  # first paint + attach + initial polls

if ORCHESTRA_CAPTURE_ROW="${ORCHESTRA_CAPTURE_ROW:-ws-row-ws-4}" \
   python3 "$HERE/drive-gtk-mainpane.py" "$RC" "$OUT"; then
  STATUS=PASS
  echo "PASS — gtk main-pane captures in $OUT"
  echo "-- app log tail (attach story):"; grep -iE 'attach|daemon|backend' "$RUN/app.log" | tail -8 || true
else
  echo "-- app log tail:"; tail -30 "$RUN/app.log" || true
  exit 1
fi
