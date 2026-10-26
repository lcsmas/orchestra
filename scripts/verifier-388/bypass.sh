#!/usr/bin/env bash
# Verifier adversarial matrix for the private-runtime-world preflight (seat 1, #388 Q2). NODE/BASH ONLY: the child is `sh -c echo SENTINEL`, never Electron.
# Hostile values are injected with the rig's OWN self-test seams (RIG_SELFTEST_*). Arms whose failure could write under /run/user (rig base under it) or start sway in a forced dir
# run INSIDE the hidden world (RIG_HIDE_REAL_RUNTIME=1: /run/user/<uid> is an empty tmpfs). Nothing here connects to, lists or stats the human's runtime dir.
# usage: bypass.sh <rig-script> ; prints one line per arm + a summary. Expectation codes: ABORT_PRE (rc 90, no sway, no child) · ABORT_ANY (rc 90, no child) · PASS_GAP (rc 0 — a DECLARED gap if it passes).
set -uo pipefail
RIG="${1:?rig script}"; BASE="$(mktemp -d /var/tmp/byp-XXXXXX)"; trap 'rm -rf -- "$BASE"' EXIT
UID_NOW="$(id -u)"; RT="/run/user/${UID_NOW}"; SENT='BYPASS-CHILD-SENTINEL'
pass=0; bad=0; gaps=0
run() { # id expect label reason-regex hidden(0|1) -- env assignments...
  local id="$1" exp="$2" label="$3" reason="$4" hidden="$5"; shift 6
  [[ -z "${ONLY:-}" || "$id" =~ $ONLY ]] || return 0
  local out rc launched=no sway=no
  local -a H=(); [[ "$hidden" == 1 ]] && H=(RIG_HIDE_REAL_RUNTIME=1)
  out="$(env E2E_RIG_BASE="$BASE" "${H[@]}" "$@" "$RIG" /bin/sh -c "echo $SENT" 2>&1)"; rc=$?
  grep -q "$SENT" <<<"$out" && launched=yes; grep -q 'sway pid=' <<<"$out" && sway=yes
  local line; line="$(grep -E 'PREFLIGHT(-RUNTIME)? (PASSED|FAILED)|ABORT' <<<"$out" | tail -1 | cut -c1-170)"
  local verdict
  case "$exp" in
    ABORT_PRE) [[ $rc == 90 && $launched == no && $sway == no && ( -z "$reason" || -n "$(grep -E -- "$reason" <<<"$out")" ) ]] && verdict=OK || verdict=BYPASS ;;
    ABORT_ANY) [[ $rc == 90 && $launched == no && ( -z "$reason" || -n "$(grep -E -- "$reason" <<<"$out")" ) ]] && verdict=OK || verdict=BYPASS ;;
    PASS_GAP)  [[ $rc == 0 && $launched == yes ]] && verdict=GAP || verdict=OK ;;
    PASS_CTL)  [[ $rc == 0 && $launched == yes ]] && verdict=OK || verdict=BYPASS ;;
  esac
  case "$verdict" in OK) pass=$((pass+1));; GAP) gaps=$((gaps+1));; *) bad=$((bad+1));; esac
  printf '%-4s %-7s exp=%-9s rc=%-3s child=%-3s sway=%-3s %s\n       %s\n' "$id" "$verdict" "$exp" "$rc" "$launched" "$sway" "$label" "$line"
}
NOSEP='--'
# ---- X: the child's XDG_RUNTIME_DIR in hostile spellings (all must die at R1/R2 BEFORE sway)
for spec in "X1|$RT" "X2|$RT/" "X3|/run//user/$UID_NOW" "X4|/run/./user/$UID_NOW" "X5|/run/x/../user/$UID_NOW" "X6|$RT/..//$UID_NOW" "X7|../../../../../../run/user/$UID_NOW" "X8|/RUN/USER/$UID_NOW" "X9| $RT" "X10|$RT/keyring" "X11|/run/user/9999" "X12|/run/user" "X13|$RT/../$UID_NOW/"; do
  id="${spec%%|*}"; val="${spec#*|}"
  run "$id" ABORT_PRE "XDG_RUNTIME_DIR='$val'" 'PREFLIGHT-RUNTIME FAILED' 0 "$NOSEP" RIG_SELFTEST_FORCE_XDG_RUNTIME_DIR="$val"
