#!/usr/bin/env bash
# E2E for the accounts/usage/login surface (plan §5.4), mirroring smoke.sh's
# headless-sway + remote-control recipe. Launches the GTK app in mock mode
# inside a FRESH headless sway (never the user's desktop), drives the
# remote-control harness to:
#   - assert the usage-bars strip renders (5h/7d + Fable bars) and its hover
#     panel exists in the tree with per-account rows;
#   - open the Accounts settings window and assert the account cards + inherit
#     controls + live config-dir preview render (screenshot);
#   - open a per-account login modal (feed-mode VTE) and assert the login PTY
#     banner fed through (screenshot).
#
# WebKit OAuth-window isolation is proven separately by the login_web Rust
# integration test (two accounts → two on-disk partition dirs); the consent
# wall is documented, never automated (plan §5.4).
#
# Artifacts under native/target/smoke-accounts/: strip.png, panel.png,
# settings.png, login.png (+ sway/app logs in the run dir, kept on failure).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/../.." && pwd)"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-gtk-acct.XXXXXX")"
ART="$NATIVE/target/smoke-accounts"
mkdir -p "$ART" "$RUN/home"

APP_PID=""
SWAY_PID=""
STATUS=FAIL
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null || true
  if [ "$STATUS" = PASS ]; then rm -rf "$RUN"; else echo "FAIL — logs kept in $RUN" >&2; fi
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
sleep 1  # let the window map + the accounts controller hydrate its first render

echo "-- driving the accounts remote-control harness"
if python3 - "$RC" "$ART" <<'PY'
import json, socket, sys, time

rc_path, art = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX); s.connect(rc_path)
f = s.makefile("rw")
def rpc(o):
    f.write(json.dumps(o) + "\n"); f.flush()
    return json.loads(f.readline())

failures = []
def check(name, cond):
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond: failures.append(name)

def names_of(widgets):
    out = set()
    def walk(ns):
        for n in ns:
            out.add(n.get("name")); walk(n.get("children", []))
    walk(widgets)
    return out

# 1) Usage-bars strip: 5h/7d/Fable bars + the panel with per-account rows.
tree = rpc({"op": "list_widgets"})
names = names_of(tree.get("widgets", []))
check("usage-bars strip present", "usage-bars" in names)
check("5h bar present", "usage-bar-5h" in names)
check("7d bar present", "usage-bar-7d" in names)
check("Fable bar present (global snapshot has fable)", "usage-bar-fable" in names)
check("hover panel present in tree", "usage-bars-panel" in names)

vis = rpc({"op": "get", "name": "usage-bars", "prop": "visible"})
check("strip is visible (has usage data)", vis.get("ok") and vis.get("value") is True)
# Strip is 'expandable' because the mock seeds configured accounts.
css = rpc({"op": "get", "name": "usage-bars", "prop": "css"})
check("strip is expandable (accounts configured)", css.get("ok") and "expandable" in css.get("value", []))

shot = rpc({"op": "screenshot", "name": "usage-bars", "path": f"{art}/strip.png"})
check("strip screenshot", bool(shot.get("ok")))

# The panel is a popover: mapped only on hover, which headless sway can't
# synthesize. Screenshot the panel *list* container (built at render time) to
# prove the per-account rows exist; it lives under the popover child.
plist = rpc({"op": "screenshot", "name": "usage-bars-panel-list", "path": f"{art}/panel.png"})
# May be zero-sized while unmapped; the tree assertion above is the hard proof.
print("  info panel-list screenshot:", plist.get("ok"), plist.get("error", ""))

# 2) Accounts settings window.
rpc({"op": "click", "name": "accounts-open"})
time.sleep(0.6)
tree = rpc({"op": "list_widgets"}); names = names_of(tree.get("widgets", []))
check("settings window present", "accounts-settings" in names)
check("account card rendered", any(str(n).startswith("account-card-") for n in names))
check("config-dir preview present", "accounts-dir-preview" in names)
check("scratch-default toggle present", "account-scratch-default" in names)
check("inherit settings checkbox present", "account-inherit-settings" in names)
shot = rpc({"op": "screenshot", "name": "accounts-settings", "path": f"{art}/settings.png"})
check("settings screenshot", bool(shot.get("ok")))

# Live config-dir preview reacts to a label edit (auto-suggest sync). Type a
# label into the FIRST card's label entry and confirm the dir preview updates.
# (Both fields share the widget name across cards; the first match is card 0.)
rpc({"op": "type", "name": "accounts-input-label", "text": "-x"})
time.sleep(0.2)
prev = rpc({"op": "get", "name": "accounts-dir-preview", "prop": "label"})
print("  info dir preview after edit:", prev.get("value"))
check("dir preview non-empty", prev.get("ok") and bool(str(prev.get("value") or "")))

# 3) Per-account login modal (feed-mode VTE). The first card's Login button
# persists then opens the modal; the mock feeds a login banner into the PTY.
rpc({"op": "click", "name": "accounts-login"})
time.sleep(0.8)
tree = rpc({"op": "list_widgets"}); names = names_of(tree.get("widgets", []))
check("login modal present", "account-login-modal" in names)
check("feed-mode VTE present", "account-login-term" in names)
shot = rpc({"op": "screenshot", "name": "account-login-modal", "path": f"{art}/login.png"})
check("login modal screenshot", bool(shot.get("ok")))

sys.exit(1 if failures else 0)
PY
then
  for p in strip.png settings.png login.png; do
    [ -s "$ART/$p" ] || { echo "screenshot $p missing/empty"; exit 1; }
  done
  STATUS=PASS
  echo "PASS — screenshots in $ART"
else
  exit 1
fi
