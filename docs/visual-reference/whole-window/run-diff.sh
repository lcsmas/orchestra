#!/usr/bin/env bash
# T0 — WHOLE-WINDOW DIFF HARNESS.
#
# Launches BOTH frontends at IDENTICAL geometry against the SAME fixture state,
# reads Electron from its DOM oracle and GTK from composited window pixels, and
# emits a per-region difference map RANKED BY DELTA.
#
# WHY THIS EXISTS: four M4 verification waves scoped agents to regions and
# missed defects the user saw instantly by opening both apps side by side. The
# cheapest comparison available — whole window against whole window — was never
# in any brief. It finds in seconds what scoped audits cannot see AT ALL,
# because the defect class is cross-region: the right token values applied to
# the WRONG SURFACES. No single-region agent has the reference to notice that.
#
# GEOMETRY IS ASSERTED, NEVER ASSUMED. Both halves report their ACHIEVED size
# and diff-report.py REFUSES to compare a mismatched pair. Setting a size is not
# holding it (it reverted three times in one session), and a pair captured at
# different sizes produces perfectly precise numbers that mean nothing.
#
# EACH APP GETS ITS OWN HEADLESS SWAY, and is the only (hence focused) window
# there. An unfocused window stops producing frames and captures then HANG
# rather than fail — so "separate workspaces in one compositor" is not the fix.
#
# Windows never reach the user's desktop: WLR_BACKENDS=headless, own wayland-N.
# NEVER wayland-1 — the user works there.
#
# Usage: run-diff.sh [outdir] [--size WxH]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
NATIVE="$REPO/native"
OUT="${1:-$HERE/out}"
SIZE="1600x1000"
[ "${2:-}" = "--size" ] && SIZE="${3:-$SIZE}"
W="${SIZE%x*}"; H="${SIZE#*x}"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-wwdiff.XXXXXX")"
# A FIXED CDP PORT IS A LANDMINE ON THIS MACHINE: ~50 sibling agents run
# Electron instances, and a previous run of THIS harness can still hold the port
# during a back-to-back invocation. The bind then fails, CDP never answers, and
# the run dies with "CDP never came up" — which the detector-proof script
# initially reported as "THE DETECTOR DID NOT FIRE", i.e. an INSTRUMENT failure
# wearing the costume of a subject verdict. Ask the kernel for a free port
# instead of hand-auditing for collisions.
PORT="${ORCHESTRA_DEBUG_PORT:-$(python3 -c '
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
')}"
mkdir -p "$OUT"

E_PID=""; G_PID=""; E_SWAY=""; G_SWAY=""
STATUS=FAIL
cleanup() {
  # Kill by RECORDED PID. `kill %1` silently no-ops in a non-interactive shell
  # (no job control), which has left "killed" daemons running.
  for p in "$E_PID" "$G_PID" "$E_SWAY" "$G_SWAY"; do
    [ -n "$p" ] && kill "$p" 2>/dev/null || true
  done
  if [ "$STATUS" = PASS ]; then rm -rf "$RUN"; else echo "logs kept in $RUN" >&2; fi
}
trap cleanup EXIT

# Verify BY ARTIFACT, not by a printed exit code.
[ -f "$REPO/dist-electron/main.js" ] || { echo "dist-electron missing — run: npx vite build"; exit 1; }
# shellcheck source=../../../native/env.sh
source "$NATIVE/env.sh"
BIN="$NATIVE/target/release/orchestra-gtk"
[ -x "$BIN" ] || { echo "missing $BIN — run: source native/env.sh && cargo build -p orchestra-gtk --release --manifest-path native/Cargo.toml"; exit 1; }

start_sway() { # $1=tag -> echoes the wayland display name
  local tag="$1" before="$RUN/sockets-$1"
  echo "output HEADLESS-1 resolution ${W}x${H}" > "$RUN/sway-$tag.conf"
  ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort > "$before" || true
  WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= \
    SWAYSOCK="$RUN/sway-$tag.sock" sway -c "$RUN/sway-$tag.conf" \
    >"$RUN/sway-$tag.log" 2>&1 &
  echo $! > "$RUN/sway-$tag.pid"
  local wd=""
  for _ in $(seq 1 50); do
    wd="$(ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort | comm -13 "$before" - | head -1)"
    [ -n "$wd" ] && break; sleep 0.2
  done
  [ -n "$wd" ] || { echo "headless sway ($tag) produced no wayland socket" >&2; exit 1; }
  # A bare guard against the one display that must never be used.
  [ "$wd" = "wayland-1" ] && { echo "refusing wayland-1 (the user's session)" >&2; exit 1; }
  echo "$wd"
}