done
run X14 ABORT_PRE "XDG_RUNTIME_DIR='NOT-UNDER-RUN-USER (a path that is not under /run/user: only the equality clause can reject it)" 'PREFLIGHT-RUNTIME FAILED' 0 "$NOSEP" RIG_SELFTEST_FORCE_XDG_RUNTIME_DIR="$BASE/not-the-rig"
run X15 ABORT_PRE "XDG_RUNTIME_DIR='/var/tmp' (a real dir, ours, but not the rig's private one)" 'PREFLIGHT-RUNTIME FAILED' 0 "$NOSEP" RIG_SELFTEST_FORCE_XDG_RUNTIME_DIR=/var/tmp
# ---- B: DBUS_SESSION_BUS_ADDRESS forms (R6: exact private nonexistent path only)
for spec in "B1|unix:path=$RT/bus" "B2|unix:abstract=/tmp/dbus-AAAA" "B3|tcp:host=127.0.0.1,port=1" "B4|unix:path=$RT/bus;unix:abstract=x" "B5|unix:path=/nonexistent,guid=0123456789abcdef0123456789abcdef" "B6|autolaunch:" "B7|unix:runtime=yes" "B8|disabled:" "B9|unix:path=$RT/bus/"; do
  id="${spec%%|*}"; val="${spec#*|}"
  run "$id" ABORT_PRE "DBUS_SESSION_BUS_ADDRESS='$val'" 'PREFLIGHT-RUNTIME FAILED' 0 "$NOSEP" RIG_SELFTEST_FORCE_DBUS="$val"
done
# ---- E: extra env entries appended before sway (duplicates, other bus/keyring/p11-kit/XDG vars, a /run/user path inside a longer string)
for spec in "E1|DBUS_SESSION_BUS_ADDRESS=unix:path=$RT/bus" "E2|XDG_RUNTIME_DIR=$RT" "E3|XDG_DATA_DIRS=$RT/share:/usr/share" "E4|XDG_CONFIG_HOME=$RT/cfg" "E5|HOME=$RT/h" "E6|XDG_DATA_HOME=$RT/d" "E7|P11_KIT_SERVER_ADDRESS=unix:path=$RT/p11-kit/pkcs11" "E8|P11_KIT_PRELOAD=$RT/x.so" "E9|GNOME_KEYRING_CONTROL=$RT/keyring" "E10|SSH_AUTH_SOCK=$RT/keyring/ssh" "E11|PULSE_SERVER=unix:$RT/pulse/native" "E12|xdg_runtime_dir=$RT" "E13|FOO=prefix-text-${RT}-suffix" "E14|FOO=file://$RT/bus" "E15|DBUS_SYSTEM_BUS_ADDRESS=unix:path=$RT/bus" "E16|FOO=$RT/../..$RT/z" "E17|FOO=a:b:/run//user//$UID_NOW//z" "E18|FOO=../../../run/user/$UID_NOW/k"; do
  id="${spec%%|*}"; val="${spec#*|}"
  run "$id" ABORT_PRE "env ${val%%=*}='${val#*=}'" 'PREFLIGHT-RUNTIME FAILED' 0 "$NOSEP" RIG_SELFTEST_ADD_ENV="$val"
done
# ---- G: shapes the rig CANNOT reject by string — recorded as DECLARED GAPS if they pass
for spec in "G1|DBUS_SYSTEM_BUS_ADDRESS=unix:path=/run/dbus/system_bus_socket" "G2|FOO=/run/user" "G3|FOO=/run%2Fuser%2F$UID_NOW" "G4|FOO=/run/user$UID_NOW" "G5|FOO=run/user/$UID_NOW" "G6|FOO=\\x2frun\\x2fuser"; do
  id="${spec%%|*}"; val="${spec#*|}"
  run "$id" PASS_GAP "env ${val%%=*}='${val#*=}' (string-level cannot see it)" '' 0 "$NOSEP" RIG_SELFTEST_ADD_ENV="$val"
