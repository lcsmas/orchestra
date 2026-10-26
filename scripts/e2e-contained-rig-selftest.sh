#!/usr/bin/env bash
# Self-test for scripts/e2e-contained-rig.sh — proves the rig's two preflights can
# FAIL: the display preflight (issue #64/#76) and the RUNTIME-WORLD preflight
# (incident Q2, ledger #405: a rig must never reach the human's gnome-keyring).
# A guard nobody has watched fire is indistinguishable from one that cannot, and
# the first version of the display assert PROVABLY could not (an unassigned
# variable, a value compared to itself). This file exists so that class cannot
# come back unnoticed.
#
# Every arm runs the REAL rig script (no extracted copy — an extract can drift
# from what ships) with `/bin/sh -c 'echo SENTINEL'` as the child, so nothing but
# the rig is exercised — NEVER Electron. A hostile arm injects its hostile value
# through RIG_SELFTEST_* into the CHILD env array only; the rig aborts before
# launching, so the value is never handed to a process. The positive terminator
# is the literal `ABORT` / `PREFLIGHT ... PASSED` line plus the exit code, and the
# child echoes a sentinel so we can tell "aborted before launch" from "launched
# and the child said nothing". Each arm also requires ITS OWN abort reason: an
# arm that aborts for a different clause than the one it tests protects nothing.
#
# RIG_SELFTEST_ONLY="ID ID …" runs a subset (the mutation driver uses it). A
# subset can never print PASSED — it prints PARTIAL, which the wrapper treats as
# a failure — so a filtered run is never mistaken for the whole gate.
set -uo pipefail

RIG="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e-contained-rig.sh"
[[ -x "${RIG}" ]] || { echo "FATAL: ${RIG} not executable"; exit 2; }
# A stamped rig is a mutant left behind by a killed mutation run: gating it would certify a broken preflight.
if grep -q '^# RIG-MUTANT:' "${RIG}" && [[ -z "${RIG_SELFTEST_MUTANT_RUN:-}" ]]; then
  echo "RIG-SELFTEST: PRECONDITION-UNMET rig-is-a-stamped-mutant"; echo "FATAL: ${RIG} carries a RIG-MUTANT stamp — git checkout -- scripts/e2e-contained-rig.sh" >&2; exit 2
fi

# ── FAIL-CLOSED PRECONDITIONS (issue #76) ──────────────────────────────────
# This self-test needs a REAL compositor: every sway-booting arm boots the rig's
# own sway and decodes a painted marker. It therefore cannot live in `pnpm run
# test`, which must stay runnable on a headless CI box.
#
# The failure mode being designed against is NOT "it errors on CI" — it is a
# SELF-SKIP that reports a comfortable green. Wave-6 shipped exactly that shape:
# 12 CLI tests self-skipped on a missing build artifact inside a suite reported
# as "1039 pass", silently omitting every CLI regression test. A test that skips
# itself is an ABSENT FAILURE wearing a pass.
#
# So this script NEVER skips. A missing dependency is a NAMED, non-zero exit
# (rc=2, distinct from rc=1 "an arm failed"), and the outcome is emitted as a
# single machine-readable RIG-SELFTEST: line that a caller can grep. Absence of
# that line is itself a detectable outcome — silence is never scored as success.
missing=()
for dep in sway swaymsg grim python3 bwrap; do
  command -v "${dep}" >/dev/null 2>&1 || missing+=("${dep}")
