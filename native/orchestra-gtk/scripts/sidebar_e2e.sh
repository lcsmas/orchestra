#!/usr/bin/env bash
# Sidebar E2E scenarios (plan §5.1 / §8.4): build, launch in mock mode inside a
# FRESH headless sway compositor (never the user's desktop), then drive the
# remote-control harness through the core sidebar interactions and capture a
# screenshot per state so the verifier can review them personally:
#
#   00-initial     full render (sections, trees, repo groups, host header,
#                  pills, archived toggle)
#   01-selected    a repo workspace row selected (active highlight)
#   02-collapsed   an orchestrator subtree folded (hidden-count pill appears)
#   03-renaming    inline branch rename entry open on a repo row
#   04-renamed     rename committed (renameBranch fired; entry gone)
#   05-reordered   two repo workspaces reordered via the sidebar.drop-ws action
#   06-archived    archived section expanded (multi-select bar)
#
# Headless sway's seat advertises no pointer/keyboard, so compositor input never
# reaches the client — the harness synthesizes events GTK-side, and drag-reorder
# is driven through the sidebar.drop-ws / drop-repo gio actions (Op::Action)
# rather than a real pointer drag (see src/remote_control.rs, src/sidebar/mod.rs).
#
# Artifacts: native/target/sidebar-e2e/*.png (+ sway/app logs kept on failure).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/../.." && pwd)"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-gtk-sbe2e.XXXXXX")"
ART="$NATIVE/target/sidebar-e2e"
mkdir -p "$ART" "$RUN/home"
rm -f "$ART"/*.png

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

echo "-- driving sidebar scenarios"
if python3 - "$RC" "$ART" <<'PY'
import json, socket, sys

sock_path, art = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX)
s.connect(sock_path)
f = s.makefile("rw")

def rpc(o):
    f.write(json.dumps(o) + "\n"); f.flush()
    return json.loads(f.readline())

failures = []
def check(name, cond):
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond:
        failures.append(name)

def names():
    r = rpc({"op": "list_widgets"})
    out = set()
    def walk(nodes):
        for n in nodes:
            out.add(n.get("name")); walk(n.get("children", []))
    walk(r.get("widgets", []))
    return out

def css(name):
    r = rpc({"op": "get", "name": name, "prop": "css"})
    return set(r.get("value", [])) if r.get("ok") else set()

def shot(tag):
    r = rpc({"op": "screenshot", "path": f"{art}/{tag}.png"})
    if not r.get("ok"):
        print(f"       screenshot error: {r.get('error')}")
    check(f"screenshot {tag}", bool(r.get("ok")))

# --- 00 initial full render ------------------------------------------------
n = names()
check("orchestrators section", "section-orchestrators" in n)
check("scratch section", "section-scratch" in n)
check("orchestrator root row", "ws-row-orch-1" in n)
check("spawned git child row", "ws-row-ws-child-a" in n)
check("cross-repo grandchild row", "ws-row-ws-grandchild" in n)
check("orchestra repo header", any(str(x).startswith("repo-row-") for x in n))
check("mixed-repo host header", any(str(x).startswith("host-row-") for x in n))
check("archived toggle", "archived-toggle-row" in n)
shot("00-initial")

# --- 01 select a repo workspace row ---------------------------------------
rpc({"op": "click", "name": "ws-row-ws-1"})
check("ws-1 row now active", "active" in css("ws-row-ws-1"))
shot("01-selected")

# --- 02 collapse an orchestrator subtree ----------------------------------
rpc({"op": "click", "name": "ws-collapse-orch-1"})
n = names()
check("subtree collapsed: git child hidden", "ws-row-ws-child-a" not in n)
check("subtree collapsed: root still shown", "ws-row-orch-1" in n)
shot("02-collapsed")
# expand it back so later screenshots show the full tree
rpc({"op": "click", "name": "ws-collapse-orch-1"})
check("subtree re-expanded", "ws-row-ws-child-a" in names())

# --- 03 inline rename on a repo row ---------------------------------------
# The sidebar.* action group lives on the sidebar root, so target a widget
# inside it (actions resolve up the tree from the named widget, not down from
# the window).
rpc({"op": "action", "action": "sidebar.start-rename", "param": "ws-3", "name": "sidebar-list"})
check("rename entry open", "ws-rename-entry" in names())
shot("03-renaming")

# --- 04 commit the rename --------------------------------------------------
rpc({"op": "type", "name": "ws-rename-entry", "text": "-renamed"})
rpc({"op": "action", "action": "sidebar.commit-rename", "param": "ws-3", "name": "sidebar-list"})
n = names()
check("rename entry gone after commit", "ws-rename-entry" not in n)
check("row still present", "ws-row-ws-3" in n)
shot("04-renamed")

# --- 05 reorder two repo workspaces via the drop action -------------------
# Move ws-1 to after ws-3 (both are orchestra-repo depth-0 rows).
before_order = [x for x in [
    "ws-row-ws-1", "ws-row-ws-2", "ws-row-ws-3", "ws-row-ws-4", "ws-row-ws-5"
] if x in names()]
rpc({"op": "action", "action": "sidebar.drop-ws", "param": "ws-1|ws-3|after", "name": "sidebar-list"})
after = names()
check("reorder kept all rows", all(x in after for x in before_order))
shot("05-reordered")

# --- 06 expand archived + selection bar -----------------------------------
rpc({"op": "click", "name": "archived-toggle"})
n = names()
check("archived bar shown", "archived-bar" in n)
check("archived rows shown", any(str(x).startswith("ws-row-ws-arch-") for x in n))
rpc({"op": "click", "name": "archived-select-all"})
check("select-all delete button", "archived-bar-delete" in names())
shot("06-archived")

sys.exit(1 if failures else 0)
PY
then
  count=$(ls -1 "$ART"/*.png 2>/dev/null | wc -l)
  [ "$count" -ge 7 ] || { echo "expected >=7 screenshots, got $count"; exit 1; }
  STATUS=PASS
  echo "PASS — $count screenshots in $ART"
else
  exit 1
fi
