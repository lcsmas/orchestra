#!/usr/bin/env bash
# G5/G6 — the packaged AppImage boot gate for the fleet bus (#114).
#
#   must-PASS  the BUILT AppImage boots and its log shows the bus DB opened.
#   must-FAIL  the SAME build with better_sqlite3.node renamed away REFUSES to
#              boot, with a diagnosable error.
#
# The must-FAIL arm is the point. Without it, the must-PASS line proves only that
# *something* logged; it cannot distinguish "the bus really opened" from "the
# module resolved from somewhere else entirely".
#
# Every window opens inside a SECOND headless sway compositor. Nothing here may
# ever reach the user's screen — see the headless-sway-e2e skill.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APPIMAGE="$ROOT/release/Orchestra.AppImage"
RIG_PID=$$
WORK="$(mktemp -d /tmp/bus-boot-rig-XXXXXX)"
SWAY_PID=""
SWAY_SOCK="$WORK/sway.sock"
MY_DISPLAY=""

# Per-rig marker colour: sibling agents follow this same recipe and several
# compositors serve an output literally named HEADLESS-1, so a shared #FF00FF
# would let this rig gate against someone else's app.
MARK_G=$(printf '%02X' $(( (RIG_PID / 251) % 256 )))
MARK_B=$(printf '%02X' $(( RIG_PID % 251 + 5 )))
MARKER="FF${MARK_G}${MARK_B}"
MARK_R_DEC=255
MARK_G_DEC=$(( (RIG_PID / 251) % 256 ))
MARK_B_DEC=$(( RIG_PID % 251 + 5 ))

cleanup() {
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null
  if [ -n "${KEEP_WORK:-}" ]; then echo "  (kept rig dir: $WORK)"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

[ -f "$APPIMAGE" ] || fail "no built AppImage at $APPIMAGE — run pnpm run build first"

# ─── 0. BUILD IDENTITY — is this AppImage built from the CURRENT source? ────
# A stale binary reproduces a stale verdict PERFECTLY, and nothing about the run
# looks wrong. I hit exactly this while writing #114: edited bus-binding.ts,
# re-ran the rig against a build that predated the edit, and read the unchanged
# failure as "the fix does not work". Assert identity before measuring, not after
# being confused.
if [ -n "$(find "$ROOT/src/main" -name '*.ts' -newer "$APPIMAGE" -print -quit 2>/dev/null)" ]; then
  newer="$(find "$ROOT/src/main" -name '*.ts' -newer "$APPIMAGE" -printf '%f ' 2>/dev/null)"
  fail "STALE BUILD: source newer than the AppImage ($newer) — run pnpm run build before gating"
fi
echo "  build identity: AppImage is newer than every src/main/*.ts"


# ─── 1. Start our own compositor ────────────────────────────────────────────
cat > "$WORK/sway.conf" <<EOF
output HEADLESS-1 resolution 1600x1000
EOF
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= \
  SWAYSOCK="$SWAY_SOCK" sway -c "$WORK/sway.conf" >"$WORK/sway.log" 2>&1 &
SWAY_PID=$!

for _ in $(seq 1 50); do
  [ -S "$SWAY_SOCK" ] && break
  sleep 0.2
done
[ -S "$SWAY_SOCK" ] || fail "sway socket never appeared (see $WORK/sway.log)"

# ─── 2. Identify OUR display by an ACTIVE MARKER ────────────────────────────
# Socket-diffing does not identify a compositor (a sibling's socket can appear
# in the same window, and ours can already be in the "before" snapshot). Paint a
# unique colour through OUR socket, then find which display reads it back.
SWAYSOCK="$SWAY_SOCK" swaymsg -- \
  "output HEADLESS-1 background #${MARKER} solid_color" >/dev/null 2>&1 \
  || fail "could not paint the marker through our own sway socket"
sleep 0.5

matches=()
for n in 1 2 3 4 5 6 7 8; do
  shot="$WORK/marker-$n.png"
  WAYLAND_DISPLAY="wayland-$n" grim -o HEADLESS-1 "$shot" 2>/dev/null || continue
  [ -s "$shot" ] || continue
  pct=$(python3 - "$shot" "$MARK_R_DEC" "$MARK_G_DEC" "$MARK_B_DEC" <<'PY'
import sys
from PIL import Image
png, r, g, b = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4])
try:
    im = Image.open(png).convert('RGB').resize((40, 25))