done
if (( ${#missing[@]} > 0 )); then
  echo "RIG-SELFTEST: PRECONDITION-UNMET missing=${missing[*]}"
  cat >&2 <<EOF
FATAL: cannot run the rig self-test — missing: ${missing[*]}

  This self-test boots a real headless sway compositor and decodes a painted
  marker from a screenshot (and one arm re-runs the rig inside a bubblewrap
  namespace that hides /run/user/<uid>); it cannot be simulated. It is
  deliberately NOT part of \`pnpm run test\` for that reason.

  Run it on a host with sway + bwrap available:   pnpm run test:rig-selftest

  It exits 2 (precondition unmet) rather than skipping, because a self-skipping
  test reports a green that hides an absent gate. (issue #76)
EOF
  exit 2
fi

UID_NOW="$(id -u)"
SENTINEL='CHILD-LAUNCHED-SENTINEL-64'
# Scratch rig base: SHORT (the private runtime dir hosts unix sockets, see preflight R8) and
# disk-backed; every arm's rig dir lives here and is removed at exit (this dir is ours, made by mktemp).
ST_BASE="$(mktemp -d /var/tmp/rst-XXXXXX)" || { echo "FATAL: cannot make the scratch rig base"; exit 2; }
[[ "${ST_BASE}" == /var/tmp/rst-* && -d "${ST_BASE}" ]] || { echo "FATAL: unexpected scratch base '${ST_BASE}'"; exit 2; }
cleanup_st() { [[ "${ST_BASE}" == /var/tmp/rst-* ]] && rm -rf -- "${ST_BASE}"; }
trap cleanup_st EXIT

fails=0
ran=0
declare -A SEEN=()
pass() { printf '  PASS  %s\n' "$1"; }
fail() { printf '  FAIL  %s — %s\n' "$1" "$2"; fails=$((fails + 1)); }
selected() { [[ -z "${RIG_SELFTEST_ONLY:-}" ]] || [[ " ${RIG_SELFTEST_ONLY} " == *" $1 "* ]]; }

# $1 id · $2 label · $3 expected rc · $4 expect-launch (yes|no) · $5 REQUIRED reason
# (grep -E regex over the rig's output) · $6.. env assignments.
#
# The reason match is load-bearing: an arm that aborts for a DIFFERENT reason
# than the one it was written to test is a right answer from the wrong check,
# and it protects nothing. That happened for real here — a "bogus socket" arm
# passed because a SIBLING agent was painting the same marker colour at that
# instant, tripping the disambiguation guard instead of the mismatch check.
arm() {
  local id="$1" label="$2" want_rc="$3" want_launch="$4" want_reason="$5"; shift 5
  selected "${id}" || return 0
  ran=$((ran + 1)); SEEN["${id}"]=1
  label="${id} ${label}"
  local out rc
  out="$(env E2E_RIG_BASE="${ST_BASE}" "$@" "${RIG}" /bin/sh -c "echo ${SENTINEL}" 2>&1)"; rc=$?
  local launched='no'
  grep -q "${SENTINEL}" <<<"${out}" && launched='yes'
  local line
  line="$(grep -E 'PREFLIGHT(-RUNTIME)? (PASSED|FAILED)|ABORT' <<<"${out}" | tail -1)"

  if [[ "${rc}" != "${want_rc}" ]]; then
    fail "${label}" "rc=${rc}, expected ${want_rc}"; printf '        %s\n' "${line}"; return
  fi
  if [[ "${launched}" != "${want_launch}" ]]; then
    fail "${label}" "child launched=${launched}, expected ${want_launch}"; return
  fi
  if [[ -n "${want_reason}" ]] && ! grep -qE -- "${want_reason}" <<<"${out}"; then
    fail "${label}" "aborted/passed for the WRONG reason (wanted /${want_reason}/)"
    printf '        got: %s\n' "${line}"; return
  fi
  # ARM_ABSENT (set per call): a line that must NOT appear — the pre-sway arms assert `sway pid=` is
  # absent, i.e. the abort happened BEFORE the compositor (let alone the child) started.
  if [[ -n "${ARM_ABSENT:-}" ]] && grep -qE -- "${ARM_ABSENT}" <<<"${out}"; then
    fail "${label}" "/${ARM_ABSENT}/ appeared — the abort came too late (after it)"; return
  fi
  pass "${label} (rc=${rc}, launched=${launched}, reason verified)"
  printf '        %s\n' "${line}"
}

REAL_RT="/run/user/${UID_NOW}"
LONG_BASE="${ST_BASE}/$(printf 'x%.0s' {1..75})"

echo "== self-test A: the DISPLAY preflight must ABORT on hostile input =="

# W1. The human's real compositor, handed over BY PATH — the only way it is still reachable
#     now that the child's XDG_RUNTIME_DIR is private (a bare name resolves inside it).
arm W1 "forcing WAYLAND_DISPLAY=${REAL_RT}/wayland-1 (the human's screen, by path) ABORTS" 90 no \
  "is a path, not a bare socket name" \
  RIG_SELFTEST_FORCE_WAYLAND="${REAL_RT}/wayland-1"

# W2. A plausible-but-wrong socket: a sibling agent's headless compositor. Passing
#     here would mean gating against another agent's build.
arm W2 "forcing a SIBLING socket (wayland-4) ABORTS" 90 no \
  "!= my marker-verified socket" \
  RIG_SELFTEST_FORCE_WAYLAND=wayland-4

# W3. Outright bogus value.
arm W3 "forcing a bogus socket (wayland-999) ABORTS on the MISMATCH check" 90 no \
  "!= my marker-verified socket" \
  RIG_SELFTEST_FORCE_WAYLAND=wayland-999

# W5. The name sway gave its own socket (`wayland-1`, also the human's compositor name): the child
#     must get the alias, never the raw name — drivers refuse `wayland-1` outright.
arm W5 "forcing WAYLAND_DISPLAY=wayland-1 (the raw sway name, not the alias) ABORTS" 90 no \
  "!= my marker-verified socket" \
  RIG_SELFTEST_FORCE_WAYLAND=wayland-1

# W6. An alias that does not lead to the marker-verified socket.
arm W6 "a display alias pointing at the WRONG socket ABORTS" 90 no \
  "does not resolve to my marker-verified socket" \
  RIG_SELFTEST_ALIAS_TARGET=wayland-9

# W4. THE PREVIOUSLY-DEAD BRANCH. This is the arm that proves the DISPLAY check is
#     reachable at all: the old one could not fire because the variable it read
#     was never assigned.
arm W4 "adding DISPLAY=:0 to the child env ABORTS (branch is REACHABLE)" 90 no \
  "X11 must be unreachable by construction" \
  RIG_SELFTEST_ADD_DISPLAY=:0

echo
echo "== self-test B: the RUNTIME-WORLD preflight must ABORT on a hostile world (incident Q2) =="

# R1. XDG_RUNTIME_DIR = the human's runtime dir (where gnome-keyring's bus/keyring/pkcs11 sockets live).
ARM_ABSENT='sway pid=' arm R1a "forcing XDG_RUNTIME_DIR=${REAL_RT} ABORTS" 90 no \
  "is the human's runtime dir" \
  RIG_SELFTEST_FORCE_XDG_RUNTIME_DIR="${REAL_RT}"
ARM_ABSENT='sway pid=' arm R1b "forcing XDG_RUNTIME_DIR=${REAL_RT}/rig-private (a dir UNDER it) ABORTS" 90 no \
  "is the human's runtime dir" \
  RIG_SELFTEST_FORCE_XDG_RUNTIME_DIR="${REAL_RT}/rig-private"
# R2. Not the rig's own dir (a different, harmless dir).
ARM_ABSENT='sway pid=' arm R2 "forcing XDG_RUNTIME_DIR outside the rig dir ABORTS" 90 no \
  "is not this rig's private dir" \
  RIG_SELFTEST_FORCE_XDG_RUNTIME_DIR="${ST_BASE}/elsewhere"
# R3. The private dir swapped for a SYMLINK (to a decoy inside the rig dir — never to anything real).
ARM_ABSENT='sway pid=' arm R3 "a private runtime dir that is a SYMLINK ABORTS" 90 no \
  "is a symlink" \
  RIG_SELFTEST_SYMLINK_XDG=1
# R4. Mode other than 0700.
ARM_ABSENT='sway pid=' arm R4 "a private runtime dir with mode 0755 ABORTS" 90 no \
  "mode 0700" \
  RIG_SELFTEST_CHMOD_XDG=755
# R5. A keyring / bus / pulse endpoint inside the private dir (planted as plain dirs).
ARM_ABSENT='sway pid=' arm R5a "a 'keyring' entry in the private runtime dir ABORTS" 90 no \
  "contains 'keyring'" \
  RIG_SELFTEST_PLANT_ENTRY=keyring
ARM_ABSENT='sway pid=' arm R5b "a 'bus' entry in the private runtime dir ABORTS" 90 no \
  "contains 'bus'" \
  RIG_SELFTEST_PLANT_ENTRY=bus
ARM_ABSENT='sway pid=' arm R5c "a 'pulse' entry in the private runtime dir ABORTS" 90 no \
  "contains 'pulse'" \
  RIG_SELFTEST_PLANT_ENTRY=pulse
ARM_ABSENT='sway pid=' arm R5d "a 'p11-kit' entry in the private runtime dir ABORTS" 90 no \
  "contains 'p11-kit'" \
  RIG_SELFTEST_PLANT_ENTRY=p11-kit
# R0/R1c. A DUPLICATE key (env -i lets the last win; the preflight reads the first) and a disguised real path.
ARM_ABSENT='sway pid=' arm R0 "a DUPLICATE XDG_RUNTIME_DIR (second entry /run//user/<uid>) ABORTS" 90 no \
  "carries 'XDG_RUNTIME_DIR' more than once" \
  RIG_SELFTEST_ADD_ENV="XDG_RUNTIME_DIR=/run//user/${UID_NOW}"
ARM_ABSENT='sway pid=' arm R1c "forcing XDG_RUNTIME_DIR=/run/./user/<uid> (disguised real dir) ABORTS" 90 no \
  "is the human's runtime dir" \
  RIG_SELFTEST_FORCE_XDG_RUNTIME_DIR="/run/./user/${UID_NOW}"
# R6. The child's session bus.
ARM_ABSENT='sway pid=' arm R6a "forcing DBUS_SESSION_BUS_ADDRESS=unix:path=${REAL_RT}/bus (the human's bus) ABORTS" 90 no \
  "is not the private nonexistent" \
  RIG_SELFTEST_FORCE_DBUS="unix:path=${REAL_RT}/bus"
ARM_ABSENT='sway pid=' arm R6b "forcing DBUS_SESSION_BUS_ADDRESS=disabled: (not the pinned private path) ABORTS" 90 no \
  "is not the private nonexistent" \
  RIG_SELFTEST_FORCE_DBUS="disabled:"
ARM_ABSENT='sway pid=' arm R6c "the private session-bus path EXISTING ABORTS" 90 no \
  "exists — it must not" \
  RIG_SELFTEST_PLANT_NOBUS=1
# R7. An env VALUE carrying a /run/user path, pre-sway (a keyring control var) and late (after sway is up).
ARM_ABSENT='sway pid=' arm R7a "an env value containing ${REAL_RT} (GNOME_KEYRING_CONTROL) ABORTS before sway" 90 no \
  "entry 'GNOME_KEYRING_CONTROL' contains '/run/user/'" \
  RIG_SELFTEST_ADD_ENV="GNOME_KEYRING_CONTROL=${REAL_RT}/keyring"
arm R7b "an env value containing ${REAL_RT} added AFTER sway ABORTS at the launch preflight" 90 no \
  "entry 'LATE_FOO' contains '/run/user/'" \
  RIG_SELFTEST_LATE_ADD_ENV="LATE_FOO=/x${REAL_RT}/y"
arm R7c "a DISGUISED /run/user path (…/run/y/../user//<uid>/z) added after sway ABORTS" 90 no \
  "entry 'LATE_BAR' contains '/run/user/'" \
  RIG_SELFTEST_LATE_ADD_ENV="LATE_BAR=/x/run/y/../user//${UID_NOW}/z"
# R9. The two guards that run before anything exists, each inside the HIDDEN world so that even a broken guard could
#     only ever touch an empty tmpfs: sway's OWN env carrying the real runtime dir, and a rig base under /run/user.
ARM_ABSENT='sway pid=' arm R9s "SWAY_ENV carrying the real XDG_RUNTIME_DIR ABORTS before sway starts" 90 no \
  "SWAY_ENV XDG_RUNTIME_DIR='${REAL_RT}' is the human's runtime dir" \
  RIG_HIDE_REAL_RUNTIME=1 RIG_SELFTEST_FORCE_SWAY_XDG="${REAL_RT}"
ARM_ABSENT='disk-guard OK|sway pid=' arm R9b "E2E_RIG_BASE under /run/user/<uid> ABORTS before anything is created there" 90 no \
  "is under /run/user/ — a rig dir there would sit inside the human's runtime dir" \
  RIG_HIDE_REAL_RUNTIME=1 E2E_RIG_BASE="${REAL_RT}/rig-base-selftest"
# R10. A rig base that is a SYMLINK into the runtime dir (the link TEXT names it; it is only ever followed inside the hidden world's empty tmpfs):
#      the canonicalised base check must abort before anything is created. Redundant with R3's resolved-path clause, so the mutation
#      driver kills the pair together (r3b) and the base check alone (base-canon-removed).
ln -s "${REAL_RT}" "${ST_BASE}/lnk"
ARM_ABSENT='disk-guard OK|sway pid=' arm R10 "E2E_RIG_BASE through a SYMLINK into ${REAL_RT} ABORTS before anything is created" 90 no \
  "is under /run/user/ — a rig dir there would sit inside the human's runtime dir" \
  RIG_HIDE_REAL_RUNTIME=1 E2E_RIG_BASE="${ST_BASE}/lnk/rig-base-selftest"
# R8. A private dir path too long for the sockets inside it.
ARM_ABSENT='sway pid=' arm R8 "a private runtime dir path over 84 chars ABORTS" 90 no \
  "\(> 84\)" \
  E2E_RIG_BASE="${LONG_BASE}"

echo
echo "== self-test C: POSITIVE CONTROLS — normal operation must still reach the child =="

# C1. Without this, a preflight that aborts unconditionally would score every arm above.
#     It injects NO hostile env at all: the control is carried by the OUTCOME (rc=0 + launched=yes + both
#     PASSED lines), not by any variable.
arm C1 "CONTROL: normal operation PASSES (both preflights) and the child runs" 0 yes \
  "PREFLIGHT-RUNTIME PASSED\[launch/CHILD_ENV\]"

# C2. The same control inside the opt-in hidden world: the rig works with /run/user/<uid> an EMPTY
#     tmpfs (so it does not depend on the human's runtime dir), and it CREATED nothing there.
arm C2 "CONTROL: works with ${REAL_RT} hidden (empty tmpfs) and creates nothing in it" 0 yes \
  "entries created in the hidden /run/user/[0-9]+: \[\]" \
  RIG_HIDE_REAL_RUNTIME=1

# C3. What the child ACTUALLY receives (read from its own `env`, not from the rig's array): the private
#     runtime dir, the nonexistent bus, no /run/user anywhere, and sway's socket inside the private dir.
if selected C3; then
  ran=$((ran + 1)); SEEN[C3]=1
  out3="$(env E2E_RIG_BASE="${ST_BASE}" "${RIG}" /bin/sh -c 'env; echo "XDGLS:$(ls -A "${XDG_RUNTIME_DIR}" | tr "\n" " ")"; echo "BUSEXISTS:$([ -e "${DBUS_SESSION_BUS_ADDRESS#unix:path=}" ] && echo yes || echo no)"' 2>&1)"; rc3=$?
  xdg3="$(sed -n 's/^XDG_RUNTIME_DIR=//p' <<<"${out3}")"
  why3=""
  [[ "${rc3}" == 0 ]] || why3+="rc=${rc3}; "
  [[ "${xdg3}" =~ ^${ST_BASE}/e2e64c-[0-9]+/xdg$ ]] || why3+="XDG_RUNTIME_DIR='${xdg3}' not the private dir; "
  grep -qE "^DBUS_SESSION_BUS_ADDRESS=unix:path=${ST_BASE}/e2e64c-[0-9]+/no-session-bus$" <<<"${out3}" || why3+="DBUS not the pinned private path; "
  grep -qx 'BUSEXISTS:no' <<<"${out3}" || why3+="the private bus path exists; "
  if grep -E '^[A-Za-z_][A-Za-z0-9_]*=' <<<"${out3}" | grep -q '/run/user/'; then why3+="a child env value contains /run/user/; "; fi
  grep -qE '^XDGLS:.*wayland-[0-9]+ .*wayland-rig|^XDGLS:.*wayland-rig .*wayland-[0-9]+' <<<"${out3}" || why3+="sway's wayland socket is not inside the private dir; "
  grep -qx 'WAYLAND_DISPLAY=wayland-rig' <<<"${out3}" || why3+="WAYLAND_DISPLAY is not the alias wayland-rig; "
  grep -qx 'RIG_WAYLAND=wayland-rig' <<<"${out3}" || why3+="RIG_WAYLAND is not the alias wayland-rig; "
  grep -qE '^(WAYLAND_DISPLAY|RIG_WAYLAND)=wayland-1$' <<<"${out3}" && why3+="the child got the raw name wayland-1 (drivers refuse it); "
  if grep -qE '^(DISPLAY|GNOME_KEYRING_CONTROL|SSH_AUTH_SOCK)=' <<<"${out3}"; then why3+="a display/keyring var leaked into the child; "; fi
  if [[ -z "${why3}" ]]; then pass "C3 CONTROL: the child's REAL env is private (xdg=${xdg3##*/e2e64c-}, bus pinned, no /run/user/, wayland socket in the private dir)"
  else fail "C3 CONTROL: the child's REAL env is private" "${why3}"; printf '%s\n' "${out3}" | sed -n '1,40p' | sed 's/^/        /'; fi
fi

# C4. The teardown reaper: a stand-in process named like the keyring daemon LISTENS on a socket inside the
#     rig's private dir (what an NSS p11-kit module that auto-starts a daemon would leave behind). The rig must
#     reap it by identity (socket in ITS private dir + comm) — and the arm cleans up after itself if it did not.
#     The stand-in must NOT inherit the substitution's stdout: `$(…)` waits for every holder of the pipe, so a
#     surviving daemon would stall the arm until it exited on its own and then read as 'dead' (a false PASS).
if selected C4; then
  ran=$((ran + 1)); SEEN[C4]=1
  fk="${ST_BASE}/fake-keyring.py"; pidf="${ST_BASE}/c4.pid"; : > "${pidf}"
  cat > "${fk}" <<'PY'
import ctypes, os, socket, sys, time
ctypes.CDLL(None).prctl(15, b"gnome-keyring-daemon", 0, 0, 0)   # PR_SET_NAME -> /proc/<pid>/comm
s = socket.socket(socket.AF_UNIX); s.bind(os.environ["XDG_RUNTIME_DIR"] + "/ctl"); s.listen(1)
open(sys.argv[1], "w").write(str(os.getpid()))
time.sleep(45)
PY
  out4="$(env E2E_RIG_BASE="${ST_BASE}" "${RIG}" /bin/sh -c "python3 '${fk}' '${pidf}' </dev/null >/dev/null 2>&1 & i=0; while [ ! -s '${pidf}' ] && [ \$i -lt 40 ]; do sleep 0.25; i=\$((i+1)); done" 2>&1)"; rc4=$?
  pid4="$(cat "${pidf}" 2>/dev/null)"; why4=""
  [[ "${rc4}" == 0 ]] || why4+="rc=${rc4}; "
  [[ -n "${pid4}" ]] || why4+="the stand-in daemon never started; "
  grep -qE "teardown: reaping gnome-keyring-d\S* pid ${pid4:-X} " <<<"${out4}" || why4+="no reaping line for pid ${pid4:-?}; "
  # Dead = gone or a zombie (SIGTERM'd, not yet reaped by init): poll up to 3 s so a reaped-a-moment-later process is not a false FAIL.
  alive4() { local st; st="$(awk '{print $3}' "/proc/${pid4}/stat" 2>/dev/null)"; [[ -n "${st}" && "${st}" != "Z" ]]; }
  if [[ -n "${pid4}" ]]; then
    for _ in $(seq 1 30); do alive4 || break; sleep 0.1; done
    if alive4; then why4+="the stand-in daemon pid ${pid4} SURVIVED the rig's teardown; "; kill "${pid4}" 2>/dev/null; fi
  fi
  if [[ -z "${why4}" ]]; then pass "C4 CONTROL: the teardown reaps a keyring-named daemon listening in the private dir (pid ${pid4})"
  else fail "C4 CONTROL: the teardown reaps a keyring-named daemon listening in the private dir" "${why4}"; fi
fi

# Every id in RIG_SELFTEST_ONLY must have run: a typo'd id silently selecting nothing is a green made of nothing.
if [[ -n "${RIG_SELFTEST_ONLY:-}" ]]; then
  for id in ${RIG_SELFTEST_ONLY}; do
    [[ -n "${SEEN[${id}]:-}" ]] || { fail "${id}" "selected in RIG_SELFTEST_ONLY but no such arm ran"; }
  done
fi

echo
if [[ -n "${RIG_SELFTEST_ONLY:-}" ]]; then
  (( fails == 0 )) && { echo "RIG-SELFTEST: PARTIAL-PASS arms=${ran} only='${RIG_SELFTEST_ONLY}' (a subset — NOT the gate)"; exit 1; }
  echo "RIG-SELFTEST: PARTIAL-FAIL arms=${ran} failed=${fails} only='${RIG_SELFTEST_ONLY}'"
  exit 1
fi
if (( ran < 31 )); then
  echo "RIG-SELFTEST: FAILED arms=${ran} (expected 31 — an arm did not run)"
  exit 1
fi
if (( fails == 0 )); then
  echo "SELF-TEST PASSED: ${ran} arms — every hostile arm (display ×6, runtime-world ×21) aborted rc=90 for its OWN named clause without launching the child; the 4 controls ran."
  echo "RIG-SELFTEST: PASSED arms=${ran}"
  exit 0
fi
echo "SELF-TEST FAILED: ${fails} arm(s) did not behave as required."
echo "RIG-SELFTEST: FAILED arms=${ran} failed=${fails}"
exit 1
