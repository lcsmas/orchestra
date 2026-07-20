#!/usr/bin/env bash
# T2 — launch orchestra-gtk headless and measure the rendered type of each role.
#
# Launch recipe is capture-gtk.sh's, for the reasons documented there:
# headless sway picks its OWN wayland socket, and ORCHESTRA_HOME is isolated so
# the run cannot inherit developer state.
#
# Usage: measure-type-gtk.sh <out.json>
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NATIVE="$REPO/native"
OUT="${1:-$HERE/type-gtk.json}"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-type-gtk.XXXXXX")"

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
[ -x "$BIN" ] || { echo "missing $BIN"; exit 1; }

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

RC="$RUN/rc.sock"
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

# Record the font environment the measurement ran under. A type comparison is
# only meaningful if BOTH sides resolved their families against the same
# fontconfig set, and "which fonts existed" is otherwise invisible in the
# output — a substituted family looks exactly like an authored one.
{
  echo "gtk-font-name: $(gsettings get org.gnome.desktop.interface font-name 2>/dev/null)"
  echo "Inter installed: $(fc-list 'Inter' family | head -1 | wc -l)"
  echo "Cantarell installed: $(fc-list 'Cantarell' family | head -1 | wc -l)"
  echo "Adwaita Sans installed: $(fc-list 'Adwaita Sans' family | head -1 | wc -l)"
} > "$OUT.fontenv.txt"

if python3 "$HERE/measure-type-gtk.py" "$RC" "$OUT"; then
  STATUS=PASS
  echo "PASS — $OUT"
else
  echo "-- app log tail:"; tail -20 "$RUN/app.log" || true
  exit 1
fi
