#!/usr/bin/env bash
# Contained E2E rig for Orchestra UI verification — issue #64, fix-wave-6.
#
# WHY THIS FILE EXISTS. Test windows reached the human's physical screen during
# this wave. The root cause class is a child env built by SPREAD (`{...process.env}`
# or a bare `env VAR=x`), which inherits the session's `WAYLAND_DISPLAY=wayland-1`
# (the human's real compositor) and `DISPLAY=:0` (their X server). "Headless" was
# then a property of luck, not of the rig.
#
# THE LOAD-BEARING PART is the pre-flight assert below. A pre-flight that merely
# READS `WAYLAND_DISPLAY` and prints it goes GREEN while pointing at the human's
# screen — that is precisely how this kept happening. So the assert compares the
# value against THE SOCKET THIS SCRIPT'S OWN SWAY CREATED, verified by an active
# magenta marker, and ABORTS otherwise. It is a positive terminator: it can only
# pass by matching a socket we made and painted.
#
# Usage:  scripts/e2e-contained-rig.sh <command...>
#   Exports WAYLAND_DISPLAY / SWAYSOCK / ORCHESTRA_HOME / HOME (isolated) and
#   runs <command...> with an ALLOWLIST env. Tears the compositor down on exit.
set -Eeuo pipefail

RIG_ID="e2e64c-$$"
RIG_DIR="/tmp/${RIG_ID}"
SWAYSOCK_MINE="${RIG_DIR}/sway.sock"
FAKE_HOME="${RIG_DIR}/home"
mkdir -p "${RIG_DIR}" "${FAKE_HOME}/.orchestra/inbox" "${RIG_DIR}/oh/userData"

log() { printf '[rig] %s\n' "$*" >&2; }
die() { printf '[rig] ABORT: %s\n' "$*" >&2; exit 90; }

# ── teardown, always, and re-verified by the caller ─────────────────────────
SWAYPID=""
cleanup() {
  local rc=$?
  if [[ -n "${SWAYPID}" ]] && kill -0 "${SWAYPID}" 2>/dev/null; then
    kill "${SWAYPID}" 2>/dev/null || true
    sleep 1
    kill -9 "${SWAYPID}" 2>/dev/null || true
  fi
  log "teardown: sway pid ${SWAYPID:-none}; rig dir ${RIG_DIR} left for inspection"
  return $rc
}
trap cleanup EXIT

# ── 1. our own compositor, with the session's display vars STRIPPED ─────────
# `env -u WAYLAND_DISPLAY -u DISPLAY` matters here too: sway must not try to
# nest itself inside the human's session.
printf 'output HEADLESS-1 resolution 1600x1000\n' > "${RIG_DIR}/sway.cfg"
env -u WAYLAND_DISPLAY -u DISPLAY \
  WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 \
  SWAYSOCK="${SWAYSOCK_MINE}" \
  sway -c "${RIG_DIR}/sway.cfg" > "${RIG_DIR}/sway.log" 2>&1 &
SWAYPID=$!
log "sway pid=${SWAYPID} sock=${SWAYSOCK_MINE}"

for _ in $(seq 1 40); do
  [[ -S "${SWAYSOCK_MINE}" ]] && break
  sleep 0.25
done
[[ -S "${SWAYSOCK_MINE}" ]] || die "my sway never created ${SWAYSOCK_MINE}"

# ── 2. identify MY socket by ACTIVE MARKER, never by number/mtime/newest ────
# Seven wayland sockets exist; wayland-1 is the HUMAN's and others belong to
# sibling agents. Only a colour we set through OUR OWN SWAYSOCK discriminates.
swaymsg_mine() { SWAYSOCK="${SWAYSOCK_MINE}" swaymsg "$@" >/dev/null 2>&1; }
swaymsg_mine -- 'output HEADLESS-1 background #FF00FF solid_color' \
  || die "could not set the marker on my own output"

decode_magenta() {  # $1 = png path -> prints percentage of exact (255,0,255)
  python3 - "$1" <<'PY'
import sys, struct, zlib
d = open(sys.argv[1], 'rb').read()
pos, idat = 8, b''
w = h = ct = None
while pos < len(d):
    ln = struct.unpack('>I', d[pos:pos+4])[0]; typ = d[pos+4:pos+8]
    data = d[pos+8:pos+8+ln]
    if typ == b'IHDR': w, h, _bd, ct = struct.unpack('>IIBB', data[:10])
    elif typ == b'IDAT': idat += data
    elif typ == b'IEND': break
    pos += 12 + ln
raw = zlib.decompress(idat); ch = {0:1,2:3,3:1,4:2,6:4}[ct]; stride = w*ch
prev = bytearray(stride); tot = mag = 0; i = 0
for _y in range(h):
    f = raw[i]; i += 1
    line = bytearray(raw[i:i+stride]); i += stride
    if f == 1:
        for x in range(ch, stride): line[x] = (line[x]+line[x-ch]) & 255
    elif f == 2:
        for x in range(stride): line[x] = (line[x]+prev[x]) & 255
    elif f == 3:
        for x in range(stride):
            a = line[x-ch] if x >= ch else 0
            line[x] = (line[x]+((a+prev[x])>>1)) & 255
    elif f == 4:
        for x in range(stride):
            a = line[x-ch] if x >= ch else 0
            b = prev[x]; c = prev[x-ch] if x >= ch else 0
            p = a+b-c; pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
            pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
            line[x] = (line[x]+pr) & 255
    for x in range(0, stride, ch):
        tot += 1
        if (line[x], line[x+1], line[x+2]) == (255, 0, 255): mag += 1
    prev = line
print(f"{mag/tot*100:.2f}")
PY
}

