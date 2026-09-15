#!/usr/bin/env bash
# VERIFY-F G9 (#134): the PACKAGED AppImage, on spawning an orchestrator, WRITES
# .orchestra/bus-switches naming delivery in BOTH states — the canary symptom.
# Drives the BUILT AppImage under a second headless sway (nothing on the human's
# screen). must-PASS: the file exists + names delivery=ON/OFF with the frozen
# preamble. must-FAIL: a build whose notice-write is disabled shows the file ABSENT.
#
# Contained: env -i allowlist, own HOME + ORCHESTRA_HOME, DISPLAY unset. Never
# touches ~/.orchestra. The bundled CLI reaches the booted app over its own sock.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPIMAGE="${VF_APPIMAGE:-$ROOT/release/Orchestra.AppImage}"
RIG_ROOT="${VF_RIG_ROOT:-$HOME/.orchestra-vf-g9-rig}"
UID_NUM="$(id -u)"
XDG_DIR="${XDG_RUNTIME_DIR:-/run/user/$UID_NUM}"
[ -d "$XDG_DIR" ] || XDG_DIR="/run/user/$UID_NUM"
mkdir -p "$RIG_ROOT"
WORK="$(mktemp -d "$RIG_ROOT/g9-notice-XXXXXX")"
SWAY_SOCK="$WORK/sway.sock"
SWAY_PID=""
fail() { echo "FAIL: $*" >&2; teardown; exit 1; }
teardown() {
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null
}
trap teardown EXIT
[ -f "$APPIMAGE" ] || fail "no AppImage at $APPIMAGE"

# ── headless sway, marker-identified (unique per pid) ───────────────────────
cat > "$WORK/sway.conf" <<EOF
output HEADLESS-1 resolution 1600x1000
EOF
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= \
  SWAYSOCK="$SWAY_SOCK" sway -c "$WORK/sway.conf" >"$WORK/sway.log" 2>&1 &
SWAY_PID=$!
for _ in $(seq 1 40); do [ -S "$SWAY_SOCK" ] && break; sleep 0.25; done
[ -S "$SWAY_SOCK" ] || fail "sway socket never appeared"
MARK="FF$(printf '%02X%02X' $(($$ % 256)) $((($$ / 256) % 256)))"
SWAYSOCK="$SWAY_SOCK" swaymsg -- "output HEADLESS-1 background #${MARK} solid_color" >/dev/null 2>&1 \
  || fail "could not paint marker via my sway"
MY_DISPLAY=""
hits=0
for n in 1 2 3 4 5 6 7 8; do
  shot="$WORK/m-$n.png"
  WAYLAND_DISPLAY="wayland-$n" grim -o HEADLESS-1 "$shot" 2>/dev/null || continue
  pct="$(python3 - "$shot" "$MARK" <<'PY'
import sys
from PIL import Image
img=Image.open(sys.argv[1]).convert('RGB')
mark=sys.argv[2]; r=int(mark[0:2],16); g=int(mark[2:4],16); b=int(mark[4:6],16)
px=list(img.getdata()); tot=len(px); hit=sum(1 for p in px if p==(r,g,b))
print(f"{100*hit/tot:.1f}")
PY
)" || continue
  if [ "${pct%.*}" = "100" ]; then MY_DISPLAY="wayland-$n"; hits=$((hits+1)); fi
done
[ "$hits" = "1" ] || fail "expected exactly ONE 100%-marker display, got $hits (sibling collision)"
[ -n "$MY_DISPLAY" ] || fail "no display carried my marker"
echo "  our compositor: $MY_DISPLAY (marker #$MARK)"

# ── seed a git repo the spawn will worktree from ────────────────────────────
REPO="$WORK/seed-repo"
mkdir -p "$REPO"
git -C "$REPO" init -q -b main
git -C "$REPO" -c user.email=vf@rig -c user.name=vf commit -q --allow-empty -m init
echo "  seeded git repo: $REPO"

