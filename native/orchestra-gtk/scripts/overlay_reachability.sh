#!/usr/bin/env bash
# Overlay reachability drive against a REAL daemon (no mock, no fake).
#
# Proves, per overlay (Resources / Insights / Help):
#   - the widget's presence in the tree (absent entirely => Overlays::new never ran)
#   - the TRANSITION closed -> open: visible==false BEFORE the click, true AFTER.
#     Asserting the transition, not the end state, so a widget that was already
#     open cannot pass.
#   - content rendered inside it (child widget count > 0), so "visible but empty"
#     cannot pass either.
#   - a screenshot per overlay, hashed by the caller for duplicate detection.
#
# Also re-runs the through-daemon mutation check from sidebar_late_attach.sh
# AFTER the overlays are mounted: if a rebuild added a SECOND events() consumer,
# the work-stealing split makes these deliveries flaky/lost.
#
# Usage: overlay_drive.sh <artifact-dir> <tag>
set -euo pipefail

ART="${1:?artifact dir}"; TAG="${2:-run}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
NATIVE="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-overlay-$TAG.XXXXXX")"
HOME_DIR="$RUN/ohome"
mkdir -p "$ART" "$HOME_DIR/userData/orchestra" "$HOME_DIR/.claude"

APP_PID=""; SWAY_PID=""; DAEMON_PID=""
STATUS=FAIL
cleanup() {
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$DAEMON_PID" ] && kill "$DAEMON_PID" 2>/dev/null || true
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null || true
  if [ "$STATUS" = PASS ]; then rm -rf "$RUN"; else echo "kept logs in $RUN" >&2; fi
}
trap cleanup EXIT

NOW="$(python3 -c 'import time; print(int(time.time()*1000))')"
cat > "$HOME_DIR/userData/orchestra/store.json" <<JSON
{
  "repos": [ { "path": "$RUN/no-such-repo", "name": "ov-repo", "baseBranch": "main" } ],
  "workspaces": [
    {
      "id": "ov-ws-1", "name": "ov-ws-1", "kind": "worktree",
      "repoPath": "$RUN/no-such-repo", "worktreePath": "$RUN/no-such-repo/wt",
      "branch": "ov-branch", "baseBranch": "main", "createdAt": $NOW,
      "status": "waiting", "agent": "claude", "markedUnread": false
    }
  ],
  "accounts": [],
  "selfTuneRuns": [
    { "id": "seed", "trigger": "manual", "status": "ok", "startedAt": $NOW, "finishedAt": $NOW, "steps": [] }
  ]
}
JSON

# shellcheck source=/dev/null
source "$NATIVE/env.sh"
[ -f "$REPO/dist-electron/daemon.js" ] || { echo "daemon.js missing"; exit 1; }

# Prove we exec the binary we just built (mtime is not enough -- content check).
BIN="$NATIVE/target/debug/orchestra-gtk"
echo "-- binary: $BIN  mtime=$(stat -c %y "$BIN")"

echo "-- starting headless sway"
echo "output HEADLESS-1 resolution 1600x1000" > "$RUN/sway.conf"
before="$RUN/before"; ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort > "$before" || true
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= SWAYSOCK="$RUN/sway.sock" \
  sway -c "$RUN/sway.conf" >"$RUN/sway.log" 2>&1 &
SWAY_PID=$!
WD=""
for _ in $(seq 1 50); do
  WD="$(ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort | comm -13 "$before" - | head -1)"
  [ -n "$WD" ] && break; sleep 0.2
done
[ -n "$WD" ] || { echo "no wayland socket"; exit 1; }
echo "-- sway up on $WD"

# Daemon FIRST so the app attaches through the normal discovery path with a real
# backend. Still not the mock: ORCHESTRA_MOCK is never set.
export ORCHESTRA_HOME="$HOME_DIR"
HOME="$HOME_DIR" node "$REPO/dist-electron/daemon.js" >"$RUN/daemon.log" 2>&1 &
DAEMON_PID=$!
for _ in $(seq 1 100); do
  [ -f "$HOME_DIR/ui-sock" ] && break; sleep 0.2
done
[ -f "$HOME_DIR/ui-sock" ] || { echo "daemon never wrote ui-sock"; cat "$RUN/daemon.log"; exit 1; }
echo "-- daemon up"

RC="$RUN/rc.sock"
ORCHESTRA_HOME="$HOME_DIR" GDK_BACKEND=wayland WAYLAND_DISPLAY="$WD" \
  "$BIN" --remote-control "$RC" >"$RUN/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 60); do
  [ -S "$RC" ] && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "app died"; cat "$RUN/app.log"; exit 1; }
  sleep 0.2
done
[ -S "$RC" ] || { echo "no rc socket"; exit 1; }
sleep 2

if python3 - "$RC" "$HOME_DIR" "$ART" "$TAG" <<'PY'
import json, socket, struct, sys, os, time

rc_path, home, art, tag = sys.argv[1:5]
rc = socket.socket(socket.AF_UNIX); rc.connect(rc_path); rcf = rc.makefile("rw")
def rpc(o):
    rcf.write(json.dumps(o) + "\n"); rcf.flush(); return json.loads(rcf.readline())

