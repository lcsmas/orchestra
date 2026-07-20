#!/usr/bin/env bash
# Prove the reconnect path does not STACK overlays.
# Kill the daemon (-> Disconnected -> unmount), restart it (-> attach -> rebuild),
# and count overlay widgets with each name. Must be exactly 1, not 2.
set -euo pipefail
ART="$1"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
NATIVE="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"; RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-recon.XXXXXX")"; HOME_DIR="$RUN/ohome"
mkdir -p "$ART" "$HOME_DIR/userData/orchestra" "$HOME_DIR/.claude"
APP_PID=""; SWAY_PID=""; DAEMON_PID=""; STATUS=FAIL
cleanup(){ [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null||true; [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null||true; [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null||true; [ "$STATUS" = PASS ] && rm -rf "$RUN" || echo "logs: $RUN">&2; }
trap cleanup EXIT
NOW="$(python3 -c 'import time;print(int(time.time()*1000))')"
cat > "$HOME_DIR/userData/orchestra/store.json" <<JSON
{"repos":[{"path":"$RUN/r","name":"d","baseBranch":"main"}],
 "workspaces":[{"id":"w1","name":"w1","kind":"worktree","repoPath":"$RUN/r","worktreePath":"$RUN/r/wt","branch":"b1","baseBranch":"main","createdAt":$NOW,"status":"idle","agent":"claude","markedUnread":false}],
 "accounts":[],"selfTuneRuns":[]}
JSON
source "$NATIVE/env.sh"
echo "output HEADLESS-1 resolution 1600x1000" > "$RUN/sway.conf"
before="$RUN/b"; ls "$RUNTIME"|grep -E '^wayland-[0-9]+$'|sort>"$before"||true
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= SWAYSOCK="$RUN/s.sock" sway -c "$RUN/sway.conf" >"$RUN/sway.log" 2>&1 & SWAY_PID=$!
WD=""; for _ in $(seq 1 50); do WD="$(ls "$RUNTIME"|grep -E '^wayland-[0-9]+$'|sort|comm -13 "$before" -|head -1)"; [ -n "$WD" ]&&break; sleep 0.2; done
export ORCHESTRA_HOME="$HOME_DIR"
start_daemon(){ HOME="$HOME_DIR" node "$REPO/dist-electron/daemon.js" >>"$RUN/d.log" 2>&1 & DAEMON_PID=$!; for _ in $(seq 1 100); do [ -f "$HOME_DIR/ui-sock" ]&&return 0; sleep 0.2; done; return 1; }
start_daemon || { echo "daemon 1 failed"; exit 1; }
RC="$RUN/rc.sock"
ORCHESTRA_HOME="$HOME_DIR" GDK_BACKEND=wayland WAYLAND_DISPLAY="$WD" "$NATIVE/target/debug/orchestra-gtk" --remote-control "$RC" >"$RUN/app.log" 2>&1 & APP_PID=$!
for _ in $(seq 1 60); do [ -S "$RC" ]&&break; sleep 0.2; done
sleep 3
echo "-- killing daemon (force Disconnected -> unmount)"
kill "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; DAEMON_PID=""
rm -f "$HOME_DIR/ui-sock"
echo "-- polling the connection-state mirror until Disconnected actually fires"
python3 - "$RC" <<'PYW'
import json,socket,sys,time
rc_path=sys.argv[1]
def state():
    rc=socket.socket(socket.AF_UNIX);rc.connect(rc_path);f=rc.makefile("rw")
    f.write(json.dumps({"op":"get","name":"debug-connection-state","prop":"label"})+"\n");f.flush()
    v=json.loads(f.readline()).get("value","?");rc.close();return str(v)
t0=time.time();seen=[]
while time.time()-t0 < 260:
    s=state()
    if not seen or seen[-1][1]!=s:
        seen.append((round(time.time()-t0,1),s)); print(f"   t={seen[-1][0]}s state={s}",flush=True)
    if "Disconnected" in s: break
    time.sleep(2)
print("   transition sequence:", " -> ".join(f"{t}s:{s[:40]}" for t,s in seen))
sys.exit(0 if any("Disconnected" in s for _,s in seen) else 3)
PYW
DISC_RC=$?
[ $DISC_RC -eq 0 ] || { echo "PRECONDITION FAILED: Disconnected never fired -- the stacking path was never exercised"; exit 1; }
echo "-- restarting daemon (force re-attach -> rebuild)"
start_daemon || { echo "daemon 2 failed"; exit 1; }
sleep 12
python3 - "$RC" "$ART" <<'PY'
import json,socket,sys,time
rc_path,art=sys.argv[1],sys.argv[2]
rc=socket.socket(socket.AF_UNIX);rc.connect(rc_path);f=rc.makefile("rw")
def rpc(o):
    f.write(json.dumps(o)+"\n");f.flush();return json.loads(f.readline())
def count(target):
    c=0
    def walk(ns):
        nonlocal c
        for n in ns:
            nm=n.get("name") or ""
            # remote_control disambiguates duplicate names with a -N suffix
            if nm==target or nm.startswith(target+"-"): c+=1
            walk(n.get("children",[]))
    walk(rpc({"op":"list_widgets"}).get("widgets",[]));return c
def label(n):
    r=rpc({"op":"get","name":n,"prop":"label"});return str(r.get("value")) if r.get("ok") else ""
foot=label("status-text")
print("footer after reconnect:",foot)
reattached = "backend: daemon" in foot
print("re-attached:",reattached,"(want True)")
fail=False
for w in ["resources-overlay","insights-overlay","help-overlay"]:
    c=count(w)
    ok = (c==1)
    print(f"{w:20s} instances={c} (want exactly 1) {'ok' if ok else 'FAIL — STACKED'}")
    if not ok: fail=True
# and it must still WORK after the rebuild
rpc({"op":"click","name":"open-help"})
time.sleep(0.6)
vis=rpc({"op":"get","name":"help-overlay","prop":"visible"}).get("value")
print("help opens after reconnect:",vis,"(want True)")
if not vis: fail=True
rpc({"op":"screenshot","path":f"{art}/after-reconnect-help.png","name":"help-overlay"})
sys.exit(1 if (fail or not reattached) else 0)
PY
STATUS=PASS; echo "RECONNECT TEST PASS"
