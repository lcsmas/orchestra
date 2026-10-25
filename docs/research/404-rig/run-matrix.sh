#!/usr/bin/env bash
# #404 rig — runs every arm × dep, judges each against its expected outcome, prints CLEAN/DIRTY.
# Windowless only (no BrowserWindow anywhere). Scratch only: a fresh dir under $TMPDIR and a
# fresh keyring item `application=orchestra-r404-probe-<pid>` (cleared on exit). Never reads
# ~/.orchestra*, ~/.claude* or any secrets.json.
#
#   bash docs/research/404-rig/run-matrix.sh            (from a worktree after `pnpm run build:bus-abi`)
#   R404_APPIMAGE_DIR=<mounted AppImage dir> …         adds arm A on the SHIPPED binary + binding
set -u
RIG=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$RIG/../../.." && pwd)
E=$(node -p "require('$REPO/node_modules/electron')")             # the real binary, not the .bin wrapper
PKG=$REPO/node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3
B130=$REPO/build/bus-abi/better_sqlite3-abi130.node
B127=$REPO/build/bus-abi/better_sqlite3-abi127.node
for f in "$E" "$PKG/lib/database.js" "$B130" "$B127"; do [ -e "$f" ] || { echo "missing $f (pnpm install + pnpm run build:bus-abi)"; exit 2; }; done

S="${TMPDIR:?TMPDIR unset}/r404-scratch-$$-$(date +%s)"
mkdir -p "$S"
APP=orchestra-r404-probe-$$
APP_OTHER=$APP-other
SECRET="r404-scratch-secret-$RANDOM$RANDOM"
NOBUS="unix:path=$S/no-such-bus"
cleanup() { secret-tool clear application "$APP" 2>/dev/null; secret-tool clear application "$APP_OTHER" 2>/dev/null; }
trap cleanup EXIT

# Allowlisted base env (what a daemon gets), plus the graphical session vars for the "full" arms.
BASE=(env -i HOME="$HOME" USER="$USER" LANG=C.UTF-8 PATH=/usr/bin:/bin
      XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$DBUS_SESSION_BUS_ADDRESS")
SESSION=(WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-1}" DISPLAY="${DISPLAY:-:0}" XDG_CURRENT_DESKTOP=sway
         XDG_SESSION_TYPE=wayland ELECTRON_OZONE_PLATFORM_HINT=wayland)
PROBE=(R404_SCRATCH_ROOT="$S" R404_APPNAME="$APP" R404_BSQL_PKG="$PKG" R404_SECRET="$SECRET")

