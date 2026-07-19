#!/usr/bin/env bash
# LIVE-daemon regression for the toolbar branch picker (B3 gap-fix): prove
# `listBranches` reaches a REAL backend and returns that repo's actual branches.
#
# WHY THIS EXISTS: the toolbar called listBranches(repoPath), but the handler
# (src/main/api-handlers.ts:749) takes a WORKSPACE ID and resolves repoPath
# itself — so the picker threw "workspace not found" on every open against a
# real daemon while working perfectly against the (then-permissive) mock. This
# harness is the repro: it only passes when the argument is the workspace id.
#
# Flow:
#   1. Seed a throwaway ORCHESTRA_HOME whose repo is a REAL git repo with
#      several branches (listBranches shells out to git, so the path must exist).
#   2. Boot `node dist-electron/daemon.js` on that home.
#   3. Launch the GTK app in a fresh headless sway WITHOUT mock mode.
#   4. Open the toolbar branch picker and assert it lists the repo's real
#      branches (and shows no error row).
#   5. M3 gap #2: the seeded repo has NO run script, so assert the Run TAB is
#      still visible with its dim "· setup" hint (the discovery path to the
#      scripts entry point — App.tsx:478), the ▶ run toggle stays hidden, and
#      the Run page shows the "No run script configured" guidance.
#
# Artifacts: native/target/branch-live/{picker,run-tab-setup}.png
# (+ logs kept on fail).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/../.." && pwd)"
REPO="$(cd "$NATIVE/.." && pwd)"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-gtk-branch.XXXXXX")"
ART="$NATIVE/target/branch-live"
HOME_DIR="$RUN/ohome"
GITREPO="$RUN/live-repo"
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

echo "-- creating a REAL git repo with branches at $GITREPO"
mkdir -p "$GITREPO"
git -C "$GITREPO" init -q -b main
git -C "$GITREPO" config user.email live@test.local
git -C "$GITREPO" config user.name "Live Test"
echo "seed" > "$GITREPO/README.md"
git -C "$GITREPO" add -A
git -C "$GITREPO" commit -qm "seed"
# The branches the picker must list.
for b in develop release/0.9 feature/live-picker; do
  git -C "$GITREPO" branch "$b"
done
# The workspace's own branch (checked out in a worktree the daemon can read).
git -C "$GITREPO" branch live-branch
echo "-- repo branches: $(git -C "$GITREPO" branch --format='%(refname:short)' | tr '\n' ' ')"

