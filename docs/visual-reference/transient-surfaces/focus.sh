#!/usr/bin/env bash
# Give ONE app the whole output, FOCUSED, so it produces frames.
# Unfocused/backgrounded => Page.captureScreenshot hangs; tiled => wrong width.
# Both failure modes yield plausible wrong numbers, so this PRINTS the achieved
# geometry and EXITS NONZERO unless the app is focused+visible at full width.
set -euo pipefail
SP=/tmp/claude-1000/-home-lmas--orchestra-worktrees-orchestra-noble-horizon-fe944aa2/f6402dd4-6588-472d-ab3e-dc39bec834ab/scratchpad
export SWAYSOCK=$SP/rig/sway.sock
APP="$1"
OTHER=$([ "$APP" = orchestra ] && echo dev.orchestra.gtk || echo orchestra)

# Park the idle app WITHOUT following it (move ... to workspace does not switch).
swaymsg "[app_id=\"$OTHER\"] move container to workspace 9" >/dev/null 2>&1 || true
swaymsg "[app_id=\"$APP\"] move container to workspace 1"  >/dev/null 2>&1 || true
swaymsg 'workspace 1'                                      >/dev/null 2>&1 || true
swaymsg "[app_id=\"$APP\"] focus"                          >/dev/null 2>&1 || true
sleep 1.8

swaymsg -t get_tree | python3 -c "
import json,sys
t=json.load(sys.stdin); app=sys.argv[1]; found=None
def w(n,ws=None):
    global found
    if n.get('type')=='workspace': ws=n.get('name')
    if n.get('app_id')==app:
        r=n.get('rect',{})
        found=(r.get('width'),r.get('height'),ws,n.get('focused'),n.get('visible'))
    for c in n.get('nodes',[])+n.get('floating_nodes',[]): w(c,ws)
w(t)
if not found: print('GEOM MISSING'); sys.exit(1)
W,H,ws,foc,vis=found
print(f'GEOM {app} {W}x{H} ws={ws} focus={foc} vis={vis}')
if not (foc and vis and W>=1500):
    print('UNUSABLE FOR CAPTURE'); sys.exit(1)
" "$APP"
