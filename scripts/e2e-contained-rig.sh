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
# PRIVATE RUNTIME WORLD (incident Q2, ledger #405). The human's gnome-keyring-daemon
# aborted twice right after rig Electrons crashed: Chromium/NSS loads p11-kit modules
# that talk to `$XDG_RUNTIME_DIR/keyring/pkcs11`, and every rig passed the REAL
# XDG_RUNTIME_DIR (/run/user/<uid>). So the rig now runs its sway AND the child in
# its OWN runtime dir (`<rig dir>/xdg`, 0700, holding only sway's wayland socket),
# pins DBUS_SESSION_BUS_ADDRESS to a nonexistent private path, and a PREFLIGHT
# (preflight_runtime_world) ABORTS before the child launches unless that world is
# private. The preflight reads strings and the private dir only — it never connects
# to, stats or lists anything under /run/user/<uid>.
#
# Usage:  scripts/e2e-contained-rig.sh <command...>
#   Exports WAYLAND_DISPLAY / SWAYSOCK / XDG_RUNTIME_DIR (private) / ORCHESTRA_HOME /
#   HOME (isolated) and runs <command...> with an ALLOWLIST env. Tears the compositor
#   down on exit. A driver MUST take XDG_RUNTIME_DIR from its own process.env — a
#   hard-coded /run/user/<uid> in a driver re-opens the hole the preflight closes.
set -Eeuo pipefail

# A mutation run (scripts/e2e-contained-rig-mutants.mjs) stamps the file it breaks; if that run was SIGKILLed the
# broken preflight would stay on disk for every rig user — so a stamped file refuses to run outside a mutation run.
if grep -q '^# RIG-MUTANT:' "${BASH_SOURCE[0]}" 2>/dev/null && [[ -z "${RIG_SELFTEST_MUTANT_RUN:-}" ]]; then
  echo "[rig] ABORT: ${BASH_SOURCE[0]} carries a RIG-MUTANT stamp (a killed mutation run left it broken) — git checkout -- scripts/e2e-contained-rig.sh" >&2; exit 90
fi

# OPT-IN BACKSTOP (RIG_HIDE_REAL_RUNTIME=1): re-exec inside a private mount namespace where the
# human's /run/user/<uid> is an EMPTY tmpfs, so even a driver that hard-codes it cannot reach the
# keyring/bus/wayland sockets. Used for a rig's FIRST Electron run and by the self-test's hidden
# arm; default OFF (rigs that need the real systemd user manager / rootless docker would break).
# The bind of / is read-write like the host; only the runtime dir is shadowed. Reads of the
# shadow below touch the empty tmpfs, never the real dir.
if [[ -n "${RIG_HIDE_REAL_RUNTIME:-}" && -z "${RIG_HIDDEN_WORLD:-}" ]]; then
  command -v bwrap >/dev/null 2>&1 || { echo "[rig] ABORT: RIG_HIDE_REAL_RUNTIME is set but bwrap is not installed" >&2; exit 90; }
  exec bwrap --dev-bind / / --tmpfs "/run/user/$(id -u)" --die-with-parent \
    env RIG_HIDDEN_WORLD=1 "${BASH_SOURCE[0]}" "$@"
fi