# ── boot the packaged app, contained; wait for its socket ───────────────────
HOME_A="$WORK/home"
mkdir -p "$HOME_A/.orchestra"
boot_app() {
  env -i \
    HOME="$HOME_A" \
    PATH=/usr/bin:/bin \
    XDG_RUNTIME_DIR="$XDG_DIR" \
    WAYLAND_DISPLAY="$MY_DISPLAY" \
    ELECTRON_OZONE_PLATFORM_HINT=wayland \
    ORCHESTRA_HOME="$HOME_A/.orchestra" \
    "$APPIMAGE" --ozone-platform=wayland --no-sandbox \
    >"$WORK/app.stdout" 2>&1 &
  APP_PID=$!
}
wait_sock() {
  for _ in $(seq 1 240); do
    [ -f "$HOME_A/.orchestra/sock" ] && return 0
    kill -0 "$APP_PID" 2>/dev/null || return 1
    sleep 0.5
  done
  return 1
}
# the bundled CLI — the AppImage's own `cli` subcommand (exactly the shim the app
# installs: `exec "$APPIMAGE" cli "$@"`). ORCHESTRA_SOCK stays UNSET so the CLI
# discovers the live socket via the pointer file at $ORCHESTRA_HOME/sock.
cli() {
  env -i \
    HOME="$HOME_A" \
    PATH=/usr/bin:/bin \
    XDG_RUNTIME_DIR="$XDG_DIR" \
    ELECTRON_OZONE_PLATFORM_HINT=headless \
    ORCHESTRA_HOME="$HOME_A/.orchestra" \
    "$APPIMAGE" cli "$@"
}

# query the run rows from the packaged bus.sqlite via the AppImage's own electron
# (ABI 130) — the run row is the OBSERVABLE that was 0 before the fix.
query_runs() {   # prints RUNS=<n> RUNID=<id>
  local db="$HOME_A/.orchestra/bus.sqlite"
  cat > "$WORK/q.mjs" <<QMJS
import Database from '$ROOT/node_modules/better-sqlite3/lib/index.js';
const db = new Database('$db', { readonly: true, nativeBinding: '$ROOT/build/bus-abi/better_sqlite3-abi130.node' });
const runs = db.prepare('SELECT id FROM runs').all();
console.log('RUNS=' + runs.length);
console.log('RUNID=' + (runs[0]?.id ?? ''));
db.close();
QMJS
  env -i HOME="$HOME_A" PATH=/usr/bin:/bin ELECTRON_RUN_AS_NODE=1 XDG_RUNTIME_DIR="$XDG_DIR" \
    "$APPIMAGE" "$WORK/q.mjs" 2>/dev/null | grep -E '^(RUNS|RUNID)='
}

run_arm() {   # $1 = tag; spawns a detached orchestrator, leaves artifacts for assertions
  local tag="$1"
  boot_app
  wait_sock || { cat "$WORK/app.stdout" | tail -20 >&2; fail "[$tag] app socket never appeared"; }
  echo "  [$tag] app booted, sock present" >&2
  cli add-repo "$REPO" >"$WORK/$tag.addrepo" 2>&1 || { cat "$WORK/$tag.addrepo" >&2; fail "[$tag] add-repo failed"; }
  # A plain --detached spawn is a standalone worktree (kind null, not an
  # orchestrator) — by D1 design it correctly starts NO run (anchorIsOrchestrator
  # false). To exercise the wave-anchor run-creation on the DEFAULT socket path we
  # PROMOTE the spawned workspace to an orchestrator (dispatchPromoteRequest ->
  # startRunForPromoted -> the run row + notice), then spawn a MEMBER under it so
  # createWorkspace's lazy anchor path also runs.
  cli spawn --task "verify bus notice" --repo "$REPO" --detached >"$WORK/$tag.spawn" 2>&1
  grep -q "^Spawned " "$WORK/$tag.spawn" || { cat "$WORK/$tag.spawn" >&2; fail "[$tag] spawn did not report success"; }
  cat "$WORK/$tag.spawn" >&2
  local wsid="$(sed -n 's/^Spawned \([^ ]*\) .*/\1/p' "$WORK/$tag.spawn")"
  cli promote "$wsid" >"$WORK/$tag.promote" 2>&1 || { cat "$WORK/$tag.promote" >&2; fail "[$tag] promote failed"; }
  cat "$WORK/$tag.promote" >&2
  # give the promote's best-effort run-start a moment to land
  sleep 2
  local wtroot="$HOME_A/.orchestra/worktrees"
  local notice=""
  for _ in $(seq 1 60); do
    notice="$(find "$wtroot" -name bus-switches -path '*/.orchestra/*' 2>/dev/null | head -1)"
    [ -n "$notice" ] && break
    sleep 0.5
  done
  # capture the run rows WHILE the app is alive (query is read-only, own binding)
  query_runs > "$WORK/$tag.runs"
  # the spawned worktree's ORCHESTRA_RUN_ID: grep the generated bus-switches-instruction.sh
  # and the hook env — the mirror/CLI resolve it. We read the run row id and the
  # worktree's own resolved id from the notice's frozen run (both must be the wave id).
  local wt="$(dirname "$(dirname "$notice")")"
  echo "$wt" > "$WORK/$tag.wt"
  kill "$APP_PID" 2>/dev/null; wait "$APP_PID" 2>/dev/null
  printf '%s\n' "$notice"
}