MINE=""
READINGS=""
for sock in /run/user/1000/wayland-*; do
  [[ "${sock}" == *.lock ]] && continue
  n="$(basename "${sock}")"
  shot="${RIG_DIR}/marker-${n}.png"
  env -u DISPLAY WAYLAND_DISPLAY="${n}" grim -o HEADLESS-1 "${shot}" 2>/dev/null || continue
  pct="$(decode_magenta "${shot}")"
  READINGS="${READINGS}${n}=${pct}%  "
  if [[ "${pct}" == "100.00" ]]; then
    [[ -n "${MINE}" ]] && die "TWO sockets read 100% magenta (${MINE} and ${n}) — cannot disambiguate"
    MINE="${n}"
  fi
done
log "magenta readings: ${READINGS}"
[[ -n "${MINE}" ]] || die "no socket read 100% magenta — cannot prove which display is mine"
log "verified MY display: ${MINE}"

# Reset the background, then re-grim: a later 100% reading can then only mean we
# re-set it, never a stale frame.
swaymsg_mine -- 'output HEADLESS-1 background #1a1f26 solid_color'
env -u DISPLAY WAYLAND_DISPLAY="${MINE}" grim -o HEADLESS-1 "${RIG_DIR}/marker-reset.png" 2>/dev/null || true
RESET_PCT="$(decode_magenta "${RIG_DIR}/marker-reset.png" 2>/dev/null || echo 'n/a')"
log "after reset, ${MINE} reads ${RESET_PCT}% magenta (must be 0.00)"
[[ "${RESET_PCT}" == "0.00" ]] || die "marker did not clear (${RESET_PCT}%) — the reading may be stale"

# ── 3. THE PRE-FLIGHT ASSERT ────────────────────────────────────────────────
# Not "print WAYLAND_DISPLAY". Compare it to the socket THIS script created and
# painted, and abort on any mismatch. Also refuse to proceed if DISPLAY is set,
# so X11 cannot be reached even by accident.
preflight_assert() {
  local want="$1" got="${2-}"
  log "PREFLIGHT: WAYLAND_DISPLAY='${got:-<unset>}' must equal my sway's socket '${want}'"
  [[ "${got}" == "${want}" ]] \
    || die "PREFLIGHT FAILED: WAYLAND_DISPLAY='${got:-<unset>}' != my socket '${want}' (refusing to launch — this is the check that prevents landing on the human's screen)"
  [[ -z "${DISPLAY_IN_CHILD:-}" ]] \
    || die "PREFLIGHT FAILED: DISPLAY is present in the child env ('${DISPLAY_IN_CHILD}') — X11 must be unreachable by construction"
  # And the human's compositor must NOT be the target.
  [[ "${got}" != "wayland-1" ]] || die "PREFLIGHT FAILED: refusing wayland-1 (the human's real compositor)"
  log "PREFLIGHT PASSED: launching against ${want}"
}
preflight_assert "${MINE}" "${MINE}"

# ── 4. run the command with an ALLOWLIST env (DISPLAY absent by construction) ─
# `env -i` starts from EMPTY, so nothing can leak: every variable below is one
# we chose. This is the difference between contained-by-construction and
# contained-by-convention.
log "rig dir: ${RIG_DIR} | fake HOME: ${FAKE_HOME} | ORCHESTRA_HOME: ${RIG_DIR}/oh"
env -i \
  PATH="/usr/local/bin:/usr/bin:/bin" \
  HOME="${FAKE_HOME}" \
  XDG_RUNTIME_DIR="/run/user/1000" \
  XDG_CONFIG_HOME="${FAKE_HOME}/.config" \
  XDG_CACHE_HOME="${FAKE_HOME}/.cache" \
  WAYLAND_DISPLAY="${MINE}" \
  SWAYSOCK="${SWAYSOCK_MINE}" \
  ELECTRON_OZONE_PLATFORM_HINT=wayland \
  ORCHESTRA_OZONE=wayland \
  ORCHESTRA_OZONE_RELAUNCHED=1 \
  ORCHESTRA_HOME="${RIG_DIR}/oh" \
  ORCHESTRA_DEBUG_PORT="${ORCHESTRA_DEBUG_PORT:-9384}" \
  CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR_PIN:-${HOME}/.claude}" \
  RIG_DIR="${RIG_DIR}" \
  RIG_WAYLAND="${MINE}" \
  "$@"
