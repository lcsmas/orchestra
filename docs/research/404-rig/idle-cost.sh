#!/usr/bin/env bash
# #404 rig — idle footprint of each runtime shape: process count + summed PSS (and RSS) of the tree, 6 s after start.
# Windowless only; scratch userData under $TMPDIR.
set -u
RIG=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$RIG/../../.." && pwd)
E=$(node -p "require('$REPO/node_modules/electron')")
S="${TMPDIR:?}/r404-idle-$$"; mkdir -p "$S"
cat >"$S/idle-main.cjs" <<'EOF'
const { app } = require('electron');
app.setPath('userData', process.env.R404_USERDATA);
app.on('window-all-closed', () => {});
app.whenReady().then(() => setTimeout(() => app.exit(0), 10000));
EOF
echo 'setTimeout(() => {}, 10000)' >"$S/idle-node.cjs"
tree_cost() { # pid → "procs=N rss_mb=M"
  local pids; pids=$(ps -e -o pid=,ppid= | awk -v r="$1" '{p[$1]=$2} END {for (k in p) {x=k; while (x && x!=r) x=p[x]; if (x==r) print k}}')
  local n=0 pss=0 rss=0 p
  for p in $pids; do n=$((n + 1))
    pss=$((pss + $(awk '/^Pss:/ {print $2}' /proc/$p/smaps_rollup 2>/dev/null || echo 0)))
    rss=$((rss + $(awk '/^Rss:/ {print $2}' /proc/$p/smaps_rollup 2>/dev/null || echo 0))); done
  printf 'procs=%d pss_mb=%d rss_sum_mb=%d\n' "$n" $((pss / 1024)) $((rss / 1024))
}
measure() { local label=$1; shift; "$@" >/dev/null 2>&1 & local pid=$!; sleep 6; printf '%-44s %s\n' "$label" "$(tree_cost $pid)"; kill $pid 2>/dev/null; wait $pid 2>/dev/null || true; }
BASE=(env -i HOME="$HOME" PATH=/usr/bin:/bin XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS")
measure "B windowless --ozone-platform=headless" "${BASE[@]}" R404_USERDATA="$S/ud1" "$E" "$S/idle-main.cjs" --ozone-platform=headless
measure "B windowless headless + --disable-gpu" "${BASE[@]}" R404_USERDATA="$S/ud2" "$E" "$S/idle-main.cjs" --ozone-platform=headless --disable-gpu
measure "A ELECTRON_RUN_AS_NODE=1" "${BASE[@]}" ELECTRON_RUN_AS_NODE=1 "$E" "$S/idle-node.cjs"
measure "C system node" "${BASE[@]}" /usr/bin/node "$S/idle-node.cjs"
