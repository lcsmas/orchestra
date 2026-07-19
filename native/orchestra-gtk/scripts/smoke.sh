#!/usr/bin/env bash
# Smoke test for the GTK skeleton (plan §8.4): build, launch in mock mode
# inside a FRESH headless sway compositor (never the user's desktop), drive
# the remote-control harness, assert the window title + the real sidebar's
# section/tree/repo rows render, capture a screenshot, print PASS/FAIL.
#
# For the deeper sidebar interaction scenarios (select / collapse / rename /
# reorder with a screenshot per state) see the sibling sidebar_e2e.sh.
#
# Headless sway's seat advertises no pointer/keyboard, so compositor-level
# input never reaches the client — the harness synthesizes events GTK-side
# (see src/remote_control.rs). That limitation is exactly why the harness
# exists.
#
# Artifacts: native/target/smoke/smoke.png (+ sway/app logs in the run dir,
# kept on failure).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/../.." && pwd)"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-gtk-smoke.XXXXXX")"
ART="$NATIVE/target/smoke"
mkdir -p "$ART" "$RUN/home"

APP_PID=""
SWAY_PID=""
STATUS=FAIL
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null || true
  if [ "$STATUS" = PASS ]; then
    rm -rf "$RUN"
  else
    echo "FAIL — logs kept in $RUN" >&2
  fi
}
trap cleanup EXIT

# shellcheck source=../../env.sh
source "$NATIVE/env.sh"
echo "-- building orchestra-gtk"
cargo build -p orchestra-gtk --manifest-path "$NATIVE/Cargo.toml"

echo "-- starting headless sway"
echo "output HEADLESS-1 resolution 1600x1000" > "$RUN/sway.conf"
before="$RUN/sockets-before"; ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort > "$before" || true
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= SWAYSOCK="$RUN/sway.sock" \
  sway -c "$RUN/sway.conf" >"$RUN/sway.log" 2>&1 &
SWAY_PID=$!

WD=""
for _ in $(seq 1 50); do
  WD="$(ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort | comm -13 "$before" - | head -1)"
  [ -n "$WD" ] && break
  sleep 0.2
done
[ -n "$WD" ] || { echo "headless sway produced no wayland socket (see $RUN/sway.log)"; exit 1; }
echo "-- headless sway up on $WD"

echo "-- launching orchestra-gtk (mock mode + remote control)"
RC="$RUN/rc.sock"
ORCHESTRA_HOME="$RUN/home" ORCHESTRA_GTK_MOCK=1 \
  GDK_BACKEND=wayland WAYLAND_DISPLAY="$WD" \
  "$NATIVE/target/debug/orchestra-gtk" --remote-control "$RC" >"$RUN/app.log" 2>&1 &
APP_PID=$!

for _ in $(seq 1 50); do
  [ -S "$RC" ] && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "app died early (see $RUN/app.log)"; exit 1; }
  sleep 0.2
done
[ -S "$RC" ] || { echo "remote-control socket never appeared (see $RUN/app.log)"; exit 1; }
sleep 1  # let the window map and produce a first frame

echo "-- driving the remote-control harness"
if python3 - "$RC" "$ART/smoke.png" <<'PY'
import json, socket, sys

sock_path, shot_path = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX)
s.connect(sock_path)
f = s.makefile("rw")

def rpc(o):
    f.write(json.dumps(o) + "\n")
    f.flush()
    return json.loads(f.readline())

failures = []
def check(name, cond):
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond:
        failures.append(name)

r = rpc({"op": "list_widgets"})
check("list_widgets responds ok", bool(r.get("ok")))
names = set()
def walk(nodes):
    for n in nodes:
        names.add(n.get("name"))
        walk(n.get("children", []))
walk(r.get("widgets", []))
check("sidebar list present", "sidebar-list" in names)
# The real sidebar renders the full §5.1 mock fixture: orchestrator + scratch
# tree sections, per-repo groups, and their spawn-threaded rows.
check("orchestrators section header", "section-orchestrators" in names)
check("scratch section header", "section-scratch" in names)
ws_rows = sum(1 for n in names if str(n).startswith("ws-row-"))
check("mock workspace rows render (>=12)", ws_rows >= 12)
check("orchestra repo header", any(str(n).startswith("repo-row-") for n in names))
check("host header for the mixed repo", any(str(n).startswith("host-row-") for n in names))
check("archived toggle present", "archived-toggle-row" in names)
check("status strip present", "status-text" in names)

title = rpc({"op": "get", "name": "main-window", "prop": "label"})
check("window title is Orchestra", title.get("ok") and "Orchestra" in str(title.get("value")))

footer = rpc({"op": "get", "name": "status-text", "prop": "label"})
check("footer names the mock backend", footer.get("ok") and "backend: mock" in str(footer.get("value")))

shot = rpc({"op": "screenshot", "path": shot_path})
check("screenshot rendered", bool(shot.get("ok")))

sys.exit(1 if failures else 0)
PY
then
  [ -s "$ART/smoke.png" ] || { echo "screenshot file missing/empty"; exit 1; }
  STATUS=PASS
  echo "PASS — screenshot: $ART/smoke.png"
else
  exit 1
fi
