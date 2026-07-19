#!/usr/bin/env bash
# LIVE-daemon end-to-end drive (plan §1.2 / §8.4): prove the sidebar renders on
# a REAL ui-rpc daemon (not ORCHESTRA_GTK_MOCK) and that a workspace mutation
# made THROUGH the daemon re-renders the row via App→forward→Msg::Backend —
# i.e. the single-consumer fan-out actually delivers live frames end to end.
#
# Flow:
#   1. Seed a throwaway ORCHESTRA_HOME store (a repo with a non-existent path so
#      the orphan-pruner skips it, one waiting workspace, an ok self-tune run so
#      the scheduler doesn't spawn headless claude).
#   2. Boot `node dist-electron/daemon.js` on that home (HOME overridden too, so
#      ~/.claude reads stay isolated); it writes the ui-sock pointer.
#   3. Launch the GTK app in a fresh headless sway WITHOUT mock mode — it
#      discovers the socket, so the footer reads "backend: rpc".
#   4. Screenshot BEFORE. Assert the seeded row renders and its dot is NOT unread.
#   5. Mutate through the daemon: a second ui-rpc client calls setUnread(id,true).
#      The daemon broadcasts workspaceUpdate → App consumes the sole events()
#      stream → forwards Msg::Backend → the sidebar re-renders.
#   6. Screenshot AFTER. Assert the dot flipped to `unread` (accent-blue).
#
# Artifacts: native/target/live-drive/{before,after}.png (+ logs kept on fail).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-gtk-live.XXXXXX")"
ART="$NATIVE/target/live-drive"
HOME_DIR="$RUN/ohome"
mkdir -p "$ART" "$HOME_DIR/userData/orchestra" "$HOME_DIR/.claude"
rm -f "$ART"/*.png

APP_PID=""; SWAY_PID=""; DAEMON_PID=""
STATUS=FAIL
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null || true
  if [ "$STATUS" = PASS ]; then rm -rf "$RUN"; else echo "FAIL — logs kept in $RUN" >&2; fi
}
trap cleanup EXIT

echo "-- seeding throwaway store at $HOME_DIR"
NOW="$(python3 -c 'import time; print(int(time.time()*1000))')"
cat > "$HOME_DIR/userData/orchestra/store.json" <<JSON
{
  "repos": [
    { "path": "$RUN/no-such-repo", "name": "live-repo", "baseBranch": "main" }
  ],
  "workspaces": [
    {
      "id": "live-ws-1",
      "name": "live-ws-1",
      "kind": "worktree",
      "repoPath": "$RUN/no-such-repo",
      "worktreePath": "$RUN/no-such-repo/wt",
      "branch": "live-branch",
      "baseBranch": "main",
      "createdAt": $NOW,
      "status": "waiting",
      "agent": "claude",
      "markedUnread": false
    }
  ],
  "accounts": [],
  "selfTuneRuns": [
    { "id": "seed", "trigger": "manual", "status": "ok", "startedAt": $NOW, "finishedAt": $NOW, "steps": [] }
  ]
}
JSON

# shellcheck source=../../env.sh
source "$NATIVE/env.sh"
echo "-- building orchestra-gtk"
cargo build -p orchestra-gtk --manifest-path "$NATIVE/Cargo.toml"

# dist-electron/daemon.js is prebuilt by `pnpm run build:daemon`; verify.
[ -f "$REPO/dist-electron/daemon.js" ] || { echo "dist-electron/daemon.js missing — run pnpm run build:daemon"; exit 1; }

echo "-- booting the daemon (node) on the seeded home"
# HOME override keeps self-tune/login reads off the real ~/.claude.
ORCHESTRA_HOME="$HOME_DIR" HOME="$HOME_DIR" \
  node "$REPO/dist-electron/daemon.js" >"$RUN/daemon.log" 2>&1 &
DAEMON_PID=$!

SOCK=""
for _ in $(seq 1 100); do
  if [ -f "$HOME_DIR/ui-sock" ]; then SOCK="$(cat "$HOME_DIR/ui-sock")"; [ -S "$SOCK" ] && break; fi
  kill -0 "$DAEMON_PID" 2>/dev/null || { echo "daemon died early (see $RUN/daemon.log)"; cat "$RUN/daemon.log"; exit 1; }
  sleep 0.2
done
[ -S "$SOCK" ] || { echo "daemon never wrote a live ui-sock (see $RUN/daemon.log)"; cat "$RUN/daemon.log"; exit 1; }
echo "-- daemon up, ui-rpc socket: $SOCK"

echo "-- starting headless sway"
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

echo "-- launching orchestra-gtk (LIVE mode — discovers the daemon socket)"
RC="$RUN/rc.sock"
# NO ORCHESTRA_GTK_MOCK: the app discovers ui-sock under ORCHESTRA_HOME.
ORCHESTRA_HOME="$HOME_DIR" GDK_BACKEND=wayland WAYLAND_DISPLAY="$WD" \
  "$NATIVE/target/debug/orchestra-gtk" --remote-control "$RC" >"$RUN/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 50); do
  [ -S "$RC" ] && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "app died early (see $RUN/app.log)"; cat "$RUN/app.log"; exit 1; }
  sleep 0.2
done
[ -S "$RC" ] || { echo "remote-control socket never appeared (see $RUN/app.log)"; exit 1; }
sleep 1.5  # let the app connect, hello/helloOk, list_workspaces, first paint

echo "-- driving the live scenario"
if python3 - "$RC" "$SOCK" "$ART" <<'PY'
import json, socket, struct, sys

rc_path, ui_path, art = sys.argv[1], sys.argv[2], sys.argv[3]

# --- remote-control (newline-JSON) ---
rc = socket.socket(socket.AF_UNIX); rc.connect(rc_path); rcf = rc.makefile("rw")
def rpc(o):
    rcf.write(json.dumps(o) + "\n"); rcf.flush(); return json.loads(rcf.readline())

failures = []
def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + (f"  [{extra}]" if extra else ""))
    if not cond: failures.append(name)

def names():
    r = rpc({"op": "list_widgets"}); out = set()
    def walk(ns):
        for n in ns: out.add(n.get("name")); walk(n.get("children", []))
    walk(r.get("widgets", [])); return out

def css(name):
    r = rpc({"op": "get", "name": name, "prop": "css"})
    return set(r.get("value", [])) if r.get("ok") else set()

def label(name):
    r = rpc({"op": "get", "name": name, "prop": "label"})
    return str(r.get("value")) if r.get("ok") else ""

# --- BEFORE: live backend, seeded row present, dot not unread ---
foot = label("status-text")
# The live RpcBackend reports the daemon's real version from the helloOk
# handshake ("backend: daemon vX.Y.Z"); the mock/stub footers differ.
check("footer reports a live daemon backend", "backend: daemon" in foot, foot)
n = names()
check("seeded live workspace row rendered", "ws-row-live-ws-1" in n)
dot_before = css("ws-dot")  # dot class is on the inner box; list to confirm
# Inspect the specific row's dot via its widget subtree.
def row_dot_classes(row_name):
    # The dot box has classes ws-dot + status; find it by walking the row.
    r = rpc({"op": "list_widgets"})
    found = []
    def walk(ns, in_row):
        for node in ns:
            nm = node.get("name", "")
            here = in_row or nm == row_name
            if here and "ws-dot" == nm:
                found.append(node)
            walk(node.get("children", []), here)
    walk(r.get("widgets", []), False)
    return found
# ws-dot boxes aren't uniquely named, so assert via CSS get on the row instead:
before_unread = "unread" in css("ws-row-live-ws-1")
check("row not unread before mutation", not before_unread)
rpc({"op": "screenshot", "path": f"{art}/before.png"})

# --- MUTATE THROUGH THE DAEMON via a second ui-rpc client ---
ui = socket.socket(socket.AF_UNIX); ui.connect(ui_path)
def send_frame(obj):
    payload = json.dumps(obj).encode()
    ui.sendall(struct.pack(">I", len(payload)) + payload)
def recv_frame():
    hdr = b""
    while len(hdr) < 4:
        b = ui.recv(4 - len(hdr));
        if not b: return None
        hdr += b
    (ln,) = struct.unpack(">I", hdr)
    buf = b""
    while len(buf) < ln:
        b = ui.recv(ln - len(buf))
        if not b: return None
        buf += b
    return json.loads(buf.decode())

send_frame({"t": "hello", "proto": 1, "appVersion": "live-drive", "clientKind": "test", "focused": False})
hello_ok = recv_frame()
check("daemon helloOk (backendKind daemon)", hello_ok and hello_ok.get("t") == "helloOk"
      and hello_ok.get("backendKind") == "daemon", json.dumps(hello_ok))
# Call setUnread(live-ws-1, true) — the daemon persists + broadcasts workspaceUpdate.
send_frame({"t": "req", "id": 1, "method": "setUnread", "params": ["live-ws-1", True]})
# Read frames until our res arrives (events may interleave).
got_res = False
for _ in range(20):
    f = recv_frame()
    if f is None: break
    if f.get("t") == "res" and f.get("id") == 1:
        got_res = True
        check("setUnread res ok", bool(f.get("ok")), json.dumps(f)); break
if not got_res:
    check("setUnread res ok", False, "no res frame")

# --- AFTER: give the App→forward→sidebar path a moment, then assert the flip ---
import time
after_unread = False
for _ in range(25):
    time.sleep(0.2)
    if "unread" in css("ws-row-live-ws-1"):
        after_unread = True; break
check("row re-rendered as unread via live forward path", after_unread)
rpc({"op": "screenshot", "path": f"{art}/after.png"})

print("\n  SUMMARY: footer=" + foot.split(' · ')[0] + f"  before_unread={before_unread}  after_unread={after_unread}")
sys.exit(1 if failures else 0)
PY
then
  [ -s "$ART/before.png" ] && [ -s "$ART/after.png" ] || { echo "missing before/after screenshots"; exit 1; }
  STATUS=PASS
  echo "PASS — screenshots: $ART/before.png , $ART/after.png"
else
  echo "-- daemon log tail:"; tail -15 "$RUN/daemon.log" 2>/dev/null || true
  exit 1
fi
