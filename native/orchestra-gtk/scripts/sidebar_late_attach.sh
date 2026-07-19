#!/usr/bin/env bash
# LATE-ATTACH end-to-end drive (plan §1.1 rule 3 / §8.4): prove the discovery
# path — the GTK app launched with NO backend, then a daemon appearing later,
# gets picked up by the 3s RetryDiscover loop and hydrates the sidebar via
# Msg::Attach (refresh_snapshot, NOT a self-pump), and that a subsequent
# through-daemon mutation still re-renders via App→forward→Msg::Backend.
#
# Flow (inverse of sidebar_live_drive.sh — app FIRST, daemon SECOND):
#   1. Seed a throwaway ORCHESTRA_HOME store (repo w/ non-existent path so the
#      orphan-pruner skips it, one waiting workspace, an ok self-tune run).
#   2. Launch the GTK app in fresh headless sway with NO daemon and NO mock —
#      discovery fails → banner shows, footer reads "backend: none", 0 rows.
#   3. Screenshot DETACHED. Assert no rows, footer none.
#   4. Boot `node dist-electron/daemon.js` on the same home. Within ~3s the
#      RetryDiscover loop discovers ui-sock → make_backend()/connect →
#      Msg::Attach → refresh_snapshot.
#   5. Screenshot ATTACHED. Assert footer flips to "backend: daemon", banner
#      hides, and the seeded row NOW appears (proves hydration via Attach).
#   6. Mutate through the daemon (setUnread) → assert the dot re-renders via the
#      forward path (dot flips to unread). Screenshot MUTATED.
#
# Artifacts: native/target/late-attach/{detached,attached,mutated}.png.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-gtk-late.XXXXXX")"
ART="$NATIVE/target/late-attach"
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
  "repos": [ { "path": "$RUN/no-such-repo", "name": "late-repo", "baseBranch": "main" } ],
  "workspaces": [
    {
      "id": "late-ws-1", "name": "late-ws-1", "kind": "worktree",
      "repoPath": "$RUN/no-such-repo", "worktreePath": "$RUN/no-such-repo/wt",
      "branch": "late-branch", "baseBranch": "main", "createdAt": $NOW,
      "status": "waiting", "agent": "claude", "markedUnread": false
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
[ -f "$REPO/dist-electron/daemon.js" ] || { echo "dist-electron/daemon.js missing — run pnpm run build:daemon"; exit 1; }

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

echo "-- launching orchestra-gtk with NO daemon (discovery must fail → banner)"
RC="$RUN/rc.sock"
# No mock, and crucially no ui-sock exists yet under ORCHESTRA_HOME.
ORCHESTRA_HOME="$HOME_DIR" GDK_BACKEND=wayland WAYLAND_DISPLAY="$WD" \
  "$NATIVE/target/debug/orchestra-gtk" --remote-control "$RC" >"$RUN/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 50); do
  [ -S "$RC" ] && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "app died early (see $RUN/app.log)"; cat "$RUN/app.log"; exit 1; }
  sleep 0.2
done
[ -S "$RC" ] || { echo "remote-control socket never appeared"; exit 1; }
sleep 1

echo "-- driving the late-attach scenario"
if python3 - "$RC" "$HOME_DIR" "$REPO" "$ART" <<'PY'
import json, socket, struct, subprocess, sys, os, time, atexit

rc_path, home, repo, art = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
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
def label(n):
    r = rpc({"op": "get", "name": n, "prop": "label"}); return str(r.get("value")) if r.get("ok") else ""
def css(n):
    r = rpc({"op": "get", "name": n, "prop": "css"}); return set(r.get("value", [])) if r.get("ok") else set()

# --- STEP 1: DETACHED (no backend) ---
foot0 = label("status-text")
n0 = names()
check("footer reports no backend at launch", "backend: none" in foot0, foot0)
check("banner-text widget present (discovery banner)", "backend-banner-text" in n0)
check("no workspace rows before attach", not any(str(x).startswith("ws-row-") for x in n0))
rpc({"op": "screenshot", "path": f"{art}/detached.png"})

# --- STEP 2: boot the daemon on the SAME home; RetryDiscover (3s) picks it up ---
daemon = subprocess.Popen(
    ["node", os.path.join(repo, "dist-electron", "daemon.js")],
    stdout=open(os.path.join(os.path.dirname(rc_path), "daemon.log"), "w"),
    stderr=subprocess.STDOUT,
    env={**os.environ, "ORCHESTRA_HOME": home, "HOME": home},
)
# The daemon is a Python-spawned subprocess: the bash trap can't see its PID,
# so terminate it here on ANY exit path (else it leaks a throwaway-home daemon
# that survives the run — accumulates across CI runs). atexit fires on both the
# normal sys.exit and any uncaught exception.
def _kill_daemon():
    if daemon.poll() is None:
        daemon.terminate()
        try:
            daemon.wait(timeout=5)
        except subprocess.TimeoutExpired:
            daemon.kill()
atexit.register(_kill_daemon)
# Wait for the daemon socket, then for the app's 3s retry loop to attach.
sock = None
for _ in range(100):
    p = os.path.join(home, "ui-sock")
    if os.path.exists(p):
        with open(p) as f: sock = f.read().strip()
        if os.path.exists(sock): break
    if daemon.poll() is not None:
        check("daemon stayed up", False, "daemon exited early"); break
    time.sleep(0.2)
check("daemon wrote a live ui-sock", bool(sock) and os.path.exists(sock or ""), str(sock))

# The retry timer fires every 3s; poll the footer up to ~8s for the attach.
attached = False
for _ in range(40):
    time.sleep(0.25)
    if "backend: daemon" in label("status-text"):
        attached = True; break
foot1 = label("status-text")
check("discovery attached — footer now names the daemon", attached, foot1)

# --- STEP 3: ATTACHED — sidebar hydrated via Msg::Attach → refresh_snapshot ---
# The seeded row was ABSENT before attach; its presence now proves hydration.
n1 = names()
check("seeded row appeared after attach (refresh_snapshot hydration)",
      "ws-row-late-ws-1" in n1)
check("row not unread yet", "unread" not in css("ws-row-late-ws-1"))
rpc({"op": "screenshot", "path": f"{art}/attached.png"})

# --- STEP 4: mutate through the daemon; confirm the forward path still works ---
ui = socket.socket(socket.AF_UNIX); ui.connect(sock)
def send(o):
    b = json.dumps(o).encode(); ui.sendall(struct.pack(">I", len(b)) + b)
def recv():
    h = b""
    while len(h) < 4:
        c = ui.recv(4 - len(h))
        if not c: return None
        h += c
    (ln,) = struct.unpack(">I", h); buf = b""
    while len(buf) < ln:
        c = ui.recv(ln - len(buf))
        if not c: return None
        buf += c
    return json.loads(buf.decode())
send({"t": "hello", "proto": 1, "appVersion": "late-attach", "clientKind": "test", "focused": False})
ho = recv()
check("daemon helloOk", ho and ho.get("t") == "helloOk" and ho.get("backendKind") == "daemon", json.dumps(ho))
send({"t": "req", "id": 1, "method": "setUnread", "params": ["late-ws-1", True]})
res_ok = False
for _ in range(20):
    f = recv()
    if f is None: break
    if f.get("t") == "res" and f.get("id") == 1:
        res_ok = bool(f.get("ok")); break
check("setUnread res ok", res_ok)

mutated = False
for _ in range(25):
    time.sleep(0.2)
    if "unread" in css("ws-row-late-ws-1"):
        mutated = True; break
check("post-attach mutation re-rendered via forward path", mutated)
rpc({"op": "screenshot", "path": f"{art}/mutated.png"})

print(f"\n  SUMMARY: foot_detached='{foot0.split(' · ')[0]}' foot_attached='{foot1.split(' · ')[0]}'"
      f" attached={attached} hydrated={'ws-row-late-ws-1' in n1} mutated={mutated}")
sys.exit(1 if failures else 0)
PY
then
  [ -s "$ART/detached.png" ] && [ -s "$ART/attached.png" ] && [ -s "$ART/mutated.png" ] || { echo "missing screenshots"; exit 1; }
  STATUS=PASS
  echo "PASS — screenshots: $ART/{detached,attached,mutated}.png"
else
  echo "-- daemon log tail:"; tail -15 "$RUN/daemon.log" 2>/dev/null || true
  echo "-- app log tail:"; tail -15 "$RUN/app.log" 2>/dev/null || true
  exit 1
fi
