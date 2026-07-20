#!/usr/bin/env bash
# Capture BOTH halves of the visual-reference pair against ONE shared backend,
# so the two frontends render from byte-identical live state.
#
# WHY THIS EXISTS — the apples-to-oranges trap the mock pair fell into:
# capture-gtk.sh runs GTK in ORCHESTRA_GTK_MOCK=1 (a rich compiled-in fixture)
# while capture-electron.sh runs the REAL Electron backend against a throwaway
# ORCHESTRA_HOME whose seeded repos do not exist on disk. Electron then
# RECOMPUTES every git/gh/du/usage-derived field live — and, the repos being
# absent, computes them to EMPTY (no PR badges → `PR?` error, no size/version/
# ahead pills, no repo-sync). The GTK mock, by contrast, SERVES those fields
# from fixture. So the two halves were never showing the same data: most of the
# "parity differences" in that pair were state differences, not rendering ones.
# (Confirmed at source: seed-store.mjs mirrors mock.rs field-for-field, yet the
# captures still diverged — because Electron does not READ the seed for those
# fields, it overwrites them. A mock can never mirror a live-computed field.)
#
# THE FIX — make both frontends talk to the SAME backend. Electron always
# acquires the backend lock (src/main/index.ts) and serves a ui-rpc socket for
# external frontends (src/main/ui-rpc.ts writes <ORCHESTRA_HOME>/ui-sock). The
# GTK app, launched WITHOUT ORCHESTRA_GTK_MOCK against that same home, discovers
# the ui-sock (native/orchestra-gtk/src/backend.rs discover_socket) and attaches
# as a second client (native/.../src/app.rs attach_flow — no daemon spawn, no
# lock contention). Now the DATA is identical by construction, so any remaining
# difference in the captured pair is a REAL rendering / layout / feature
# difference — which is the pair a reviewer can actually trust.
#
# This is an ADDITIONAL capture mode, not a replacement: capture-gtk.sh's mock
# path stays (deterministic E2E and the rich-fixture pill zoo still need it).
# The mock pair exercises pills the shared-backend pair cannot (absent repos
# yield no PR/size/version/ahead pills); the shared pair exercises DATA PARITY
# the mock pair cannot. Each answers a question the other can't.
#
# Window size pinned to 1600x1000 (both drives share the ONE headless sway).
#
# Usage: docs/visual-reference/capture-real-pair.sh [outdir]
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NATIVE="$REPO/native"
OUT="${1:-$HERE}"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-vref-real.XXXXXX")"
HOME_DIR="$RUN/ohome"
# CDP debug port for the Electron half. Siblings collide on 9351/9473; this
# mode defaults to 9361. Override with ORCHESTRA_DEBUG_PORT after checking
# `ss -ltn`.
PORT="${ORCHESTRA_DEBUG_PORT:-9361}"
mkdir -p "$OUT" "$HOME_DIR/.claude"

# Row pin — same contract as recapture.sh: pin a row the app does NOT auto-select
# at boot so the selected-state captures compare the same workspace on both
# halves. ws-row-ws-3 (chime-volume) is present in BOTH the seed and the mock
# under the same id/name. The pin is honoured by drive-electron.mjs (translated
# to row text via the seeded store) and drive-gtk.py (matched by widget name).
export ORCHESTRA_CAPTURE_ROW="${ORCHESTRA_CAPTURE_ROW:-ws-row-ws-3}"

APP_PID=""; GTK_PID=""; SWAY_E_PID=""; SWAY_G_PID=""
STATUS=FAIL
cleanup() {
  # GTK (client) first, then Electron (backend it depends on), then both sways.
  [ -n "$GTK_PID" ] && kill "$GTK_PID" 2>/dev/null || true
  [ -n "$APP_PID" ] && kill "$APP_PID" 2>/dev/null || true
  [ -n "$SWAY_G_PID" ] && kill "$SWAY_G_PID" 2>/dev/null || true
  [ -n "$SWAY_E_PID" ] && kill "$SWAY_E_PID" 2>/dev/null || true
  if [ "$STATUS" = PASS ]; then rm -rf "$RUN"; else echo "FAIL — logs kept in $RUN" >&2; fi
}
trap cleanup EXIT

# Start a headless sway at 1600x1000 and echo its fresh wayland-N socket name.
# Each frontend gets its OWN compositor: they SHARE the backend (one
# ORCHESTRA_HOME, one ui-rpc socket on the filesystem), but must NOT share a
# compositor — two clients in one sway get TILED side by side (~796px each),
# which silently halves the window and breaks any layout comparison. The socket
# lives under $XDG_RUNTIME_DIR, reachable from any compositor, so separate sways
# cost nothing in state-sharing.
start_sway() {
  local tag="$1" conf="$RUN/sway-$1.conf" log="$RUN/sway-$1.log" before="$RUN/before-$1"
  echo "output HEADLESS-1 resolution 1600x1000" > "$conf"
  ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort > "$before" || true
  WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= SWAYSOCK="$RUN/sway-$tag.sock" \
    sway -c "$conf" >"$log" 2>&1 &
  echo "$!" > "$RUN/sway-$tag.pid"
  local wd=""
  for _ in $(seq 1 50); do
    wd="$(ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort | comm -13 "$before" - | head -1)"
    [ -n "$wd" ] && break; sleep 0.2
  done
  [ -n "$wd" ] || { echo "headless sway ($tag) produced no wayland socket" >&2; return 1; }
  echo "$wd"
}