except Exception:
    print(0); sys.exit()
px = list(im.getdata())
hit = sum(1 for (R, G, B) in px if abs(R-r) < 8 and abs(G-g) < 8 and abs(B-b) < 8)
print(int(100 * hit / len(px)) if px else 0)
PY
)
  [ "${pct:-0}" -ge 99 ] && matches+=("wayland-$n")
done

[ "${#matches[@]}" -eq 0 ] && fail "no display shows our marker #${MARKER} — cannot identify our compositor"
[ "${#matches[@]}" -gt 1 ] && fail "TWO displays show our marker (${matches[*]}) — refusing to guess"
MY_DISPLAY="${matches[0]}"
echo "  our compositor: $MY_DISPLAY (marker #${MARKER})"
SWAYSOCK="$SWAY_SOCK" swaymsg -- "output HEADLESS-1 background #000000 solid_color" >/dev/null 2>&1

# ─── 3. Pre-flight, FAIL CLOSED ─────────────────────────────────────────────
# Asserts on the value our OWN sway produced (marker-verified above), never on
# the inherited env. `preflight <display>` returns non-zero and NAMES the clause.
preflight() {
  local target="$1"
  if [ "$target" = "wayland-1" ]; then
    echo "REFUSED[human-display]: $target is the human's compositor"; return 1
  fi
  if [ -z "$MY_DISPLAY" ] || [ "$target" != "$MY_DISPLAY" ]; then
    echo "REFUSED[wrong-display]: $target is not the marker-verified display ($MY_DISPLAY)"; return 1
  fi
  return 0
}

# NEGATIVE ARM — mandatory, and it must refuse for the RIGHT reason. An arm that
# aborts incidentally (sway not up, grim broken) protects nothing.
neg_out="$(preflight wayland-1)"
if [ $? -eq 0 ]; then fail "pre-flight ACCEPTED the human's display — the guard is decoration"; fi
case "$neg_out" in
  REFUSED\[human-display\]*) echo "  negative arm: forced wayland-1 → $neg_out" ;;
  *) fail "negative arm refused for the WRONG reason: $neg_out" ;;
esac
neg2="$(preflight wayland-99)"; [ $? -eq 0 ] && fail "pre-flight accepted a bogus display"
echo "  negative arm: forced wayland-99 → $neg2"

preflight "$MY_DISPLAY" || fail "pre-flight refused our own marker-verified display"
echo "  positive arm: $MY_DISPLAY accepted"

# ─── 4. Boot the AppImage, contained ────────────────────────────────────────
# env -i (allowlist), not env -u: starting from the inherited env keeps DISPLAY
# and the real profile by convention. HOME is overridden too — ORCHESTRA_HOME
# does not relocate everything.
boot_once() {
  local home="$1" logtag="$2"
  mkdir -p "$home"
  env -i \
    HOME="$home" \
    PATH=/usr/bin:/bin \
    XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
    WAYLAND_DISPLAY="$MY_DISPLAY" \
    ELECTRON_OZONE_PLATFORM_HINT=wayland \
    ORCHESTRA_HOME="$home/.orchestra" \
    "$APPIMAGE" --ozone-platform=wayland --no-sandbox \
    >"$WORK/$logtag.stdout" 2>&1 &
  local pid=$!
  # Wait for the app's own log file to carry a bus line, or the process to die.
  local applog="$home/.orchestra/logs/orchestra.log"
  for _ in $(seq 1 60); do
    if [ -f "$applog" ] && grep -qE 'bus: (opened|FAILED)' "$applog" 2>/dev/null; then break; fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  sleep 1
  kill "$pid" 2>/dev/null
  wait "$pid" 2>/dev/null
  cat "$applog" 2>/dev/null > "$WORK/$logtag.applog" || true
}