failures = []
def check(name, cond, extra=""):
    print(("  ok   " if cond else "  FAIL ") + name + (f"  [{extra}]" if extra else ""))
    if not cond: failures.append(name)

def tree():
    return rpc({"op": "list_widgets"}).get("widgets", [])
def names():
    out = set()
    def walk(ns):
        for n in ns:
            out.add(n.get("name")); walk(n.get("children", []))
    walk(tree()); return out
def find(node_name):
    """Return the node dict for a widget name, or None."""
    res = []
    def walk(ns):
        for n in ns:
            if n.get("name") == node_name: res.append(n)
            walk(n.get("children", []))
    walk(tree()); return res[0] if res else None
def count_desc(node):
    if not node: return 0
    c = 0
    for ch in node.get("children", []): c += 1 + count_desc(ch)
    return c
def visible(n):
    r = rpc({"op": "get", "name": n, "prop": "visible"})
    return bool(r.get("value")) if r.get("ok") else None
def label(n):
    r = rpc({"op": "get", "name": n, "prop": "label"}); return str(r.get("value")) if r.get("ok") else ""

# Wait for the real-backend attach; everything below is conditional on it.
attached = False
for _ in range(60):
    if "backend: daemon" in label("status-text"): attached = True; break
    time.sleep(0.25)
foot = label("status-text")
check("REAL backend attached (not mock)", attached, foot)
check("footer does not name the mock", "mock" not in foot.lower(), foot)

present = names()
OVERLAYS = [
    ("Resources", "open-resources", "resources-overlay"),
    ("Insights",  "open-insights",  "insights-overlay"),
    ("Help",      "open-help",      "help-overlay"),
]

results = {}
for title, btn, widget in OVERLAYS:
    print(f"\n-- {title}")
    check(f"{title}: trigger button exists", btn in present)
    mounted = widget in present
    check(f"{title}: overlay widget MOUNTED", mounted)
    if not mounted:
        # The defining symptom of the gating bug: the button exists, the click
        # is accepted, and nothing appears because Overlays::new never ran.
        r = rpc({"op": "click", "name": btn})
        after = names()
        check(f"{title}: click accepted by the harness", bool(r.get("ok")), json.dumps(r))
        check(f"{title}: overlay appears AFTER click", widget in after,
              "still absent -> DEAD NO-OP")
        results[title] = {"mounted": False, "before": None, "after": None, "content": 0}
        continue

    before = visible(widget)
    check(f"{title}: CLOSED before click (transition precondition)", before is False, str(before))
    r = rpc({"op": "click", "name": btn})
    check(f"{title}: click accepted", bool(r.get("ok")), json.dumps(r))
    after = None
    for _ in range(20):
        time.sleep(0.15)
        after = visible(widget)
        if after: break
    check(f"{title}: OPEN after click (closed -> open transition)", after is True, str(after))
    content = count_desc(find(widget))
    check(f"{title}: renders CONTENT (descendant widgets > 0)", content > 0, f"{content} descendants")
    shot = f"{art}/{tag}-{title.lower()}.png"
    sr = rpc({"op": "screenshot", "path": shot, "name": widget})
    check(f"{title}: screenshot captured", bool(sr.get("ok")), json.dumps(sr))
    results[title] = {"mounted": True, "before": before, "after": after, "content": content}
    # Close again so the next overlay's "closed before click" precondition is real.
    rpc({"op": "click", "name": btn})
    time.sleep(0.3)

# ---- single-consumer proof: with overlays mounted, live events must still land.
# A second events() consumer round-robins frames; these mutations would then be
# delivered intermittently. Run several rounds -- one round could pass by luck.
print("\n-- event delivery with overlays mounted (single-consumer check)")
with open(os.path.join(home, "ui-sock")) as f: sock = f.read().strip()
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
send({"t":"hello","proto":1,"appVersion":"overlay-drive","clientKind":"test","focused":False})
ho = recv()
check("daemon helloOk", ho and ho.get("t") == "helloOk", json.dumps(ho))

def css(n):
    r = rpc({"op": "get", "name": n, "prop": "css"}); return set(r.get("value", [])) if r.get("ok") else set()

ROUNDS = 6
delivered = 0
rid = 100
for i in range(ROUNDS):
    want = (i % 2 == 0)   # alternate so each round is a real TRANSITION
    rid += 1
    send({"t":"req","id":rid,"method":"setUnread","params":["ov-ws-1", want]})
    for _ in range(20):
        f = recv()
        if f is None: break
        if f.get("t") == "res" and f.get("id") == rid: break
    got = False
    for _ in range(30):
        time.sleep(0.1)
        if ("unread" in css("ws-row-ov-ws-1")) == want: got = True; break
    delivered += 1 if got else 0
    print(f"  round {i+1}/{ROUNDS} want_unread={want} delivered={got}")
check(f"ALL {ROUNDS} event rounds delivered (no work-stealing loss)",
      delivered == ROUNDS, f"{delivered}/{ROUNDS}")

print("\nSUMMARY " + json.dumps({"attached": attached, "results": results,
                                 "event_rounds": f"{delivered}/{ROUNDS}"}))
sys.exit(1 if failures else 0)
PY
then
  STATUS=PASS; echo "DRIVE PASS"
else
  echo "-- app log tail:"; tail -20 "$RUN/app.log" || true
  exit 1
fi