echo "== whole-window diff at ${W}x${H}"

# ── ELECTRON half ───────────────────────────────────────────────────────────
echo "-- [electron] headless sway"
E_WD="$(start_sway electron)"; E_SWAY="$(cat "$RUN/sway-electron.pid")"
E_HOME="$RUN/ehome"; mkdir -p "$E_HOME/.claude"
echo "-- [electron] seeding the shared fixture"
node "$HERE/../seed-store.mjs" "$E_HOME"
echo "-- [electron] launching on $E_WD (isolated home, CDP :$PORT)"
cd "$REPO"
WAYLAND_DISPLAY="$E_WD" ELECTRON_OZONE_PLATFORM_HINT=wayland \
  ORCHESTRA_HOME="$E_HOME" HOME="$E_HOME" ORCHESTRA_DEBUG_PORT="$PORT" \
  npx electron . --ozone-platform=wayland >"$RUN/electron.log" 2>&1 &
E_PID=$!
for _ in $(seq 1 100); do
  curl -sf "http://127.0.0.1:$PORT/json" >/dev/null 2>&1 && break
  kill -0 "$E_PID" 2>/dev/null || { echo "electron died early:"; tail -30 "$RUN/electron.log"; exit 1; }
  sleep 0.3
done
curl -sf "http://127.0.0.1:$PORT/json" >/dev/null || { echo "CDP never came up"; tail -30 "$RUN/electron.log"; exit 1; }
node "$HERE/oracle-electron.mjs" "$PORT" "$OUT/electron-oracle.json"

# ── GTK half ────────────────────────────────────────────────────────────────
echo "-- [gtk] headless sway"
G_WD="$(start_sway gtk)"; G_SWAY="$(cat "$RUN/sway-gtk.pid")"
# ORCHESTRA_HOME is NOT optional: orchestra-gtk restores a persisted
# `sidebarWidth` at startup, so without an isolated home the capture inherits
# whatever width the DEVELOPER last dragged their sidebar to. That leak once
# produced a 179px phantom "regression" that was attributed to header labels.
export ORCHESTRA_HOME="$RUN/ghome"; mkdir -p "$ORCHESTRA_HOME"
RC="$RUN/rc.sock"
echo "-- [gtk] launching on $G_WD (MOCK fixture)"
ORCHESTRA_GTK_MOCK=1 GDK_BACKEND=wayland WAYLAND_DISPLAY="$G_WD" \
  "$BIN" --remote-control "$RC" >"$RUN/gtk.log" 2>&1 &
G_PID=$!
for _ in $(seq 1 60); do
  [ -S "$RC" ] && break
  kill -0 "$G_PID" 2>/dev/null || { echo "gtk app died early:"; tail -30 "$RUN/gtk.log"; exit 1; }
  sleep 0.2
done
[ -S "$RC" ] || { echo "remote-control socket never appeared"; tail -30 "$RUN/gtk.log"; exit 1; }
sleep 2  # first paint + fixture render
python3 "$HERE/probe-gtk.py" "$RC" "$OUT/gtk-probe.json" "$OUT/gtk-frame.png"

# ── The ranked map ──────────────────────────────────────────────────────────
echo
set +e
python3 "$HERE/diff-report.py" "$OUT/electron-oracle.json" "$OUT/gtk-probe.json" \
  | tee "$OUT/DIFF-REPORT.txt"
DIFF_RC="${PIPESTATUS[0]}"
set -e

STATUS=PASS
echo
echo "-- artifacts in $OUT"
# The diff's own exit code is the harness's exit code: nonzero means regions
# differ. That is a RESULT, not a harness failure.
exit "$DIFF_RC"