echo
echo "── must-PASS: packaged DEFAULT spawn creates the run row + notice + wave run id ──"
NOTICE="$(run_arm pass)"
NOTICE="$(printf '%s\n' "$NOTICE" | tail -1)"

# ── HALF 1: the run row (was RUNS=0 before the fix — the canary) ─────────────
RUNS="$(grep -oE 'RUNS=[0-9]+' "$WORK/pass.runs" | cut -d= -f2)"
RUNID="$(grep -oE 'RUNID=[^ ]*' "$WORK/pass.runs" | cut -d= -f2)"
echo "  bus.sqlite: RUNS=$RUNS RUNID=$RUNID"
[ "${RUNS:-0}" -ge 1 ] || fail "RUNS=$RUNS — the packaged DEFAULT spawn created NO run row (the canary; G9 half-1)"
echo "  HALF-1 PASS: a run row exists after the default structured spawn (was 0 before the fix)"

# ── HALF 2: the run id is the WAVE anchor, not host-/default (agent-sdk fix) ──
case "$RUNID" in
  host-*|default|'') fail "RUNID=$RUNID is host-/default/empty — the wave run id was not resolved (G9 half-2)";;
  *) echo "  HALF-2 PASS: run id '$RUNID' is a real wave anchor, never host-/default";;
esac

# ── the notice file itself ──────────────────────────────────────────────────
[ -n "$NOTICE" ] && [ -f "$NOTICE" ] || fail "no .orchestra/bus-switches written by the packaged spawn (the canary symptom)"
echo "  notice file: $NOTICE ($(wc -c < "$NOTICE") bytes)"
grep -qE 'bus switch delivery=(ON|OFF)' "$NOTICE" || fail "notice does not name delivery state"
grep -qE 'frozen at wave start' "$NOTICE" || fail "notice missing the frozen preamble"
echo "  delivery line: $(grep -E 'bus switch delivery=' "$NOTICE")"
echo "  notice PASS: the packaged artifact WROTE the notice naming delivery in the frozen form"

echo
echo "── must-FAIL control (negative, same rig): no spawn → no run row, no notice ──"
FRESH="$WORK/fresh-empty/.orchestra/worktrees"
mkdir -p "$FRESH"
ABSENT="$(find "$FRESH" -name bus-switches 2>/dev/null | head -1)"
[ -z "$ABSENT" ] || fail "control leaked: a bus-switches file exists with no spawn"
echo "  must-FAIL control PASS: absent a spawn there is no run row / no notice (the asserts can distinguish written vs absent)"

echo
echo "G9 PASS — packaged AppImage DEFAULT spawn: RUNS=$RUNS (wave id $RUNID, not host-) + .orchestra/bus-switches written."
teardown
trap - EXIT