[ -f "$REPO/dist-electron/main.js" ] || { echo "dist-electron missing — run: npx vite build"; exit 1; }
BIN="$NATIVE/target/release/orchestra-gtk"
[ -x "$BIN" ] || { echo "missing $BIN — run: source native/env.sh && cargo build -p orchestra-gtk --release --manifest-path native/Cargo.toml"; exit 1; }

echo "== shared-backend capture at $(git -C "$REPO" rev-parse --short HEAD)"
echo "== pinned row: $ORCHESTRA_CAPTURE_ROW"

echo "-- seeding the shared fixture into $HOME_DIR"
node "$HERE/seed-store.mjs" "$HOME_DIR"

echo "-- starting headless sway for Electron (1600x1000)"
WD_E="$(start_sway electron)" || exit 1
SWAY_E_PID="$(cat "$RUN/sway-electron.pid")"
echo "-- Electron sway up on $WD_E"

# ── Electron: owns the backend, serves ui-rpc, seeds the shared state ────────
echo "-- launching Electron (owns backend, serves ui-rpc; CDP :$PORT)"
cd "$REPO"
WAYLAND_DISPLAY="$WD_E" ELECTRON_OZONE_PLATFORM_HINT=wayland \
  ORCHESTRA_HOME="$HOME_DIR" HOME="$HOME_DIR" ORCHESTRA_DEBUG_PORT="$PORT" \
  npx electron . --ozone-platform=wayland >"$RUN/electron.log" 2>&1 &
APP_PID=$!
for _ in $(seq 1 100); do
  curl -sf "http://127.0.0.1:$PORT/json" >/dev/null 2>&1 && break
  kill -0 "$APP_PID" 2>/dev/null || { echo "electron died early:"; cat "$RUN/electron.log"; exit 1; }
  sleep 0.3
done
curl -sf "http://127.0.0.1:$PORT/json" >/dev/null || { echo "CDP never came up"; cat "$RUN/electron.log"; exit 1; }

# The ui-sock pointer is what GTK will discover. Wait for it to be a real socket
# before driving Electron — its presence is also the precondition for the GTK
# half, so failing here (rather than after the Electron captures) is the honest
# early exit.
echo "-- waiting for Electron's ui-sock"
UISOCK=""
for _ in $(seq 1 60); do
  if [ -f "$HOME_DIR/ui-sock" ]; then UISOCK="$(cat "$HOME_DIR/ui-sock" 2>/dev/null || true)"; [ -n "$UISOCK" ] && [ -S "$UISOCK" ] && break; fi
  sleep 0.2
done
[ -n "$UISOCK" ] && [ -S "$UISOCK" ] || { echo "Electron never served a ui-rpc socket"; echo "home:"; ls -la "$HOME_DIR"; exit 1; }
echo "-- ui-sock live: $UISOCK"

# ── Electron half ───────────────────────────────────────────────────────────
echo "-- driving Electron capture"
export ORCHESTRA_CAPTURE_STORE="$HOME_DIR/userData/orchestra/store.json"
if ! node "$HERE/drive-electron.mjs" "$PORT" "$OUT"; then
  echo "-- electron log tail:"; tail -20 "$RUN/electron.log" || true
  exit 1
fi
echo "-- electron captures done"

# ── GTK half: same backend, second client ───────────────────────────────────
# Electron STAYS ALIVE — GTK attaches to its live ui-rpc socket. ORCHESTRA_HOME
# is isolated for the SAME reason capture-gtk.sh isolates it: orchestra-gtk
# persists sidebarWidth to $ORCHESTRA_HOME/gtk-ui-state.json and restores it,
# so a leaked developer home silently corrupts the measured width. Here it also
# has to be the SAME home Electron owns, which is what makes both discover ONE
# backend.  $ORCHESTRA_UI_SOCK pins the exact socket (belt-and-suspenders atop
# the ui-sock pointer discovery).
echo "-- starting headless sway for GTK (1600x1000)"
WD_G="$(start_sway gtk)" || exit 1
SWAY_G_PID="$(cat "$RUN/sway-gtk.pid")"
echo "-- GTK sway up on $WD_G"

