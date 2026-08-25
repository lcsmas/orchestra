#!/usr/bin/env bash
# E2E rig for #74 — usage-limit auto-resume.
#
# Boots a SECOND headless sway compositor, identifies it by an ACTIVE per-rig
# marker, and drives Orchestra's own built artifact inside it so no window ever
# reaches the human's screen. Follows ~/.claude/skills/headless-sway-e2e.
#
# The pre-flight is FAIL-CLOSED and its clauses are ordered so each can actually
# fire (the skill records three vacuous-guard traps that all read as protection:
# an unassigned variable, an assert comparing a value to itself, and a specific
# refusal placed after the general check that subsumes it). Every refusal NAMES
# the clause that fired, because an arm aborting for an incidental reason
# protects nothing.
#
# Usage:
#   scripts/e2e-usage-resume-rig.sh selftest   # pre-flight arms only; no app boot
#   scripts/e2e-usage-resume-rig.sh drive      # full drive (requires selftest to pass)

set -uo pipefail

RIG_PID=$$
# Per-rig marker. #FF00FF is a SHARED namespace — siblings paint it at the same
# instant and two sockets then read 100%, so a rig keeping the first match gates
# against another agent's build. Red pinned FF so it stays obviously synthetic.
MARK_G=$(printf '%02X' $(( (RIG_PID / 251) % 256 )))
MARK_B=$(printf '%02X' $(( RIG_PID % 251 + 5 )))
MARKER="FF${MARK_G}${MARK_B}"
WANT_R=255
WANT_G=$((16#$MARK_G))
WANT_B=$((16#$MARK_B))

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RIG_HOME="${RIG_HOME:-$HOME/.cache/impl74-rig/$RIG_PID}"
SWAYSOCK_MINE="/tmp/headless-sway-impl74-$RIG_PID.sock"
SWAY_CFG=""
SWAY_PID=""
# Captured FROM the sway we launch — never re-read from the environment. If sway
# silently failed to start, an env-vs-env comparison passes green while pointing
# at the human's screen.
MY_SWAY_DISPLAY=""

log() { printf '[rig %s] %s\n' "$RIG_PID" "$*" >&2; }
die() { printf '[rig %s] ABORT(%s): %s\n' "$RIG_PID" "$1" "${2:-}" >&2; exit 1; }

# ── marker decode ────────────────────────────────────────────────────────────
# Reads the top-left pixel of a grim capture and reports whether it is EXACTLY
# this rig's triple. Exact-match, not "is it magenta-ish": the whole point is to
# separate this compositor from a sibling's.
is_my_marker() {
  local png="$1"
  [ -s "$png" ] || return 1
  python3 - "$png" "$WANT_R" "$WANT_G" "$WANT_B" <<'PY'
import struct, sys, zlib
path, r, g, b = sys.argv[1], *map(int, sys.argv[2:5])
try:
    data = open(path, 'rb').read()
    if data[:8] != b'\x89PNG\r\n\x1a\n':
        sys.exit(1)
    pos, w, h, idat, depth, color = 8, 0, 0, b'', 0, 0
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos+4])[0]
        typ = data[pos+4:pos+8]
        body = data[pos+8:pos+8+ln]
        if typ == b'IHDR':
            w, h, depth, color = *struct.unpack('>II', body[:8]), body[8], body[9]
        elif typ == b'IDAT':
            idat += body
        elif typ == b'IEND':
            break
        pos += 12 + ln
    # Only the shapes grim actually emits; refuse anything else rather than
    # guessing a pixel layout (a wrong guess would fabricate a verdict).
    if depth != 8 or color not in (2, 6):
        sys.exit(3)
    nch = 3 if color == 2 else 4
    raw = zlib.decompress(idat)
    stride = w * nch
    # First scanline only; undo its filter. Enough for a solid-colour output.
    ft = raw[0]
    line = bytearray(raw[1:1+stride])
    if ft == 1:
        for i in range(nch, stride):
            line[i] = (line[i] + line[i-nch]) & 0xFF
    elif ft == 2:
        pass  # prior row is zero on the first line
    elif ft not in (0,):
        sys.exit(4)
    sys.exit(0 if (line[0], line[1], line[2]) == (r, g, b) else 1)
except Exception:
    sys.exit(5)
PY
}

# ── the pre-flight ───────────────────────────────────────────────────────────
# Builds the child env as an explicit ALLOWLIST, then asserts the value read
# back OUT of that allowlist. Clause order matters: the specific wayland-1
# refusal is hoisted ABOVE the equality check, because after it that refusal
# could never fire (wayland-1 equals MY_SWAY_DISPLAY only if the human's
# compositor painted my marker).
#
# $1 = the display the child would receive. Echoes the child env allowlist on
# success; exits non-zero naming the clause on refusal.
preflight() {
  local child_display="${1:-}"

  # (0) the display must have been CAPTURED from my own sway, not inherited.
  [ -n "$MY_SWAY_DISPLAY" ] || die "no-captured-display" \
    "MY_SWAY_DISPLAY is empty — my sway never reported a socket"

  # (1) HOISTED FIRST so it can actually fire: never the human's compositor.
  [ "$child_display" != "wayland-1" ] || die "human-display" \
    "child display is wayland-1 — the human's screen"

  # (2) the child display must equal what MY sway produced. Compared against a
  #     DIFFERENT variable than the one under test (comparing a value to itself
  #     is the measured trap that cannot fail).
  [ "$child_display" = "$MY_SWAY_DISPLAY" ] || die "wrong-display" \
    "child display '$child_display' != my sway's '$MY_SWAY_DISPLAY'"

  # (3) ACTIVE proof: a grim on that display must return MY exact marker. This
  #     is the only clause that separates my compositor from a sibling's.
  local shot="$RIG_HOME/preflight-marker.png"
  WAYLAND_DISPLAY="$child_display" grim -o HEADLESS-1 "$shot" 2>/dev/null
  is_my_marker "$shot" || die "marker-mismatch" \
    "grim on '$child_display' is not my #$MARKER — a sibling's compositor or unpainted"

  # (4) X11 must not leak into the CHILD: Electron falls back to X11 and reaches
  #     the human's screen even with a correct WAYLAND_DISPLAY.
  #
  #     Asserted on the allowlist THIS function emits, not on the inherited
  #     environment. Measured: my own agent session inherits DISPLAY=:0 (the
  #     skill's "the inherited environment is hostile"), so guarding the PARENT
  #     made the clause fire on every call — including the positive control,
  #     which is an unconditional guard that protects nothing. The child env is
  #     built with `env -i` + this allowlist, so the correct assertion is that
  #     no DISPLAY key appears in it. RIG_FORCE_DISPLAY exists ONLY so the
  #     self-test can inject one and watch the clause fire; without an injection
  #     path a guard nobody has seen fail is indistinguishable from one that
  #     cannot.
  local child_x11="${RIG_FORCE_DISPLAY:-}"
  [ -z "$child_x11" ] || die "x11-leak" "child env would carry DISPLAY='$child_x11'"

  # env -i ALLOWLIST, never a spread of the inherited env: a spread keeps
  # everything you forgot to strip. HOME is overridden because Orchestra's inbox
  # root keys off os.homedir(), NOT ORCHESTRA_HOME.
  cat <<EOF
HOME=$RIG_HOME
XDG_RUNTIME_DIR=/run/user/1000
WAYLAND_DISPLAY=$child_display
ELECTRON_OZONE_PLATFORM_HINT=wayland
ORCHESTRA_HOME=$RIG_HOME/.orchestra
PATH=/usr/bin:/bin
EOF
}

start_sway() {
  mkdir -p "$RIG_HOME"
  SWAY_CFG="$(mktemp)"
  echo 'output HEADLESS-1 resolution 1600x1000' > "$SWAY_CFG"
  WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= \
    SWAYSOCK="$SWAYSOCK_MINE" sway -c "$SWAY_CFG" &
  SWAY_PID=$!
  log "sway pid=$SWAY_PID sock=$SWAYSOCK_MINE marker=#$MARKER"
  for _ in $(seq 1 40); do
    [ -S "$SWAYSOCK_MINE" ] && break
    sleep 0.25
  done
  [ -S "$SWAYSOCK_MINE" ] || die "sway-not-ready" "socket never appeared"

  SWAYSOCK="$SWAYSOCK_MINE" swaymsg -- \
    "output HEADLESS-1 background #$MARKER solid_color" >/dev/null 2>&1 \
    || die "marker-paint-failed" "could not paint #$MARKER"
  sleep 1

  # Identify MY display by the active marker. Socket-diffing is banned: siblings
  # serve outputs literally named HEADLESS-1, and my own socket may already be
  # in any BEFORE snapshot.
  local hits=()
  for n in 1 2 3 4 5 6 7 8; do
    local sock="/run/user/1000/wayland-$n"
    [ -S "$sock" ] || continue
    local shot="$RIG_HOME/probe-$n.png"
    WAYLAND_DISPLAY="wayland-$n" grim -o HEADLESS-1 "$shot" 2>/dev/null
    if is_my_marker "$shot"; then hits+=("wayland-$n"); fi
  done

  # Two sockets reading MY exact triple means a collision. Refusing to guess is
  # the safe failure — and it is what caught the measured #FF00FF collision.
  if [ "${#hits[@]}" -gt 1 ]; then
    die "marker-collision" "sockets ${hits[*]} all show #$MARKER — refusing to guess"
  fi
  [ "${#hits[@]}" -eq 1 ] || die "no-marker-socket" "no socket shows my #$MARKER"
  MY_SWAY_DISPLAY="${hits[0]}"
  log "identified MY display: $MY_SWAY_DISPLAY (by active marker #$MARKER)"
}

teardown() {
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null
  [ -n "$SWAY_CFG" ] && rm -f "$SWAY_CFG"
}

# ── self-test: every arm must refuse, and NAME the clause ────────────────────
# An arm that aborts for an incidental reason is a right answer from the wrong
# check. A positive-control arm that must LAUNCH is included, or an assert that
# refuses unconditionally would score a perfect record.
selftest() {
  start_sway
  local fails=0

  arm() { # name  expected-clause  display
    local name="$1" want="$2" disp="$3"
    local out rc
    out="$( (preflight "$disp") 2>&1 )"; rc=$?
    local got
    got="$(printf '%s' "$out" | sed -n 's/.*ABORT(\([^)]*\)).*/\1/p' | head -1)"
    if [ "$rc" -eq 0 ]; then
      echo "  FAIL $name: preflight ACCEPTED '$disp' (expected refusal:$want)"
      fails=$((fails+1))
    elif [ "$got" != "$want" ]; then
      echo "  FAIL $name: refused with clause '$got', expected '$want' (right answer, wrong check)"
      fails=$((fails+1))
    else
      echo "  ok   $name: refused, clause=$got"
      printf '%s\n' "$out" | grep -m1 ABORT | sed 's/^/       /'
    fi
  }

  echo "NEGATIVE ARMS (each must refuse, naming its clause):"
  arm "human-display"   "human-display"   "wayland-1"
  arm "bogus-display"   "wrong-display"   "wayland-99"
  # A REAL sibling socket that is not mine — the arm that a marker check alone
  # exists for. Skipped (not silently passed) when no sibling is up.
  local sib=""
  for n in 2 3 4 5 6 7 8; do
    s="/run/user/1000/wayland-$n"
    [ -S "$s" ] && [ "wayland-$n" != "$MY_SWAY_DISPLAY" ] && { sib="wayland-$n"; break; }
  done
  if [ -n "$sib" ]; then
    arm "sibling-socket" "wrong-display" "$sib"
  else
    echo "  SKIP sibling-socket: no sibling compositor up right now"
  fi

  echo "  -- X11 leak arm (marker+display correct, DISPLAY injected) --"
  local out rc got
  out="$( (RIG_FORCE_DISPLAY=:0 preflight "$MY_SWAY_DISPLAY") 2>&1 )"; rc=$?
  got="$(printf '%s' "$out" | sed -n 's/.*ABORT(\([^)]*\)).*/\1/p' | head -1)"
  if [ "$rc" -eq 0 ]; then
    echo "  FAIL x11-leak: ACCEPTED with DISPLAY=:0"; fails=$((fails+1))
  elif [ "$got" != "x11-leak" ]; then
    echo "  FAIL x11-leak: clause '$got', expected 'x11-leak'"; fails=$((fails+1))
  else
    echo "  ok   x11-leak: refused, clause=$got"
    printf '%s\n' "$out" | grep -m1 ABORT | sed 's/^/       /'
  fi

  echo "POSITIVE CONTROL (must be ACCEPTED — else the guard is unconditional):"
  if env_out="$(preflight "$MY_SWAY_DISPLAY" 2>&1)"; then
    echo "  ok   accepted my own marker-verified display"
    # Assert the value read back OUT of the allowlist, not the input.
    local back; back="$(printf '%s' "$env_out" | sed -n 's/^WAYLAND_DISPLAY=//p')"
    [ "$back" = "$MY_SWAY_DISPLAY" ] \
      && echo "  ok   child env carries WAYLAND_DISPLAY=$back (read back from the allowlist)" \
      || { echo "  FAIL child env carries '$back'"; fails=$((fails+1)); }
    printf '%s' "$env_out" | grep -q "^HOME=$RIG_HOME$" \
      && echo "  ok   child HOME overridden (inbox root keys off os.homedir)" \
      || { echo "  FAIL child HOME not overridden"; fails=$((fails+1)); }
  else
    echo "  FAIL positive control REFUSED — the guard is unconditional, protecting nothing"
    fails=$((fails+1))
  fi

  teardown
  echo
  if [ "$fails" -eq 0 ]; then echo "SELFTEST PASS (all arms refused for the RIGHT clause; positive control launched)"; return 0; fi
  echo "SELFTEST FAIL ($fails)"; return 1
}

# ── drive: observation (a), behind the verified pre-flight ──────────────────
drive() {
  local app="$REPO/release/Orchestra.AppImage"
  [ -x "$app" ] || die "no-artifact" "$app missing — run pnpm run build first"
  # NEVER the shared installed AppImage: a ship agent is live on that path.
  case "$app" in
    "$REPO"/release/*) : ;;
    *) die "shared-install" "refusing to drive anything outside my own worktree" ;;
  esac

  start_sway
  local child_env
  child_env="$(preflight "$MY_SWAY_DISPLAY")" || exit 1   # dies naming its clause
  log "pre-flight PASSED for $MY_SWAY_DISPLAY"

  # CDP port derived from the pid: ~19 sibling agents share this box, and the
  # drive additionally filters targets by URL after connecting.
  local port=$(( 9600 + (RIG_PID % 300) ))
  local rc=0
  RIG_WAYLAND="$MY_SWAY_DISPLAY" RIG_HOME="$RIG_HOME" RIG_APP="$app" RIG_CDP_PORT="$port" \
    node "$REPO/scripts/e2e-usage-resume-drive.mjs" || rc=$?
  teardown
  return $rc
}

case "${1:-selftest}" in
  selftest) selftest ;;
  drive)    drive ;;
  *) die "unknown-mode" "usage: $0 selftest|drive" ;;
esac