done
# ---- P: PHYSICAL resolution (R7 of the -fu): links that the kernel resolves into /run/user, hidden inside a path-valued env entry (nonexistent uid dir: never reaches a real dir)
mkdir -p "$BASE/real-ok"
ln -s "/run/user/9999/x" "$BASE/lnk-abs"; ln -s "../../../../../run/user/9999" "$BASE/lnk-rel"; ln -s "$BASE/lnk-abs" "$BASE/lnk-chain"; ln -s "/run/user" "$BASE/lnk-parent"; ln -s "$BASE/real-ok" "$BASE/lnk-ok"
run P1 ABORT_PRE "env FOO = symlink -> /run/user/9999/x" 'resolves physically' 0 "$NOSEP" RIG_SELFTEST_ADD_ENV="FOO=$BASE/lnk-abs"
run P2 ABORT_PRE "env FOO = relative symlink resolving into /run/user/9999" 'resolves physically' 0 "$NOSEP" RIG_SELFTEST_ADD_ENV="FOO=$BASE/lnk-rel"
run P3 ABORT_PRE "env FOO = chain of two links" 'resolves physically' 0 "$NOSEP" RIG_SELFTEST_ADD_ENV="FOO=$BASE/lnk-chain"
run P4 ABORT_PRE "env FOO = symlink/../ whose physical parent is under /run/user" 'resolves physically|contains' 0 "$NOSEP" RIG_SELFTEST_ADD_ENV="FOO=$BASE/lnk-abs/../y"
run P5 ABORT_PRE "colon-list entry (second element is the link)" 'resolves physically' 0 "$NOSEP" RIG_SELFTEST_ADD_ENV="FOO=/usr/bin:$BASE/lnk-abs:/bin"
run P6 ABORT_PRE "colon-list entry (link in the LAST position)" 'resolves physically' 0 "$NOSEP" RIG_SELFTEST_ADD_ENV="PATH2=/usr/bin:/bin:$BASE/lnk-rel"
run P7 PASS_GAP "env FOO = symlink to EXACTLY /run/user (no child component)" '' 0 "$NOSEP" RIG_SELFTEST_ADD_ENV="FOO=$BASE/lnk-parent"
run P8 PASS_CTL "CONTROL: env FOO = symlink to a harmless dir MUST pass" '' 0 "$NOSEP" RIG_SELFTEST_ADD_ENV="FOO=$BASE/lnk-ok"
run P9 ABORT_PRE "link in CLAUDE_CONFIG_DIR_PIN (the real caller-supplied path)" 'resolves physically' 0 "$NOSEP" CLAUDE_CONFIG_DIR_PIN="$BASE/lnk-abs"
# ---- L: AFTER sway is up (launch-stage preflight reads the FINAL array)
run L1 ABORT_ANY "late add of an env value carrying $RT" 'PREFLIGHT-RUNTIME FAILED' 0 "$NOSEP" RIG_SELFTEST_LATE_ADD_ENV="FOO=$RT/x"
run L2 ABORT_ANY "late duplicate DBUS_SESSION_BUS_ADDRESS" 'PREFLIGHT-RUNTIME FAILED' 0 "$NOSEP" RIG_SELFTEST_LATE_ADD_ENV="DBUS_SESSION_BUS_ADDRESS=unix:path=$RT/bus"
run L3 ABORT_ANY "late DISPLAY" 'PREFLIGHT FAILED' 0 "$NOSEP" RIG_SELFTEST_ADD_DISPLAY=:0
# ---- W: WAYLAND_DISPLAY forms
for spec in "W1|$RT/wayland-1" "W2|../../../..$RT/wayland-1" "W3|/tmp/x/wayland-1" "W4|wayland-1" "W5|wayland-rig/"; do
  id="${spec%%|*}"; val="${spec#*|}"
  run "$id" ABORT_ANY "WAYLAND_DISPLAY='$val'" 'PREFLIGHT' 0 "$NOSEP" RIG_SELFTEST_FORCE_WAYLAND="$val"
done
# ---- R: the rig BASE under /run/user (hidden world: a failed guard could only create dirs in the empty tmpfs)
for spec in "R1|$RT/rb" "R2|/run//user/$UID_NOW/rb" "R3|/tmp/../run/user/$UID_NOW/rb" "R4|../../../../../../run/user/$UID_NOW/rb" "R5|/run/user/9999/rb"; do
  id="${spec%%|*}"; val="${spec#*|}"
  out="$(env E2E_RIG_BASE="$val" RIG_HIDE_REAL_RUNTIME=1 "$RIG" /bin/sh -c "echo $SENT" 2>&1)"; rc=$?
  if [[ $rc == 90 ]] && grep -q 'is under /run/user/' <<<"$out" && ! grep -q "$SENT" <<<"$out" && ! grep -q 'sway pid=' <<<"$out"; then v=OK; pass=$((pass+1)); else v=BYPASS; bad=$((bad+1)); fi
  printf '%-4s %-7s exp=ABORT_PRE rc=%-3s base=%s\n       %s\n' "$id" "$v" "$rc" "$val" "$(grep -E 'ABORT' <<<"$out" | tail -1 | cut -c1-170)"
