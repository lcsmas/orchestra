#!/usr/bin/env bash
# RECONNECT-TO-A-MOVED-SOCKET drive (M3 P1). The daemon's ui-rpc socket is
# pid-derived, so a backend RESTART lands on a NEW path. RpcBackend::connect
# builds its client with RpcClient::discover (not ::connect), so every reconnect
# attempt RE-RESOLVES the ui-sock pointer — the app must re-attach within
# seconds instead of retrying the dead path until the client's ~3 min give-up.
#
# Flow:
#   1. Seed a throwaway ORCHESTRA_HOME store (repo with a non-existent path so
#      the orphan-pruner skips it, one waiting workspace, an ok self-tune run so
#      the scheduler doesn't spawn headless claude).
#   2. Boot daemon #1 on that home; it writes ui-sock -> /…/orchestra-ui-<pid1>.sock.
#   3. Launch the GTK app in a fresh headless sway; it attaches (footer names
#      the daemon). Record socket #1.
#   4. KILL daemon #1 and boot daemon #2 on the same home — a new pid, so a NEW
#      socket path, and the pointer file now names it.
#   5. Assert the app re-attaches to the MOVED socket, and that a through-daemon
#      mutation still re-renders — i.e. the new connection is live, not just
#      "connected".
#
# ⚠ STATUS: UNVERIFIED — the re-attach assertion does NOT currently pass (no
# recovery observed at 60s / 120s / 220s). That is deliberately recorded as
# UNVERIFIED rather than "reconnect is broken": the pieces are individually
# proven (orchestra-rpc's `discovered_client_reconnects_to_a_moved_socket` and
# `gives_up_reconnecting_after_the_backoff_window`), and this instrument had
# real confounds. Two are now fixed in-script; the third is mitigated:
#   1. FIXED — d2 is reaped explicitly at the end of the window, not only via
#      atexit, so post-mortem state can't masquerade as in-window state.
#   2. FIXED — daemon #1 is killed BY PID, never `pkill -f dist-electron/daemon.js`
#      (a broad pattern would match sibling agents' daemons on this machine).
#   3. MITIGATED — d2's health is polled every 5s DURING the window and reported,
#      so "the backend stayed up" is an observation, not an assumption.
# Establishing the real baseline belongs to the scoped reconnect-latency task,
# which needs a purpose-built harness anyway.
#
# Artifacts: native/target/reconnect/{attached1,reattached}.png.

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-gtk-recon.XXXXXX")"
ART="$NATIVE/target/reconnect"
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
  "repos": [ { "path": "$RUN/no-such-repo", "name": "recon-repo", "baseBranch": "main" } ],
  "workspaces": [
    {
      "id": "recon-ws-1", "name": "recon-ws-1", "kind": "worktree",
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

echo "-- booting daemon #1 on the seeded home"
ORCHESTRA_HOME="$HOME_DIR" HOME="$HOME_DIR" \
  node "$REPO/dist-electron/daemon.js" >"$RUN/daemon1.log" 2>&1 &
DAEMON_PID=$!
SOCK1=""
for _ in $(seq 1 100); do
  if [ -f "$HOME_DIR/ui-sock" ]; then
    SOCK1="$(tr -d '\n' < "$HOME_DIR/ui-sock")"
    [ -S "$SOCK1" ] && break
  fi
  kill -0 "$DAEMON_PID" 2>/dev/null || { echo "daemon #1 died early"; cat "$RUN/daemon1.log"; exit 1; }
  sleep 0.2
done
[ -S "$SOCK1" ] || { echo "daemon #1 never served a socket"; exit 1; }
echo "-- daemon #1 up, socket: $SOCK1"

echo "-- launching orchestra-gtk (daemon already up — attaches immediately)"
RC="$RUN/rc.sock"
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

echo "-- driving the reconnect scenario"
if python3 - "$RC" "$HOME_DIR" "$REPO" "$ART" "$SOCK1" "$RUN" "$DAEMON_PID" <<'PY'
import json, socket, struct, subprocess, sys, os, time, atexit, signal

rc_path, home, repo, art, sock1, run, d1_pid = sys.argv[1:8]
rc = socket.socket(socket.AF_UNIX); rc.connect(rc_path); rcf = rc.makefile("rw")
def rpc(o):
    rcf.write(json.dumps(o) + "\n"); rcf.flush(); return json.loads(rcf.readline())

failures = []
def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + (f"  [{extra}]" if extra else ""))
    if not cond: failures.append(name)

def label(n):
    r = rpc({"op": "get", "name": n, "prop": "label"}); return str(r.get("value")) if r.get("ok") else ""
def css(n):
    r = rpc({"op": "get", "name": n, "prop": "css"}); return set(r.get("value", [])) if r.get("ok") else set()

# --- STEP 1: attached to daemon #1 ---
attached1 = False
for _ in range(40):
    if "backend: daemon" in label("status-text"):
        attached1 = True; break
    time.sleep(0.25)
foot1 = label("status-text")
check("attached to daemon #1", attached1, foot1)
rpc({"op": "screenshot", "path": f"{art}/attached1.png"})

# --- STEP 2: kill daemon #1, boot daemon #2 (NEW pid => NEW socket path) ---
# Kill BY PID, never by pattern. `pkill -f dist-electron/daemon.js` would match
# ANY daemon on this machine — with sibling agents running their own throwaway
# daemons, a broad pattern is one timing change away from killing someone
# else's. (Bracket a char if a pattern is ever unavoidable: dist-electron/daemo[n].js.)
os.kill(int(d1_pid), signal.SIGTERM)
for _ in range(50):
    try:
        os.kill(int(d1_pid), 0)
    except OSError:
        break  # gone
    time.sleep(0.1)
d2 = subprocess.Popen(
    ["node", os.path.join(repo, "dist-electron", "daemon.js")],
    stdout=open(os.path.join(run, "daemon2.log"), "w"), stderr=subprocess.STDOUT,
    env={**os.environ, "ORCHESTRA_HOME": home, "HOME": home},
)
# Python-spawned: the bash trap cannot see this pid, so reap it here on EVERY
# exit path (normal, sys.exit, or uncaught exception) — otherwise a throwaway
# daemon leaks and accumulates across runs.
def _kill_d2():
    if d2.poll() is None:
        d2.terminate()
        try: d2.wait(timeout=5)
        except subprocess.TimeoutExpired: d2.kill()
atexit.register(_kill_d2)

sock2 = None
for _ in range(150):
    p = os.path.join(home, "ui-sock")
    if os.path.exists(p):
        with open(p) as f: cand = f.read().strip()
        if cand and cand != sock1 and os.path.exists(cand):
            sock2 = cand; break
    if d2.poll() is not None:
        check("daemon #2 stayed up", False, "exited early"); break
    time.sleep(0.2)
check("daemon #2 serves a DIFFERENT socket path", bool(sock2), f"{sock1} -> {sock2}")

# --- STEP 3: the app must re-attach to the MOVED socket, fast ---
# First WAIT FOR THE DROP, so the re-attach below can't pass vacuously off
# connection #1. The FOOTER is not the signal — it keeps the last-attached text
# across a drop; ConnectionState::Reconnecting updates the BANNER
# ("backend connection lost — reconnecting…"), which is the real indicator.
t_drop = time.time()
dropped = False
while time.time() - t_drop < 30:
    if "reconnect" in label("backend-banner-text").lower():
        dropped = True; break
    time.sleep(0.1)
check("the dead connection was noticed (banner shows reconnecting)",
      dropped, label("backend-banner-text"))

t0 = time.time()
reattached = False
# Re-attach = the reconnecting banner goes away again (ConnectionState::Connected
# hides it).
#
# ⚠ STATUS: UNVERIFIED. As of this writing this assertion does NOT pass — no
# re-attach was observed at 60s, 120s, or 220s. That is recorded as UNVERIFIED,
# not as "reconnect is broken", because the instrument has known confounds (see
# the header) and a negative result from a dirty instrument is not evidence.
# What IS proven: the client re-resolves a moved pointer
# (orchestra-rpc `discovered_client_reconnects_to_a_moved_socket`, 5/5), and the
# client does emit Disconnected after the backoff window
# (`gives_up_reconnecting_after_the_backoff_window`). The COMPOSITION of those
# with the app's Disconnected handler is what remains unconfirmed.
#
# Bound is 220s — deliberately PAST the client's 180s give-up
# (BackoffPolicy::default max_elapsed_ms), because that give-up is on the
# recovery path here: killing daemon #1 REMOVES the pointer file (its guard only
# unlinks a pointer still naming its own socket), so redials during the gap
# before daemon #2 writes a new one fail discovery and the backoff grows
# (1s→2s→4s→8s→16s→30s). Only when the client finally emits Disconnected does
# the app drop the backend and fall back to its 3s discovery retry loop.
# Do NOT "optimize" this bound down — a shorter window cannot observe the path.
#
# Recovery LATENCY (making this fast rather than eventual) is a separate scoped
# task: it means changing BackoffPolicy or teaching the reconnect loop to watch
# for a pointer change — a shared-crate design change, not a gap-fix.
# The fast-path proof that re-discovery works at all is the orchestra-rpc unit
# test `discovered_client_reconnects_to_a_moved_socket` (pointer repointed
# before the drop → reconnects on the first retry).
# Confound #3 defence: poll daemon #2's health DURING the window, so "d2 stayed
# up the whole time" is an OBSERVATION, not an assumption. Without this, a d2
# that died mid-window would look identical to an app that never re-attached.
d2_unhealthy_at = None
def d2_healthy():
    if d2.poll() is not None:
        return False
    try:
        s = socket.socket(socket.AF_UNIX); s.settimeout(2); s.connect(sock2); s.close()
        return True
    except OSError:
        return False

next_health = time.time()
while time.time() - t0 < 220:
    b = label("backend-banner-text").lower()
    if "reconnect" not in b and "backend: daemon" in label("status-text"):
        reattached = True; break
    if sock2 and time.time() >= next_health:
        next_health = time.time() + 5
        if not d2_healthy() and d2_unhealthy_at is None:
            d2_unhealthy_at = round(time.time() - t0, 1)
    time.sleep(0.25)
secs = round(time.time() - t0, 1)
check("daemon #2 stayed healthy for the whole window (else the result below is void)",
      d2_unhealthy_at is None, f"first unhealthy at +{d2_unhealthy_at}s" if d2_unhealthy_at else "healthy")
check(f"re-attached to the moved socket in {secs}s", reattached, label("status-text"))
rpc({"op": "screenshot", "path": f"{art}/reattached.png"})

# --- STEP 4: the NEW connection is live, not merely "connected" ---
mutated = False
if sock2 and reattached:
    ui = socket.socket(socket.AF_UNIX); ui.connect(sock2)
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
    send({"t": "hello", "proto": 1, "appVersion": "reconnect", "clientKind": "test", "focused": False})
    ho = recv()
    check("daemon #2 helloOk", bool(ho) and ho.get("t") == "helloOk", json.dumps(ho))
    send({"t": "req", "id": 1, "method": "setUnread", "params": ["recon-ws-1", True]})
    for _ in range(20):
        f = recv()
        if f is None: break
        if f.get("t") == "res" and f.get("id") == 1: break
    for _ in range(30):
        time.sleep(0.2)
        if "unread" in css("ws-row-recon-ws-1"):
            mutated = True; break
    check("mutation through daemon #2 re-renders (new connection is LIVE)", mutated)

# Confound #1 defence: reap d2 HERE, explicitly, while we still know the window
# is over — not via atexit. With atexit-only reaping, the post-mortem state
# (pointer gone, socket missing) looks identical to "the backend died during the
# test", which nearly produced a wrong diagnosis once.
_kill_d2()

print(f"\n  SUMMARY: sock1={os.path.basename(sock1)} sock2={os.path.basename(sock2) if sock2 else None}"
      f" reattach={secs}s live={mutated} d2_healthy_throughout={d2_unhealthy_at is None}")
sys.exit(1 if failures else 0)
PY
then
  [ -s "$ART/attached1.png" ] && [ -s "$ART/reattached.png" ] || { echo "missing screenshots"; exit 1; }
  STATUS=PASS
  echo "PASS — screenshots: $ART/{attached1,reattached}.png"
else
  echo "-- daemon1 log tail:"; tail -10 "$RUN/daemon1.log" 2>/dev/null || true
  echo "-- daemon2 log tail:"; tail -10 "$RUN/daemon2.log" 2>/dev/null || true
  echo "-- app log tail:"; tail -20 "$RUN/app.log" 2>/dev/null || true
  exit 1
fi