echo "-- launching orchestra-gtk (real backend, attaching to Electron ui-rpc)"
RC="$RUN/rc.sock"
# GTK gets its OWN compositor (WD_G) but the SAME backend: ORCHESTRA_HOME +
# $ORCHESTRA_UI_SOCK point at Electron's live ui-rpc socket, which lives under
# $XDG_RUNTIME_DIR and is reachable across compositors.
# env.sh must be sourced for the localdeps LD paths; run the binary in a subshell
# that sources it, so this script's own env stays clean.
ORCHESTRA_HOME="$HOME_DIR" ORCHESTRA_UI_SOCK="$UISOCK" \
  GDK_BACKEND=wayland WAYLAND_DISPLAY="$WD_G" \
  bash -c "source '$NATIVE/env.sh'; exec '$BIN' --remote-control '$RC'" \
  >"$RUN/gtk.log" 2>&1 &
GTK_PID=$!
for _ in $(seq 1 80); do
  [ -S "$RC" ] && break
  kill -0 "$GTK_PID" 2>/dev/null || { echo "gtk died early:"; cat "$RUN/gtk.log"; exit 1; }
  sleep 0.2
done
[ -S "$RC" ] || { echo "remote-control socket never appeared"; cat "$RUN/gtk.log"; exit 1; }

# ASSERT — and do NOT assume — that GTK attached to ELECTRON's socket, not to a
# daemon it spawned itself and not to nothing. This is the one failure mode that
# poisons the result INVISIBLY: a GTK that spawned its own empty backend, or an
# unnoticed mock, renders a plausible sidebar that is NOT the shared state, and
# the pixels look fine. Three distinct wrong outcomes to rule out:
#   1. mock      — ORCHESTRA_GTK_MOCK leaked (footer "backend: mock")
#   2. daemon    — GTK spawned its OWN daemon because discovery missed the socket
#                  (footer "backend: daemon"; a NEW ui-rpc pid, not Electron's)
#   3. none      — attach failed entirely (empty sidebar, footer "backend: none")
# The authoritative, self-resetting signal is the footer status strip
# (widget "status-text"), which renders footer_text() from the LIVE connection's
# server_kind — RemoteKind::Electron → "backend: electron". Read THAT over the
# remote-control socket rather than grepping a log line that a spawned daemon
# would also emit. Also assert the socket GTK is on is the exact one Electron
# wrote, so a same-kind-but-different-backend can't slip through.
echo "-- confirming GTK attached to ELECTRON's ui-rpc (not mock/daemon/none)"
python3 - "$RC" "$UISOCK" "$RUN/gtk.log" <<'PY'
import json, socket, sys, time
rc_path, uisock, gtk_log = sys.argv[1], sys.argv[2], sys.argv[3]
rc = socket.socket(socket.AF_UNIX); rc.connect(rc_path)
f = rc.makefile("rw")
def rpc(o):
    f.write(json.dumps(o) + "\n"); f.flush(); return json.loads(f.readline())
footer = None
for _ in range(60):
    r = rpc({"op": "get", "name": "status-text", "prop": "label"})
    if r.get("ok"):
        val = (r.get("value") or "").lower()
        if val:
            footer = val
            # Terminal states — stop as soon as the strip resolves to a backend.
            if "backend: electron" in val: break
            if "backend: mock" in val:
                print(f"FAIL: GTK footer says MOCK — ORCHESTRA_GTK_MOCK leaked: {val!r}"); sys.exit(1)
            if "backend: daemon" in val:
                print(f"FAIL: GTK SPAWNED ITS OWN DAEMON instead of attaching to Electron: {val!r}"); sys.exit(1)
            if "backend: none" in val:
                # still-connecting; keep polling
                pass
    time.sleep(0.25)
if not footer or "backend: electron" not in footer:
    print(f"FAIL: GTK never reported 'backend: electron' (last footer: {footer!r}) — attach to the shared backend did not happen")
    sys.exit(1)
print(f"-- footer confirms shared backend: {footer!r}")
sys.exit(0)
PY
# Belt-and-suspenders: GTK must NOT have spawned its own daemon. It only spawns
# when discovery FAILS (app.rs attach_flow), and with $ORCHESTRA_UI_SOCK set +
# the socket live that path is unreachable — but assert it rather than trust it.
if grep -qE "starting the Orchestra daemon|spawn_daemon|SpawnedDaemon" "$RUN/gtk.log"; then
  echo "FAIL: GTK log shows it tried to SPAWN a daemon — it did not attach to Electron"; tail -30 "$RUN/gtk.log"; exit 1
fi
sleep 2  # first paint + hydration settle

echo "-- driving GTK capture"
if ! python3 "$HERE/drive-gtk.py" "$RC" "$OUT"; then
  echo "-- gtk log tail:"; tail -20 "$RUN/gtk.log" || true
  exit 1
fi

STATUS=PASS
echo "PASS — shared-backend pair captured in $OUT"