# cap NAME cmd… — run, keep the log, store the last `R404 {json}` line (or null) + exit code.
cap() {
  local name=$1; shift
  timeout 90 "$@" >"$S/$name.log" 2>&1; local rc=$?
  local line; line=$(grep '^R404 ' "$S/$name.log" | tail -1 | cut -c6-)
  printf '%s\n' "${line:-null}" >"$S/$name.json"; echo "$rc" >"$S/$name.rc"
}
# judge NAME LABEL works|fails 'js predicate over o (json) and rc' — observed works iff predicate true.
FAILS=0
judge() {
  local name=$1 label=$2 expect=$3 pred=$4
  local res
  res=$(SECRET="$SECRET" node -e '
    const [file, rcFile, pred] = process.argv.slice(1);
    const o = JSON.parse(require("fs").readFileSync(file, "utf8"));
    const rc = +require("fs").readFileSync(rcFile, "utf8");
    const SECRET = process.env.SECRET;
    let works = false; try { works = !!eval(pred); } catch {}
    const d = o ? [o.backend && "backend=" + o.backend, o.available !== undefined && "available=" + o.available,
      o.prefix && "prefix=" + o.prefix, o.plain !== undefined && "decrypt=" + (o.plain === SECRET ? "SECRET" : JSON.stringify(o.plain)),
      o.safeStorage && "safeStorage=" + o.safeStorage, o.linkedAvailable !== undefined && "linked=" + o.linkedAvailable,
      o.err && "err=" + o.err.slice(0, 90),
      o.bus && "bus=" + (o.bus.ok ? "ok(" + o.bus.journal + "," + o.bus.binding + ")" : "FAIL(" + (o.bus.err || "").slice(0, 70) + ")")]
      .filter(Boolean).join(" ") : "no R404 line";
    console.log((works ? "works" : "fails") + "\t" + d + " rc=" + rc);
  ' "$S/$name.json" "$S/$name.rc" "$pred")
  local observed=${res%%$'\t'*} detail=${res#*$'\t'}
  if [ "$observed" = "$expect" ]; then v=PASS; else v=UNEXPECTED; FAILS=$((FAILS + 1)); fi
  printf '%-10s %-34s expect=%-5s observed=%-5s | %s\n' "$v" "$name:$label" "$expect" "$observed" "$detail"
  grep -m1 -E 'exited with signal|platform failed|Missing X server' "$S/$name.log" | sed 's/^/           log: /' | cut -c1-160
}

OKDEC='o && o.plain === SECRET'
echo "electron=$E  scratch=$S  app=$APP"
echo "--- positive control: windowless Electron, full session env, libsecret forced"
cap K1 "${BASE[@]}" "${SESSION[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-K1" R404_OP=encrypt R404_BLOB="$S/blob-v11" R404_BINDING="$B130" R404_PASSWORD_STORE=gnome-libsecret "$E" "$RIG/electron-probe.cjs"
judge K1 encrypt+self-decrypt works "o.backend==='gnome_libsecret' && o.available && o.prefix==='v11' && o.roundtrip"
cap K2 "${BASE[@]}" "${SESSION[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-K2" R404_OP=decrypt R404_BLOB="$S/blob-v11" R404_BINDING="$B130" R404_PASSWORD_STORE=gnome-libsecret "$E" "$RIG/electron-probe.cjs"
judge K2 decrypt-new-process works "$OKDEC && o.backend==='gnome_libsecret'"
judge K2 bus-abi130 works "o.bus.ok"

echo "--- must-FAIL: the silent basic_text fallback and an unreachable/foreign keyring"
cap F1 "${BASE[@]}" "${SESSION[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-F1" R404_OP=decrypt R404_BLOB="$S/blob-v11" "$E" "$RIG/electron-probe.cjs"
judge F1 default-switches-decrypt fails "$OKDEC"
cap F1e "${BASE[@]}" "${SESSION[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-F1e" R404_OP=encrypt R404_BLOB="$S/blob-F1e" "$E" "$RIG/electron-probe.cjs"
judge F1e default-switches-encrypt fails "o.available && o.roundtrip"
cap F2 "${BASE[@]}" "${SESSION[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-F2" R404_OP=decrypt R404_BLOB="$S/blob-v11" R404_PASSWORD_STORE=basic "$E" "$RIG/electron-probe.cjs"
judge F2 password-store=basic fails "$OKDEC"
cap F3 env -i HOME="$HOME" USER="$USER" LANG=C.UTF-8 PATH=/usr/bin:/bin XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$NOBUS" "${SESSION[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-F3" R404_OP=decrypt R404_BLOB="$S/blob-v11" R404_PASSWORD_STORE=gnome-libsecret "$E" "$RIG/electron-probe.cjs"
judge F3 libsecret-but-no-dbus fails "$OKDEC"
cap F4 "${BASE[@]}" "${SESSION[@]}" "${PROBE[@]}" R404_APPNAME="$APP_OTHER" R404_USERDATA="$S/ud-F4" R404_OP=decrypt R404_BLOB="$S/blob-v11" R404_PASSWORD_STORE=gnome-libsecret "$E" "$RIG/electron-probe.cjs"
judge F4 other-app-keyring-item fails "$OKDEC"

echo "--- arm B: windowless Electron with NO WAYLAND_DISPLAY / DISPLAY"
cap B1 "${BASE[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-B1" R404_OP=decrypt R404_BLOB="$S/blob-v11" R404_BINDING="$B130" R404_PASSWORD_STORE=gnome-libsecret "$E" "$RIG/electron-probe.cjs"
judge B1 no-display-default-ozone fails "$OKDEC"
cap B2 "${BASE[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-B2" R404_OP=decrypt R404_BLOB="$S/blob-v11" R404_BINDING="$B130" R404_PASSWORD_STORE=gnome-libsecret "$E" "$RIG/electron-probe.cjs" --ozone-platform=headless
judge B2 no-display-headless-decrypt works "$OKDEC && o.backend==='gnome_libsecret' && o.windows===0 && o.display.DISPLAY===null && o.display.WAYLAND_DISPLAY===null"
judge B2 bus-abi130 works "o.bus.ok"
cap B2m "${BASE[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-B2m" R404_OP=decrypt R404_BLOB="$S/blob-v11" R404_BINDING="$B127" R404_PASSWORD_STORE=gnome-libsecret "$E" "$RIG/electron-probe.cjs" --ozone-platform=headless
judge B2m bus-abi127-in-electron fails "o.bus.ok"
cap B3 "${BASE[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-B3" R404_OP=decrypt R404_BLOB="$S/blob-v11" "$E" "$RIG/electron-probe.cjs" --ozone-platform=headless
judge B3 no-display-no-switch fails "$OKDEC"
cap B4e "${BASE[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-B4e" R404_OP=encrypt R404_BLOB="$S/blob-B4" R404_PASSWORD_STORE=gnome-libsecret "$E" "$RIG/electron-probe.cjs" --ozone-platform=headless
judge B4e no-display-encrypt works "o.backend==='gnome_libsecret' && o.prefix==='v11' && o.roundtrip"
cap B4d "${BASE[@]}" "${SESSION[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-B4d" R404_OP=decrypt R404_BLOB="$S/blob-B4" R404_PASSWORD_STORE=gnome-libsecret "$E" "$RIG/electron-probe.cjs"
judge B4d its-blob-in-session-process works "$OKDEC"

echo "--- arm B in a REAL systemd user unit (UnsetEnvironment of the display vars)"
SDR=(systemd-run --user --quiet --pipe --wait --collect -p "UnsetEnvironment=DISPLAY WAYLAND_DISPLAY ELECTRON_OZONE_PLATFORM_HINT")
cap U1 "${SDR[@]}" -E R404_SCRATCH_ROOT="$S" -E R404_APPNAME="$APP" -E R404_BSQL_PKG="$PKG" -E R404_SECRET="$SECRET" -E R404_USERDATA="$S/ud-U1" -E R404_OP=decrypt -E R404_BLOB="$S/blob-v11" -E R404_BINDING="$B130" -E R404_PASSWORD_STORE=gnome-libsecret -- "$E" "$RIG/electron-probe.cjs" --ozone-platform=headless
judge U1 unit-headless-decrypt works "$OKDEC && o.display.DISPLAY===null && o.display.WAYLAND_DISPLAY===null"
judge U1 unit-bus-abi130 works "o.bus.ok"
cap U2 "${SDR[@]}" -E R404_SCRATCH_ROOT="$S" -E R404_APPNAME="$APP" -E R404_BSQL_PKG="$PKG" -E R404_SECRET="$SECRET" -E R404_USERDATA="$S/ud-U2" -E R404_OP=decrypt -E R404_BLOB="$S/blob-v11" -- "$E" "$RIG/electron-probe.cjs" --ozone-platform=headless
judge U2 unit-no-switch fails "$OKDEC"

echo "--- arm A: ELECTRON_RUN_AS_NODE=1 electron script.js"
NODEPROBE=(R404_BLOB="$S/blob-v11" R404_BSQL_PKG="$PKG" R404_DBDIR="$S")
cap A1 "${BASE[@]}" "${SESSION[@]}" ELECTRON_RUN_AS_NODE=1 "${NODEPROBE[@]}" R404_BINDING="$B130" "$E" "$RIG/asnode-probe.cjs"
judge A1 safeStorage fails "$OKDEC"
judge A1 bus-abi130 works "o.bus.ok"
cap A2 "${BASE[@]}" ELECTRON_RUN_AS_NODE=1 "${NODEPROBE[@]}" R404_BINDING="$B127" "$E" "$RIG/asnode-probe.cjs"
judge A2 bus-abi127 fails "o.bus.ok"
cap A3 "${BASE[@]}" "${SESSION[@]}" ELECTRON_RUN_AS_NODE=1 R404_LINKED=1 "${NODEPROBE[@]}" "$E" "$RIG/asnode-probe.cjs"
judge A3 internal-safeStorage-binding fails "o && o.linkedAvailable === true"
cap A5 "${BASE[@]}" ELECTRON_RUN_AS_NODE=1 "$E" "$RIG/node-keyring-decrypt.mjs" "$S/blob-v11" "$APP"
judge A5 keyring-reader-under-asnode works "$OKDEC && o.passwordSource==='secret-tool'"
cap A5m "${BASE[@]}" ELECTRON_RUN_AS_NODE=1 "$E" "$RIG/node-keyring-decrypt.mjs" "$S/blob-v11" "$APP_OTHER"
judge A5m keyring-reader-wrong-item fails "$OKDEC"
if [ -n "${R404_APPIMAGE_DIR:-}" ]; then
  SHIPPED=$R404_APPIMAGE_DIR/resources/app.asar.unpacked/node_modules/better-sqlite3/build/Release/better_sqlite3.node
  cap A4 "${BASE[@]}" ELECTRON_RUN_AS_NODE=1 "${NODEPROBE[@]}" R404_BINDING="$SHIPPED" "$R404_APPIMAGE_DIR/orchestra" "$RIG/asnode-probe.cjs"
  judge A4 shipped-binary-shipped-binding works "o.bus.ok && o.electron"
  judge A4 shipped-binary-safeStorage fails "$OKDEC"
else
  echo "NOT RUN    A4 (set R404_APPIMAGE_DIR to exercise the shipped binary + binding)"
fi

echo "--- arm C: plain system node"
cap C1 "${BASE[@]}" "${NODEPROBE[@]}" R404_BINDING="$B130" /usr/bin/node "$RIG/asnode-probe.cjs"
judge C1 safeStorage fails "$OKDEC"
judge C1 bus-abi130 fails "o.bus.ok"
judge C1 require-trap-require-succeeds works "o.bus.require === 'ok'"
cap C2 "${BASE[@]}" "${NODEPROBE[@]}" R404_BINDING="$B127" /usr/bin/node "$RIG/asnode-probe.cjs"
judge C2 bus-abi127-second-build works "o.bus.ok"
cap C3 "${BASE[@]}" /usr/bin/node "$RIG/node-keyring-decrypt.mjs" "$S/blob-v11" "$APP"
judge C3 libsecret-via-secret-tool works "$OKDEC && o.passwordSource==='secret-tool'"
cap C4 "${BASE[@]}" /usr/bin/node "$RIG/node-keyring-decrypt.mjs" "$S/blob-v11" "$APP" --password-override peanuts
judge C4 wrong-password fails "$OKDEC"
cap C5 env -i HOME="$HOME" PATH=/usr/bin:/bin XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR" DBUS_SESSION_BUS_ADDRESS="$NOBUS" /usr/bin/node "$RIG/node-keyring-decrypt.mjs" "$S/blob-v11" "$APP"
judge C5 no-dbus fails "$OKDEC"
cap C6 "${SDR[@]}" -- /usr/bin/node "$RIG/node-keyring-decrypt.mjs" "$S/blob-v11" "$APP"
judge C6 in-systemd-unit works "$OKDEC"

echo "--- why a basic_text 'works' proves nothing: v10 decrypts with NO keyring at all"
cap V1 "${BASE[@]}" "${SESSION[@]}" "${PROBE[@]}" R404_USERDATA="$S/ud-V1" R404_OP=encrypt R404_BLOB="$S/blob-v10" R404_PLAINTEXT_OK=1 "$E" "$RIG/electron-probe.cjs"
judge V1 basic_text-plaintext-opt-in works "o.backend==='basic_text' && o.prefix==='v10' && o.roundtrip"
cap V2 env -i HOME="$HOME" PATH=/usr/bin:/bin DBUS_SESSION_BUS_ADDRESS="$NOBUS" /usr/bin/node "$RIG/node-keyring-decrypt.mjs" "$S/blob-v10" "$APP"
judge V2 v10-decrypt-without-keyring works "$OKDEC && o.passwordSource==='hardcoded-v10'"

echo "--- hygiene"
[ -e "$HOME/.config/$APP" ] && { echo "DIRTY: ~/.config/$APP was created"; FAILS=$((FAILS + 1)); } || echo "ok: nothing under ~/.config/$APP"
echo "evidence: $S"
[ "$FAILS" -eq 0 ] && echo "MATRIX CLEAN (every arm matched its expected outcome)" || echo "MATRIX DIRTY ($FAILS unexpected)"
