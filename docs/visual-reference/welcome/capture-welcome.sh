#!/usr/bin/env bash
# Capture the GTK welcome / no-workspace screen from a given binary.
#
# The welcome screen shows when the app has NO active workspace. The mock
# fixture always has rows and auto-selects one, so the drive clears the active
# workspace via the pane's mainpane.clear-active harness action. Headless sway only.
#
# Usage: capture-welcome.sh <binary> <out.png> <label>
set -euo pipefail

BIN="$1"; OUT="$2"; LABEL="$3"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO=/home/lmas/.orchestra/worktrees/orchestra-clever-orca-e97278a5
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-welcome.XXXXXX")"

APP_PID=""; SWAY_PID=""
STATUS=FAIL
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null || true
  if [ "$STATUS" = PASS ]; then rm -rf "$RUN"; else echo "FAIL — logs kept in $RUN" >&2; fi
}
trap cleanup EXIT

# shellcheck source=/dev/null
source "$REPO/native/env.sh"
[ -x "$BIN" ] || { echo "missing $BIN"; exit 1; }

echo "-- [$LABEL] starting headless sway (1600x1000)"
echo "output HEADLESS-1 resolution 1600x1000" > "$RUN/sway.conf"
before="$RUN/sockets-before"
ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort > "$before" || true
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= SWAYSOCK="$RUN/sway.sock" \
  setsid sway -c "$RUN/sway.conf" >"$RUN/sway.log" 2>&1 &
SWAY_PID=$!
WD=""
for _ in $(seq 1 50); do
  WD="$(ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort | comm -13 "$before" - | head -1)"
  [ -n "$WD" ] && break; sleep 0.2
done
[ -n "$WD" ] || { echo "headless sway produced no wayland socket"; exit 1; }
# NEVER the user's session.
[ "$WD" = "wayland-1" ] && { echo "refusing: got the user's session socket"; exit 1; }
echo "-- [$LABEL] headless sway up on $WD"

RC="$RUN/rc.sock"
ORCHESTRA_GTK_MOCK=1 GDK_BACKEND=wayland WAYLAND_DISPLAY="$WD" \
  setsid "$BIN" --remote-control "$RC" >"$RUN/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do
  [ -S "$RC" ] && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "app died early:"; cat "$RUN/app.log"; exit 1; }
  sleep 0.2
done
[ -S "$RC" ] || { echo "remote-control socket never appeared"; cat "$RUN/app.log"; exit 1; }
sleep 2

if python3 "$HERE/drive-welcome.py" "$RC" "$OUT" "$LABEL"; then
  STATUS=PASS
  echo "PASS [$LABEL] -> $OUT"
  echo "-- theme parser errors (0 expected; log kept either way):"
  grep -ci "theme parser error\|CSS.*error" "$RUN/app.log" || true
  cp "$RUN/app.log" "$(dirname "$OUT")/$LABEL-app.log"
else
  echo "-- app log tail:"; tail -30 "$RUN/app.log" || true
  exit 1
fi