RIG_ID="e2e64c-$$"
# E2E_RIG_BASE relocates the rig dir (fake HOME + ORCHESTRA_HOME live under it). Default
# /tmp is unchanged; a rig whose fs is part of the instrument sets a btrfs base under ~.
RIG_BASE="${E2E_RIG_BASE:-/tmp}"
RIG_DIR="${RIG_BASE}/${RIG_ID}"
SWAYSOCK_MINE="${RIG_DIR}/sway.sock"
FAKE_HOME="${RIG_DIR}/home"
RIG_XDG="${RIG_DIR}/xdg"                    # the private XDG_RUNTIME_DIR
RIG_NO_BUS="${RIG_DIR}/no-session-bus"      # a path that must NEVER exist (the child's D-Bus address)
RIG_UID="$(id -u)"
# A rig base under /run/user is refused BEFORE anything is created there (strings + a path canonicalisation; no connection).
RIG_BASE_CANON="$(readlink -m -- "${RIG_BASE}")"
if [[ "${RIG_BASE}" == /run/user/* || "${RIG_BASE_CANON}" == /run/user/* ]]; then
  echo "[rig] ABORT: E2E_RIG_BASE='${RIG_BASE}' (resolves to '${RIG_BASE_CANON}') is under /run/user/ — a rig dir there would sit inside the human's runtime dir" >&2; exit 90
fi

# ── 0. disk preflight (issue #87) ───────────────────────────────────────────
# /tmp here is a SEPARATE tmpfs. It reached 100% during wave 6 and a verifier
# died on ENOSPC before writing a byte — indistinguishable from "the feature
# does not trigger", so it was investigated as a code defect. Fail NAMED and
# EARLY instead. This never deletes anything: the teardown below deliberately
# leaves rig dirs for inspection, and they may belong to a sibling agent
# (the sleeping-owner rule).
_RIG_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "${RIG_BASE}"
node "${_RIG_REPO_ROOT}/scripts/disk-guard.cjs" --preset e2e-rig --path "${RIG_BASE}" || exit $?

mkdir -p "${RIG_DIR}" "${FAKE_HOME}/.orchestra/inbox" "${RIG_DIR}/oh/userData"

log() { printf '[rig] %s\n' "$*" >&2; }
die() { printf '[rig] ABORT: %s\n' "$*" >&2; exit 90; }

if [[ -n "${RIG_HIDDEN_WORLD:-}" ]]; then
  [[ -z "$(ls -A "/run/user/${RIG_UID}" 2>/dev/null)" ]] \
    || die "RIG_HIDDEN_WORLD is set but /run/user/${RIG_UID} is not an empty tmpfs — this is not the shadowed world"
  log "hidden world: /run/user/${RIG_UID} is an EMPTY tmpfs inside this rig (the human's runtime dir is unreachable)"
fi

# The private runtime dir: created fresh (a leftover one could carry planted sockets),
# 0700, never a symlink. RIG_SELFTEST_SYMLINK_XDG swaps it for a link to a DECOY dir
# inside the rig dir (never anywhere else) so the self-test can watch the symlink clause fire.
[[ ! -e "${RIG_XDG}" && ! -L "${RIG_XDG}" ]] || die "private runtime dir ${RIG_XDG} already exists (stale rig dir?) — refusing to reuse it"
if [[ -n "${RIG_SELFTEST_SYMLINK_XDG:-}" ]]; then
  mkdir -p -m 700 "${RIG_DIR}/decoy-xdg" && ln -s "${RIG_DIR}/decoy-xdg" "${RIG_XDG}"
else
  mkdir -m 700 "${RIG_XDG}"
fi
[[ -z "${RIG_SELFTEST_CHMOD_XDG:-}" ]] || chmod "${RIG_SELFTEST_CHMOD_XDG}" "${RIG_XDG}"
[[ -z "${RIG_SELFTEST_PLANT_ENTRY:-}" ]] || mkdir "${RIG_XDG}/${RIG_SELFTEST_PLANT_ENTRY}"
[[ -z "${RIG_SELFTEST_PLANT_NOBUS:-}" ]] || : > "${RIG_NO_BUS}"

# ── teardown, always, and re-verified by the caller ─────────────────────────
SWAYPID=""
# A keyring daemon / p11-kit server in OUR private world can only have been spawned by something
# the rig ran (an NSS p11-kit module auto-starts one): reap it by IDENTITY — it LISTENS on a socket
# inside this rig's unique private dir (`ss`) AND its comm is a keyring/p11-kit one. Deliberately NOT a
# /proc/*/environ scan: that opens the human's own gnome-keyring-daemon's environ (permission denied,
# measured) — no rig step may touch it.
reap_private_daemons() {
  command -v ss >/dev/null 2>&1 || { log "teardown: ss missing — private keyring-daemon reap skipped"; return 0; }
  local p comm
  while read -r p; do
    [[ -n "${p}" ]] || continue
    comm="$(cat "/proc/${p}/comm" 2>/dev/null || true)"
    case "${comm}" in gnome-keyring-d*|p11-kit-*) ;; *) continue ;; esac
    log "teardown: reaping ${comm} pid ${p} (it listens inside this rig's private runtime dir)"
    kill "${p}" 2>/dev/null || true
  done < <(ss -xlpnH 2>/dev/null | grep -F " ${RIG_XDG}/" | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u)
}
cleanup() {
  local rc=$?
  if [[ -n "${SWAYPID}" ]] && kill -0 "${SWAYPID}" 2>/dev/null; then
    kill "${SWAYPID}" 2>/dev/null || true
    sleep 1
    kill -9 "${SWAYPID}" 2>/dev/null || true
  fi
  reap_private_daemons
  # Census of the private world at exit: a `keyring`/`p11-kit` entry here is the proof something
  # reached for a keyring and found OUR dir (empty of the human's daemon), not the human's.
  if [[ -d "${RIG_XDG}" ]]; then log "teardown: private runtime dir at exit: $(ls -A "${RIG_XDG}" 2>/dev/null | tr '\n' ' ')"; fi
  # In the hidden world ANYTHING present in /run/user/<uid> at exit was CREATED by this rig's
  # processes reaching for the real runtime dir: the evidence line for "nothing tried".
  if [[ -n "${RIG_HIDDEN_WORLD:-}" ]]; then log "teardown: entries created in the hidden /run/user/${RIG_UID}: [$(ls -A "/run/user/${RIG_UID}" 2>/dev/null | tr '\n' ' ')]"; fi
  log "teardown: sway pid ${SWAYPID:-none}; rig dir ${RIG_DIR} left for inspection"
  return $rc
}
trap cleanup EXIT

# ── 0b. THE PRIVATE RUNTIME WORLD: env arrays + the preflight that guards them ─
# Two arrays, built BEFORE anything is launched: SWAY_ENV (what the compositor gets) and
# CHILD_ENV (what the child gets; the wayland values join it once sway is up). The preflight
# below reads these arrays — the values that WILL reach the processes — never the variables
# that were meant to produce them.
env_get() {  # $1 = array NAME, $2 = key -> prints the value, rc 1 when absent
  local -n _arr="$1"; local kv
  for kv in "${_arr[@]}"; do
    [[ "${kv}" == "$2="* ]] && { printf '%s' "${kv#*=}"; return 0; }
  done
  return 1
}
env_has() { env_get "$1" "$2" >/dev/null; }

SWAY_ENV=(
  PATH="/usr/local/bin:/usr/bin:/bin"
  HOME="${FAKE_HOME}"
  XDG_RUNTIME_DIR="${RIG_XDG}"
  DBUS_SESSION_BUS_ADDRESS="unix:path=${RIG_NO_BUS}"
  WLR_BACKENDS=headless
  WLR_LIBINPUT_NO_DEVICES=1
  SWAYSOCK="${SWAYSOCK_MINE}"
)
CHILD_ENV=(
  PATH="/usr/local/bin:/usr/bin:/bin"
  HOME="${FAKE_HOME}"
  XDG_RUNTIME_DIR="${RIG_XDG}"
  DBUS_SESSION_BUS_ADDRESS="unix:path=${RIG_NO_BUS}"
  XDG_CONFIG_HOME="${FAKE_HOME}/.config"
  XDG_CACHE_HOME="${FAKE_HOME}/.cache"
  SWAYSOCK="${SWAYSOCK_MINE}"
  ELECTRON_OZONE_PLATFORM_HINT=wayland
  ORCHESTRA_OZONE=wayland
  ORCHESTRA_OZONE_RELAUNCHED=1
  ORCHESTRA_HOME="${RIG_DIR}/oh"
  ORCHESTRA_DEBUG_PORT="${ORCHESTRA_DEBUG_PORT:-9384}"
  CLAUDE_CONFIG_DIR="${CLAUDE_CONFIG_DIR_PIN:-${HOME}/.claude}"
  RIG_DIR="${RIG_DIR}"
)
# RIG_SELFTEST_* exist ONLY so the self-test can inject a hostile env into the CHILD array and
# watch the preflight abort. Never set in normal operation; they never touch what sway gets.
# The preflight reads the array either way, so the tested code path is the shipped one.
set_env_in() {  # $1 = array NAME, $2 = key, $3 = value — replace in place, or append
  local -n _tgt="$1"; local i
  for i in "${!_tgt[@]}"; do
    if [[ "${_tgt[$i]}" == "$2="* ]]; then _tgt[$i]="$2=$3"; return 0; fi
  done
  _tgt+=("$2=$3")
}
set_child_env() { set_env_in CHILD_ENV "$1" "$2"; }
# self-test only; the arm that uses it ALWAYS runs inside the hidden world, so even a broken preflight could not start sway in the real dir
[[ -z "${RIG_SELFTEST_FORCE_SWAY_XDG:-}" ]] || set_env_in SWAY_ENV XDG_RUNTIME_DIR "${RIG_SELFTEST_FORCE_SWAY_XDG}"
[[ -z "${RIG_SELFTEST_FORCE_XDG_RUNTIME_DIR:-}" ]] || set_child_env XDG_RUNTIME_DIR "${RIG_SELFTEST_FORCE_XDG_RUNTIME_DIR}"
[[ -z "${RIG_SELFTEST_FORCE_DBUS:-}" ]] || set_child_env DBUS_SESSION_BUS_ADDRESS "${RIG_SELFTEST_FORCE_DBUS}"
[[ -z "${RIG_SELFTEST_ADD_ENV:-}" ]] || CHILD_ENV+=("${RIG_SELFTEST_ADD_ENV}")

norm_path() {  # lexical: collapse `//`, `/./` and `x/../` so /run//user/1000, /run/./user/1000, /run/x/../user/1000 cannot slip a string compare
  local - ; set -f
  local v="$1" seg lead="" IFS=/
  local -a out=()
  [[ "${v}" == /* ]] && lead="/"
  for seg in ${v}; do   # unquoted on purpose: splits on '/', empty segments vanish
    case "${seg}" in
      ''|.) ;;
      ..) if (( ${#out[@]} > 0 )) && [[ "${out[-1]}" != .. ]]; then unset 'out[-1]'; else out+=(..); fi ;;
      *) out+=("${seg}") ;;
    esac
  done
  printf '%s%s' "${lead}" "${out[*]}"
}

# THE RUNTIME-WORLD PREFLIGHT (incident Q2). Aborts rc=90 unless the world the processes are
# about to get is PRIVATE. Strings and the private dir only: it never connects to, stats, or
# lists anything under /run/user/<uid> (the one filesystem call on a path that failed the string
# tests is skipped — a failing string test dies first).
#   $1 = array name (CHILD_ENV | SWAY_ENV) · $2 = stage label for the log
preflight_runtime_world() {
  local arr="$1" stage="$2" xdg xdgn dbus kv name k v seen=" " resolved real_rt="/run/user/${RIG_UID}"
  local -n _chk="${arr}"
  xdg="$(env_get "${arr}" XDG_RUNTIME_DIR || true)"
  dbus="$(env_get "${arr}" DBUS_SESSION_BUS_ADDRESS || true)"
  log "PREFLIGHT-RUNTIME[${stage}/${arr}]: XDG_RUNTIME_DIR='${xdg:-<unset>}' DBUS_SESSION_BUS_ADDRESS='${dbus:-<unset>}'"

  # R0 — a key may appear once: `env -i` lets the LAST duplicate win while env_get reads the FIRST, so a duplicate
  #      would let the child get a value this preflight never looked at.
  for kv in "${_chk[@]}"; do
    k="${kv%%=*}"
    [[ "${seen}" != *" ${k} "* ]] || die "PREFLIGHT-RUNTIME FAILED: ${arr} carries '${k}' more than once — the last one would win and this preflight read the first"
    seen+="${k} "
  done

  [[ -n "${xdg}" ]] || die "PREFLIGHT-RUNTIME FAILED: ${arr} carries no XDG_RUNTIME_DIR (an unset one makes libdbus/NSS fall back to the human's /run/user/${RIG_UID})"
  # R1 — the human's runtime dir, or anything under it. Compared as STRINGS, first (after collapsing // and /./).
  xdgn="$(norm_path "${xdg}")"
  [[ "${xdgn}" != "${real_rt}" && "${xdgn}" != "${real_rt}/"* && "${xdgn}" != "/run/user/"* ]] \
    || die "PREFLIGHT-RUNTIME FAILED: ${arr} XDG_RUNTIME_DIR='${xdg}' is the human's runtime dir (${real_rt}) — it holds the keyring/PKCS#11 sockets a crashing rig Electron aborted twice (incident Q2)"
  # R2 — must be this rig's own private dir, under the rig dir.
  [[ "${xdg}" == "${RIG_XDG}" ]] \
    || die "PREFLIGHT-RUNTIME FAILED: ${arr} XDG_RUNTIME_DIR='${xdg}' is not this rig's private dir '${RIG_XDG}' (not under the rig dir)"
  # R3 — a symlink would be a path under the rig dir that lands anywhere.
  [[ ! -L "${xdg}" ]] || die "PREFLIGHT-RUNTIME FAILED: private runtime dir '${xdg}' is a symlink (it could point at the human's runtime dir)"
  resolved="$(readlink -f -- "${xdg}")"
  [[ "${resolved}" != "/run/user/"* ]] || die "PREFLIGHT-RUNTIME FAILED: private runtime dir '${xdg}' resolves to '${resolved}' — the human's runtime dir"
  # R4 — ours, a directory, 0700.
  [[ -d "${xdg}" && -O "${xdg}" && "$(stat -c %a -- "${xdg}")" == "700" ]] \
    || die "PREFLIGHT-RUNTIME FAILED: private runtime dir '${xdg}' is not a directory owned by me with mode 0700 (mode '$(stat -c %a -- "${xdg}" 2>/dev/null || echo '?')')"
  # R5 — nothing in it may look like a keyring / session-bus / pulse endpoint.
  for kv in "${xdg}"/keyring* "${xdg}"/bus* "${xdg}"/pulse* "${xdg}"/p11-kit*; do
    [[ -e "${kv}" || -L "${kv}" ]] || continue
    name="${kv##*/}"
    die "PREFLIGHT-RUNTIME FAILED: private runtime dir '${xdg}' contains '${name}' — a keyring/bus/pulse endpoint must never be reachable from a rig"
  done
  # R6 — the child's session bus is a private path that does not exist.
  [[ "${dbus}" == "unix:path=${RIG_NO_BUS}" ]] \
    || die "PREFLIGHT-RUNTIME FAILED: ${arr} DBUS_SESSION_BUS_ADDRESS='${dbus:-<unset>}' is not the private nonexistent 'unix:path=${RIG_NO_BUS}' (an unset or real address reaches the human's session bus)"
  [[ ! -e "${RIG_NO_BUS}" && ! -L "${RIG_NO_BUS}" ]] \
    || die "PREFLIGHT-RUNTIME FAILED: the private session-bus path '${RIG_NO_BUS}' exists — it must not (something could be listening on it)"
  # R7 — no value anywhere in the env may carry a /run/user path (GNOME_KEYRING_CONTROL, a PATH entry, …).
  for kv in "${_chk[@]}"; do
    v="$(norm_path "${kv#*=}")"
    [[ "${v}" != *"/run/user/"* ]] \
      || die "PREFLIGHT-RUNTIME FAILED: ${arr} entry '${kv%%=*}' contains '/run/user/' (value '${kv#*=}') — no path into the human's runtime dir may reach a rig process"
  done
  # R8 — the private dir hosts the app's unix sockets: the hooks socket `/orchestra-<12hex>.sock` (23 chars) must fit sun_path (107) => dir <= 84.
  #      (The phone-access socket `/orchestra-acces-mobile-<12hex>.sock` is 41 chars => dir <= 66: its wrapper uses a short base.)
  (( ${#xdg} <= 84 )) \
    || die "PREFLIGHT-RUNTIME FAILED: private runtime dir path is ${#xdg} chars (> 84) — the app's hooks socket path inside it would exceed sun_path (107); use a shorter E2E_RIG_BASE"
  log "PREFLIGHT-RUNTIME PASSED[${stage}/${arr}]: private world (xdg=${xdg}, bus=${dbus}, no /run/user/ in any value)"
}
preflight_runtime_world CHILD_ENV pre-sway
preflight_runtime_world SWAY_ENV pre-sway

# ── 1. our own compositor, in the private runtime world ─────────────────────
# `env -i` (not `env -u`): sway gets ONLY SWAY_ENV — no WAYLAND_DISPLAY/DISPLAY of the human's
# session to nest into, and no real XDG_RUNTIME_DIR/DBUS address to reach.
printf 'output HEADLESS-1 resolution 1600x1000\n' > "${RIG_DIR}/sway.cfg"
env -i "${SWAY_ENV[@]}" \
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
#
# THE MARKER COLOUR IS A SHARED NAMESPACE, and that is not theoretical: during
# this rig's own self-test a sibling agent was painting #FF00FF at the same
# moment (every agent follows the same documented recipe), and the
# two-sockets-read-100% guard below correctly refused to guess. Refusing is safe
# but it also makes the rig flaky for no reason, so the marker is now UNIQUE PER
# RIG: the pid is folded into the green+blue channels, keeping red pinned at FF
# so the colour stays obviously synthetic and unlike any real UI.
MARK_G="$(printf '%02X' $(( ($$ / 251) % 256 )))"
MARK_B="$(printf '%02X' $(( $$ % 251 + 5 )))"
MARKER="FF${MARK_G}${MARK_B}"
MARK_R_DEC=255; MARK_G_DEC=$((16#${MARK_G})); MARK_B_DEC=$((16#${MARK_B}))
log "unique marker for this rig: #${MARKER} (rgb ${MARK_R_DEC},${MARK_G_DEC},${MARK_B_DEC})"
swaymsg_mine() { env -i PATH="/usr/local/bin:/usr/bin:/bin" SWAYSOCK="${SWAYSOCK_MINE}" swaymsg "$@" >/dev/null 2>&1; }
swaymsg_mine -- "output HEADLESS-1 background #${MARKER} solid_color" \
  || die "could not set the marker on my own output"

decode_marker() {  # $1 = png -> % of pixels exactly equal to THIS rig's marker
  python3 - "$1" "${MARK_R_DEC}" "${MARK_G_DEC}" "${MARK_B_DEC}" <<'PY'
import sys, struct, zlib
WANT = (int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]))
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
        if (line[x], line[x+1], line[x+2]) == WANT: mag += 1
    prev = line
print(f"{mag/tot*100:.2f}")
PY
}

# The candidates are the sockets in OUR private runtime dir ONLY — the human's compositor and
# every sibling's live in /run/user/<uid>, which this script never lists nor connects to.
MINE=""
READINGS=""
for sock in "${RIG_XDG}"/wayland-*; do
  [[ -S "${sock}" ]] || continue
  n="$(basename "${sock}")"
  shot="${RIG_DIR}/marker-${n}.png"
  # Poll (≤ ~8 s): a loaded host (load 40-60) has not composited the new background on the first
  # frame, and a single early 0.00% read is a flaky abort, not a finding.
  pct=""
  for _try in $(seq 1 32); do
    env -i PATH="/usr/local/bin:/usr/bin:/bin" XDG_RUNTIME_DIR="${RIG_XDG}" WAYLAND_DISPLAY="${n}" \
      grim -o HEADLESS-1 "${shot}" 2>/dev/null || { pct=""; sleep 0.25; continue; }
    pct="$(decode_marker "${shot}")"
    [[ "${pct}" == "100.00" ]] && break
    sleep 0.25
  done
  [[ -n "${pct}" ]] || continue
  READINGS="${READINGS}${n}=${pct}%  "
  if [[ "${pct}" == "100.00" ]]; then
    [[ -n "${MINE}" ]] && die "TWO sockets read 100% of MY unique marker #${MARKER} (${MINE} and ${n}) — cannot disambiguate"
    MINE="${n}"
  fi
done
log "marker #${MARKER} readings: ${READINGS}"
[[ -n "${MINE}" ]] || die "no socket read 100% of marker #${MARKER} — cannot prove which display is mine"
log "verified MY display: ${MINE}"

# Reset the background, then re-grim: a later 100% reading can then only mean we
# re-set it, never a stale frame.
swaymsg_mine -- 'output HEADLESS-1 background #1a1f26 solid_color'
RESET_PCT="n/a"
for _try in $(seq 1 32); do   # poll until the cleared frame is composited (same loaded-host reason)
  env -i PATH="/usr/local/bin:/usr/bin:/bin" XDG_RUNTIME_DIR="${RIG_XDG}" WAYLAND_DISPLAY="${MINE}" \
    grim -o HEADLESS-1 "${RIG_DIR}/marker-reset.png" 2>/dev/null || { sleep 0.25; continue; }
  RESET_PCT="$(decode_marker "${RIG_DIR}/marker-reset.png" 2>/dev/null || echo 'n/a')"
  [[ "${RESET_PCT}" == "0.00" ]] && break
  sleep 0.25
done
log "after reset, ${MINE} reads ${RESET_PCT}% of #${MARKER} (must be 0.00)"
[[ "${RESET_PCT}" == "0.00" ]] || die "marker did not clear (${RESET_PCT}%) — the reading may be stale"

# ── 2b. the NAME the child connects by ─────────────────────────────────────
# A fresh private dir makes sway name its socket `wayland-1` (measured) — the very name ~15 drivers
# refuse as "the human's compositor". And a driver that still hard-codes the real XDG_RUNTIME_DIR while
# taking the rig's display NAME would resolve that name in the human's dir. So the child connects through
# an alias that cannot exist in the human's dir: `wayland-rig` → my verified socket (created only now,
# after the marker pass, so it can never be read as a second candidate). Such a mixed env fails closed.
RIG_WL_ALIAS="wayland-rig"
ln -s "${RIG_SELFTEST_ALIAS_TARGET:-${MINE}}" "${RIG_XDG}/${RIG_WL_ALIAS}"   # RIG_SELFTEST_ALIAS_TARGET: self-test only (a wrong target)
log "child display alias: ${RIG_WL_ALIAS} -> ${MINE} (inside ${RIG_XDG})"

# ── 3. BUILD THE CHILD ENV ONCE, THEN ASSERT WHAT THE CHILD WILL ACTUALLY GET ─
# The env is constructed as an ARRAY first so the assert can read the very values
# that will reach the child, rather than the variables we hope produced them.
#
# Two defects this shape exists to prevent, both found in review of the previous
# version, and both of the same class — a guard that reads as protection but
# provably cannot fire:
#   (1) a `DISPLAY_IN_CHILD` check that was never assigned anywhere, so the
#       branch was unreachable decoration;
#   (2) `preflight_assert "$MINE" "$MINE"` — the same variable on both sides, so
#       the equality compared a value to itself and could not fail regardless of
#       what the child actually received.
# The containment was still real (env -i pins WAYLAND_DISPLAY and omits DISPLAY),
# but the check DOCUMENTED as load-bearing was not. Now the assert parses the
# constructed env, so it fails if the construction and the intent ever drift.
# The rest of the child env (PATH, HOME, the PRIVATE XDG_RUNTIME_DIR, the nonexistent session bus,
# …) was built in section 0b; only the display values were waiting for the verified socket.
set_child_env WAYLAND_DISPLAY "${RIG_WL_ALIAS}"
set_child_env RIG_WAYLAND "${RIG_WL_ALIAS}"
[[ -z "${RIG_SELFTEST_FORCE_WAYLAND:-}" ]] || set_child_env WAYLAND_DISPLAY "${RIG_SELFTEST_FORCE_WAYLAND}"
[[ -z "${RIG_SELFTEST_ADD_DISPLAY:-}" ]] || CHILD_ENV+=(DISPLAY="${RIG_SELFTEST_ADD_DISPLAY}")
# LATE: appended only now, after sway is up — proves the launch-stage preflight reads the FINAL array.
[[ -z "${RIG_SELFTEST_LATE_ADD_ENV:-}" ]] || CHILD_ENV+=("${RIG_SELFTEST_LATE_ADD_ENV}")

# Read a variable back OUT of the constructed child env. Prints nothing when the
# variable is absent, which is how the DISPLAY check becomes real: absence is now
# an observed property of the array, not an assumption.
child_env_get() { env_get CHILD_ENV "$1"; }
child_env_has() { env_has CHILD_ENV "$1"; }

# THE PRE-FLIGHT ASSERT. Not "print WAYLAND_DISPLAY" — that goes green while
# pointing at the human's screen, which is exactly how test windows kept
# escaping. This compares the value THE CHILD WILL RECEIVE against the socket
# this script's own sway created and painted magenta, and aborts otherwise.
preflight_assert() {
  local want="$1" target="$2"
  local got; got="$(child_env_get WAYLAND_DISPLAY || true)"
  log "PREFLIGHT: child WAYLAND_DISPLAY='${got:-<unset>}' must equal my sway's socket alias '${want}' (-> '${target}')"

  [[ -n "${got}" ]] \
    || die "PREFLIGHT FAILED: the child env carries no WAYLAND_DISPLAY at all"

  # ORDER MATTERS, and getting it wrong makes a guard unreachable — which is the
  # same defect class as an unassigned variable, just wearing control flow. This
  # refusal sits BEFORE the equality check so it is an independent, reachable guard
  # (proven by the self-test, which requires THIS message). Since the private runtime
  # dir, a bare socket NAME can only resolve inside it (the human's compositor is
  # `wayland-1` in /run/user/<uid>, and our own sway may legitimately be `wayland-1`
  # in ITS dir — so a name-based refusal is meaningless now); a PATH is the one value
  # that can still reach the human's compositor, so a path is what is refused.
  [[ "${got}" != */* ]] \
    || die "PREFLIGHT FAILED: WAYLAND_DISPLAY='${got}' is a path, not a bare socket name — refusing (an absolute path escapes the private runtime dir and can reach the human's compositor)"
  [[ "${got}" == "${want}" ]] \
    || die "PREFLIGHT FAILED: child WAYLAND_DISPLAY='${got}' != my marker-verified socket '${want}' (refusing to launch — this is the check that prevents landing on the human's or a sibling's screen)"

  # The alias must really lead to the socket whose marker I read (not to a sibling's, not to a path elsewhere).
  [[ -S "${RIG_XDG}/${want}" && "$(readlink -- "${RIG_XDG}/${want}")" == "${target}" ]] \
    || die "PREFLIGHT FAILED: '${want}' does not resolve to my marker-verified socket '${target}'"

  # DISPLAY must be ABSENT FROM THE ARRAY. `env -i` already guarantees nothing
  # leaks, so this is not a second layer of protection — it is the assertion
  # that our own construction did not ADD one back.
  if child_env_has DISPLAY; then
    die "PREFLIGHT FAILED: the child env sets DISPLAY='$(child_env_get DISPLAY)' — X11 must be unreachable by construction"
  fi
  log "PREFLIGHT PASSED: child gets WAYLAND_DISPLAY=${got}, DISPLAY absent (verified against the constructed env)"
}
preflight_assert "${RIG_WL_ALIAS}" "${MINE}"
preflight_runtime_world CHILD_ENV launch


# ── 4. run the command with that exact env ─────────────────────────────────
log "rig dir: ${RIG_DIR} | fake HOME: ${FAKE_HOME} | ORCHESTRA_HOME: ${RIG_DIR}/oh | XDG_RUNTIME_DIR: ${RIG_XDG}"
env -i "${CHILD_ENV[@]}" "$@"
