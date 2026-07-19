#!/usr/bin/env bash
# M3 gap-fix E2E: the sidebar's account badge + migrate flow (plan §5.4).
#
# Gates the four behaviors the audit called out, against a workspace that
# actually HAS an account assigned (ws-1 → acc-work in the fixture — an
# unpinned row only ever shows "default", so the badge path would go untested):
#
#   1. the badge renders the account's LABEL + login color, not the raw id;
#   2. picking a migrate target opens a CONFIRM dialog (Electron parity —
#      migrating stops a running agent and relocates its conversation);
#   3. cancelling that dialog performs NO migration;
#   4. confirming a migration that FAILS surfaces an error dialog.
#
# Artifacts under native/target/migrate-e2e/: badge.png, confirm.png, error.png.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/../.." && pwd)"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-gtk-migrate.XXXXXX")"
ART="$NATIVE/target/migrate-e2e"
mkdir -p "$ART" "$RUN/home"

APP_PID=""; SWAY_PID=""; STATUS=FAIL
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
[ -n "$WD" ] || { echo "no wayland socket (see $RUN/sway.log)"; exit 1; }

echo "-- launching orchestra-gtk (mock + remote control)"
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
[ -S "$RC" ] || { echo "no remote-control socket (see $RUN/app.log)"; exit 1; }
sleep 1.2

echo "-- driving the migrate-confirm harness"
if python3 - "$RC" "$ART" <<'PY'
import json, socket, sys, time

rc_path, art = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX); s.connect(rc_path)
f = s.makefile("rw")
def rpc(o):
    f.write(json.dumps(o) + "\n"); f.flush()
    return json.loads(f.readline())

failures = []
def check(name, cond, detail=""):
    print(("  ok   " if cond else "  FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))
    if not cond: failures.append(name)

def names_of(widgets):
    out = set()
    def walk(ns):
        for n in ns:
            out.add(n.get("name")); walk(n.get("children", []))
    walk(widgets)
    return out

def tree_names():
    return names_of(rpc({"op": "list_widgets"}).get("widgets", []))

# ---- 1. the badge shows the LABEL, not the raw account id -------------------
# ws-1 is pinned to acc-work in the fixture; its badge must read "work".
label = rpc({"op": "get", "name": "ws-account-label-ws-1", "prop": "label"})
val = str(label.get("value") or "")
check("badge renders the account label", val == "work", f"got {val!r}")
check("badge is NOT the raw account id", "acc-" not in val, f"got {val!r}")
# Tinted by usage: acc-work is 71% on the 7d window → warn.
css = rpc({"op": "get", "name": "ws-account-ws-1", "prop": "css"})
classes = css.get("value", [])
check("badge carries a severity tint", any(c.startswith("sev-") for c in classes), str(classes))
rpc({"op": "screenshot", "name": "ws-account-ws-1", "path": f"{art}/badge.png"})

# ---- 2. picking a target opens a CONFIRM dialog -----------------------------
rpc({"op": "click", "name": "ws-account-ws-1"})   # open the migrate menu
time.sleep(0.4)
check("migrate menu opened", "account-menu" in tree_names())
rpc({"op": "click", "name": "account-pick-perso"})  # migrate ws-1 → perso
time.sleep(0.5)
names = tree_names()
check("confirm dialog appeared", "orch-dialog" in names)
title = rpc({"op": "get", "name": "dialog-title", "prop": "label"})
check("confirm names the action", "Migrate" in str(title.get("value")), str(title.get("value")))
body = rpc({"op": "get", "name": "dialog-body", "prop": "label"})
btext = str(body.get("value") or "")
check("confirm names the TARGET login", "perso" in btext, btext[:80])
check("confirm warns the agent restarts", "restart" in btext.lower(), btext[:80])
rpc({"op": "screenshot", "path": f"{art}/confirm.png"})

# ---- 3. cancelling performs NO migration ------------------------------------
rpc({"op": "key", "name": "Escape"})
time.sleep(0.5)
check("dialog dismissed on cancel", "orch-dialog" not in tree_names())
after = rpc({"op": "get", "name": "ws-account-label-ws-1", "prop": "label"})
check("cancel did NOT migrate (badge unchanged)",
      str(after.get("value") or "") == "work", str(after.get("value")))

# ---- 4. a FAILING migrate surfaces an error ---------------------------------
# acc-broken is the fixture's deterministic failure (the handler throws, as the
# real backend does on !ok) — the error must reach the user, not vanish.
rpc({"op": "click", "name": "ws-account-ws-1"})
time.sleep(0.4)
rpc({"op": "click", "name": "account-pick-broken"})
time.sleep(0.5)
check("confirm shown for the failing target", "orch-dialog" in tree_names())
rpc({"op": "key", "name": "Return"})   # confirm it
time.sleep(0.8)
names = tree_names()
check("error dialog surfaced (not silent)", "orch-dialog" in names)
etitle = rpc({"op": "get", "name": "dialog-title", "prop": "label"})
check("error dialog names the failure", "migrate" in str(etitle.get("value")).lower(),
      str(etitle.get("value")))
rpc({"op": "screenshot", "path": f"{art}/error.png"})
rpc({"op": "key", "name": "Escape"})

sys.exit(1 if failures else 0)
PY
then
  for p in badge.png confirm.png error.png; do
    [ -s "$ART/$p" ] || { echo "screenshot $p missing/empty"; exit 1; }
  done
  STATUS=PASS
  echo "PASS — screenshots in $ART"
else
  exit 1
fi