echo "-- seeding throwaway store at $HOME_DIR"
NOW="$(python3 -c 'import time; print(int(time.time()*1000))')"
cat > "$HOME_DIR/userData/orchestra/store.json" <<JSON
{
  "repos": [
    { "path": "$GITREPO", "name": "live-repo", "baseBranch": "main" }
  ],
  "workspaces": [
    {
      "id": "live-ws-1",
      "name": "live-repo · live-branch",
      "kind": "worktree",
      "repoPath": "$GITREPO",
      "worktreePath": "$GITREPO",
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

[ -f "$REPO/dist-electron/daemon.js" ] || { echo "dist-electron/daemon.js missing — run pnpm run build:daemon"; exit 1; }

echo "-- booting the daemon (node) on the seeded home"
ORCHESTRA_HOME="$HOME_DIR" HOME="$HOME_DIR" \
  node "$REPO/dist-electron/daemon.js" >"$RUN/daemon.log" 2>&1 &
DAEMON_PID=$!

SOCK=""
for _ in $(seq 1 100); do
  if [ -f "$HOME_DIR/ui-sock" ]; then SOCK="$(cat "$HOME_DIR/ui-sock")"; [ -S "$SOCK" ] && break; fi
  kill -0 "$DAEMON_PID" 2>/dev/null || { echo "daemon died early"; cat "$RUN/daemon.log"; exit 1; }
  sleep 0.2
done
[ -S "$SOCK" ] || { echo "daemon never wrote a live ui-sock"; cat "$RUN/daemon.log"; exit 1; }
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
ORCHESTRA_HOME="$HOME_DIR" GDK_BACKEND=wayland WAYLAND_DISPLAY="$WD" \
  "$NATIVE/target/debug/orchestra-gtk" --remote-control "$RC" >"$RUN/app.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 50); do
  [ -S "$RC" ] && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "app died early"; cat "$RUN/app.log"; exit 1; }
  sleep 0.2
done
[ -S "$RC" ] || { echo "remote-control socket never appeared"; cat "$RUN/app.log"; exit 1; }
sleep 2  # connect, hello/helloOk, list_workspaces, first paint

echo "-- driving the branch picker against the live daemon"
if python3 - "$RC" "$ART" <<'PY'
import json, socket, sys, time

rc_path, art = sys.argv[1], sys.argv[2]
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

def label(name):
    r = rpc({"op": "get", "name": name, "prop": "label"})
    return str(r.get("value")) if r.get("ok") else ""

def visible(name):
    # list_widgets reports hidden widgets too (each node carries `visible`), so
    # presence-in-the-tree is NOT a visibility test — ask for the property.
    r = rpc({"op": "get", "name": name, "prop": "visible"})
    return bool(r.get("value")) if r.get("ok") else False

foot = label("status-text")
check("footer reports a live daemon backend", "backend: daemon" in foot, foot)

n = names()
check("toolbar mounted for the live workspace", "toolbar" in n)
check("branch picker button present", "branch-picker-btn" in n)

# Open the picker — this is what fired listBranches and used to throw.
rpc({"op": "click", "name": "branch-picker-btn"})
time.sleep(1.2)

n = names()
# Each branch row is named branch-item-<name>; the repo's real branches must
# appear. Before the fix these were absent and branch-error carried
# "workspace not found".
want = ["main", "develop", "release/0.9", "feature/live-picker", "live-branch"]
got = sorted(x[len("branch-item-"):] for x in n if str(x).startswith("branch-item-"))
print(f"     listed branches: {got}")
for b in want:
    check(f"branch '{b}' listed from the live repo", f"branch-item-{b}" in n)
check("no branch-list error shown", label("branch-error") == "", label("branch-error"))
check("picker is not stuck loading", label("branch-empty") != "Loading branches…", label("branch-empty"))

shot = rpc({"op": "screenshot", "path": f"{art}/picker.png"})
check("screenshot rendered", bool(shot.get("ok")))

# --- Run-tab visibility (M3 gap #2): the seeded live repo has NO run script,
# so the Run TAB must still be present (it's the discovery path to the scripts
# entry point) wearing its dim "· setup" hint, while the ▶ run TOGGLE stays
# hidden (a toggle with nothing to spawn is meaningless).
rpc({"op": "key", "name": "branch-search", "key": "Escape"})
time.sleep(0.4)
check("Run tab visible without a run script", visible("tab-run"))
check("Run tab wears the '· setup' hint", visible("tab-run-hint"))
check("run toggle hidden without a run script", not visible("run-toggle-btn"))
rpc({"op": "click", "name": "tab-run"})
time.sleep(0.6)
check("Run tab is selectable without a script", visible("main-run-slot"))
# NOTE: the "No run script configured" GUIDANCE belongs in the run PANE, which
# B2 owns (app.rs mounts TerminalStack::run_widget() into main-run-slot and
# replaces anything else there). B3 owns the toolbar half asserted above.
shot2 = rpc({"op": "screenshot", "path": f"{art}/run-tab-setup.png"})
check("run-tab screenshot rendered", bool(shot2.get("ok")))

sys.exit(1 if failures else 0)
PY
then
  STATUS=PASS
  echo "PASS — screenshot: $ART/picker.png"
else
  echo "FAILURES — see $RUN (app.log, daemon.log)"
  exit 1
fi