echo
echo "── must-PASS: the built AppImage boots and opens the bus ──"
boot_once "$WORK/home-pass" pass
PASS_LINE="$(grep -E 'bus: opened .*schema v[0-9]+' "$WORK/pass.applog" 2>/dev/null | head -1)"
if [ -z "$PASS_LINE" ]; then
  echo "  no 'bus: opened' line. Log tail:" >&2
  tail -20 "$WORK/pass.applog" 2>/dev/null >&2
  tail -20 "$WORK/pass.stdout" 2>/dev/null >&2
  fail "must-PASS arm: the packaged app did not log the bus opening"
fi
echo "  $PASS_LINE"
BUSFILE="$(echo "$PASS_LINE" | sed -E 's/.*bus: opened ([^ ]+) .*/\1/')"
[ -f "$BUSFILE" ] || fail "the log claims $BUSFILE was opened but no such file exists"
echo "  and the file really exists: $(stat -c '%s bytes' "$BUSFILE")"

# ─── 5. The arm that MUST FAIL ──────────────────────────────────────────────
# Rename the unpacked .node away and boot the SAME build. If it boots anyway,
# the must-PASS line above proves nothing about this binary.
echo
echo "── must-FAIL: same build, better_sqlite3.node renamed away ──"
EXTRACT="$WORK/squashfs-root"
( cd "$WORK" && "$APPIMAGE" --appimage-extract >/dev/null 2>&1 ) || fail "could not extract the AppImage"
NODE_FILE="$(find "$EXTRACT" -name 'better_sqlite3.node' | head -1)"
[ -n "$NODE_FILE" ] || fail "no better_sqlite3.node inside the extracted AppImage — it never shipped"
echo "  found: ${NODE_FILE#$EXTRACT/}"
mv "$NODE_FILE" "$NODE_FILE.moved" || fail "could not rename the binding"

FAILHOME="$WORK/home-fail"; mkdir -p "$FAILHOME/.orchestra"
env -i HOME="$FAILHOME" PATH=/usr/bin:/bin \
  XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}" \
  WAYLAND_DISPLAY="$MY_DISPLAY" ELECTRON_OZONE_PLATFORM_HINT=wayland \
  ORCHESTRA_HOME="$FAILHOME/.orchestra" \
  "$EXTRACT/AppRun" --ozone-platform=wayland --no-sandbox \
  >"$WORK/fail.stdout" 2>&1 &
FPID=$!
for _ in $(seq 1 60); do
  if [ -f "$FAILHOME/.orchestra/logs/orchestra.log" ] && \
     grep -qE 'bus: (opened|FAILED)' "$FAILHOME/.orchestra/logs/orchestra.log" 2>/dev/null; then break; fi
  kill -0 "$FPID" 2>/dev/null || break
  sleep 0.5
done
sleep 1
kill "$FPID" 2>/dev/null; wait "$FPID" 2>/dev/null
cat "$FAILHOME/.orchestra/logs/orchestra.log" 2>/dev/null > "$WORK/fail.applog" || true
mv "$NODE_FILE.moved" "$NODE_FILE"   # RESTORE, always

if grep -qE 'bus: opened .*schema v[0-9]+' "$WORK/fail.applog" 2>/dev/null; then
  fail "must-FAIL arm BOOTED THE BUS without its .node — the module resolved from elsewhere, so the must-PASS line proves nothing"
fi
REFUSAL="$(grep -iE 'bus: FAILED|Cannot find module|NODE_MODULE_VERSION|better.sqlite3|startup failed' \
  "$WORK/fail.applog" "$WORK/fail.stdout" 2>/dev/null | head -3)"
[ -n "$REFUSAL" ] || fail "must-FAIL arm produced no diagnosable error — it must REFUSE, not fail silently"
echo "  boot REFUSED, diagnosably:"
echo "$REFUSAL" | sed 's/^/    /'

echo
echo "PASS — packaged boot opens the bus (G5), and the same build without its .node refuses with a diagnosable error (G6)."