done
# R6: a rig base that is a SYMLINK into /run/user (target = a NONEXISTENT uid dir; hidden world)
ln -s "/run/user/9999/rb" "$BASE/lnk"
out="$(env E2E_RIG_BASE="$BASE/lnk" RIG_HIDE_REAL_RUNTIME=1 "$RIG" /bin/sh -c "echo $SENT" 2>&1)"; rc=$?
if [[ $rc == 90 ]] && grep -q 'is under /run/user/' <<<"$out" && ! grep -q "$SENT" <<<"$out"; then v=OK; pass=$((pass+1)); else v=BYPASS; bad=$((bad+1)); fi
printf '%-4s %-7s exp=ABORT_PRE rc=%-3s base=symlink->/run/user/9999/rb\n       %s\n' R6 "$v" "$rc" "$(grep -E 'ABORT' <<<"$out" | tail -1 | cut -c1-170)"
# ---- F: forced SWAY xdg (HIDDEN world only)
run F1 ABORT_PRE "SWAY_ENV XDG_RUNTIME_DIR forced to $RT (hidden world)" 'PREFLIGHT-RUNTIME FAILED' 1 "$NOSEP" RIG_SELFTEST_FORCE_SWAY_XDG="$RT"
run F2 ABORT_PRE "SWAY_ENV XDG_RUNTIME_DIR forced to a /run//user spelling (hidden world)" 'PREFLIGHT-RUNTIME FAILED' 1 "$NOSEP" RIG_SELFTEST_FORCE_SWAY_XDG="/run//user/$UID_NOW"
# ---- S: the private dir itself (symlink / mode / planted endpoints / planted bus path)
run S1 ABORT_PRE "private dir is a symlink" 'symlink|PREFLIGHT-RUNTIME FAILED' 0 "$NOSEP" RIG_SELFTEST_SYMLINK_XDG=1
run S2 ABORT_PRE "private dir mode 0755" 'PREFLIGHT-RUNTIME FAILED' 0 "$NOSEP" RIG_SELFTEST_CHMOD_XDG=755
run S3 ABORT_PRE "private dir mode 0777" 'PREFLIGHT-RUNTIME FAILED' 0 "$NOSEP" RIG_SELFTEST_CHMOD_XDG=777
for e in keyring bus pulse p11-kit keyring-x bus.sock; do run "S4-$e" ABORT_PRE "planted '$e' in the private dir" 'PREFLIGHT-RUNTIME FAILED' 0 "$NOSEP" RIG_SELFTEST_PLANT_ENTRY="$e"; done
run S5 ABORT_PRE "the private session-bus path exists" 'PREFLIGHT-RUNTIME FAILED' 0 "$NOSEP" RIG_SELFTEST_PLANT_NOBUS=1
# ---- Y9: a rig base so long that the private dir path exceeds 84 chars (sun_path budget)
if [[ -z "${ONLY:-}" || "Y9" =~ $ONLY ]]; then
  LB="$BASE/$(printf 'x%.0s' {1..75})"; out="$(env E2E_RIG_BASE="$LB" "$RIG" /bin/sh -c "echo $SENT" 2>&1)"; rc=$?
  if [[ $rc == 90 ]] && grep -q 'PREFLIGHT-RUNTIME FAILED' <<<"$out" && ! grep -q "$SENT" <<<"$out"; then v=OK; pass=$((pass+1)); else v=BYPASS; bad=$((bad+1)); fi
  printf '%-4s %-7s exp=ABORT_PRE rc=%-3s long rig base (xdg path > 84)\n       %s\n' Y9 "$v" "$rc" "$(grep -E 'ABORT' <<<"$out" | tail -1 | cut -c1-170)"
fi
# ---- C: controls (must PASS and launch the child; the child's env is read back)
out="$(env E2E_RIG_BASE="$BASE" "$RIG" /usr/bin/env 2>&1)"; rc=$?
chk="$(grep -cE '^(XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)=' <<<"$out")"; xdgv="$(grep -E '^XDG_RUNTIME_DIR=' <<<"$out" | cut -d= -f2)"; busv="$(grep -E '^DBUS_SESSION_BUS_ADDRESS=' <<<"$out" | cut -d= -f2-)"
runu="$(grep -E '^[A-Za-z_]+=' <<<"$out" | grep -c '/run/user/')"
if [[ $rc == 0 && "$xdgv" == "$BASE"/e2e64c-*/xdg && "$busv" == "unix:path=$BASE"/e2e64c-*/no-session-bus && $runu == 0 ]]; then v=OK; pass=$((pass+1)); else v=BYPASS; bad=$((bad+1)); fi
printf 'C1   %-7s CONTROL rc=%s child env: XDG_RUNTIME_DIR=%s DBUS=%s values-with-/run/user/=%s\n' "$v" "$rc" "${xdgv#$BASE/}" "${busv#unix:path=$BASE/}" "$runu"
printf '%s\n' "SUMMARY: ok=$pass declared-gaps=$gaps bypass=$bad"
exit $(( bad > 0 ))
