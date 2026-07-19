#!/usr/bin/env bash
# WebKitGTK OAuth-window isolation E2E (plan §5.4). Runs the webkit_isolation
# example inside a FRESH headless sway (never the user's desktop): opens the
# per-account login windows for two fake accounts against benign https pages,
# asserts each got its own on-disk partition dir under
# $ORCHESTRA_HOME/gtk-login-partitions/<id>, and screenshots each window.
#
# The claude.ai consent wall is documented, never automated — this proves the
# window opens + isolates cookies per account, up to that wall.
#
# Artifacts under native/target/smoke-webkit/: webkit-alpha.png, webkit-beta.png.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE="$(cd "$HERE/../.." && pwd)"
RUNTIME="${XDG_RUNTIME_DIR:-/tmp}"
RUN="$(mktemp -d "$RUNTIME/orch-gtk-webkit.XXXXXX")"
ART="$NATIVE/target/smoke-webkit"
mkdir -p "$ART" "$RUN/home"

SWAY_PID=""
STATUS=FAIL
cleanup() {
  [ -n "$SWAY_PID" ] && kill "$SWAY_PID" 2>/dev/null || true
  if [ "$STATUS" = PASS ]; then rm -rf "$RUN"; else echo "FAIL — logs kept in $RUN" >&2; fi
}
trap cleanup EXIT

# shellcheck source=../../env.sh
source "$NATIVE/env.sh"
echo "-- building webkit_isolation example"
cargo build -p orchestra-gtk --example webkit_isolation --manifest-path "$NATIVE/Cargo.toml"

echo "-- starting headless sway"
echo "output HEADLESS-1 resolution 1200x900" > "$RUN/sway.conf"
before="$RUN/sockets-before"; ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort > "$before" || true
WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WAYLAND_DISPLAY= SWAYSOCK="$RUN/sway.sock" \
  sway -c "$RUN/sway.conf" >"$RUN/sway.log" 2>&1 &
SWAY_PID=$!

WD=""
for _ in $(seq 1 50); do
  WD="$(ls "$RUNTIME" | grep -E '^wayland-[0-9]+$' | sort | comm -13 "$before" - | head -1)"
  [ -n "$WD" ] && break
  sleep 0.2
done
[ -n "$WD" ] || { echo "headless sway produced no wayland socket (see $RUN/sway.log)"; exit 1; }
echo "-- headless sway up on $WD"

echo "-- running webkit_isolation"
# WebKitGTK spawns its helper processes from a COMPILED-IN libexec path
# (/usr/libexec/webkitgtk-6.0) with no env override in this build. Rootless
# they live in the localdeps prefix, so bind them over the expected path inside
# a bwrap user namespace. WEBKIT_DISABLE_SANDBOX avoids webkit's own nested
# bwrap sandbox (we're already in a namespace, and this is a throwaway E2E).
LIBEXEC="$_P/usr/libexec/webkitgtk-6.0"
# The target path doesn't exist on the host and /usr is read-only under
# --dev-bind, so overlay /usr/libexec with a tmpfs, re-bind the host's real
# libexec entries into it, then bind our webkit helpers at the expected name.
BWRAP=(bwrap
  --dev-bind / /
  --tmpfs /usr/libexec
  --ro-bind "$LIBEXEC" /usr/libexec/webkitgtk-6.0
  # NB: WebKit also logs a non-fatal warning about its injected bundle (loaded
  # from a compiled-in /usr/lib64 path we can't overlay read-only rootless);
  # OAuth needs no page-injection extension, so the WebViews work regardless.
  --setenv ORCHESTRA_HOME "$RUN/home"
  --setenv ORCH_WEBKIT_ART "$ART"
  --setenv GDK_BACKEND wayland
  --setenv WAYLAND_DISPLAY "$WD"
  --setenv WEBKIT_DISABLE_SANDBOX 1
  --setenv LD_LIBRARY_PATH "${LD_LIBRARY_PATH:-}"
  --setenv XDG_RUNTIME_DIR "$RUNTIME")
# Runs to completion (the example quits itself after asserting + screenshotting).
if "${BWRAP[@]}" "$NATIVE/target/debug/examples/webkit_isolation" >"$RUN/app.log" 2>&1; then
  cat "$RUN/app.log"
else
  echo "-- example failed:"; cat "$RUN/app.log"; exit 1
fi

# Independent on-disk check: the two partition dirs must both exist and differ.
A="$RUN/home/gtk-login-partitions/acct-alpha/data"
B="$RUN/home/gtk-login-partitions/acct-beta/data"
[ -d "$A" ] || { echo "alpha partition dir missing: $A"; exit 1; }
[ -d "$B" ] || { echo "beta partition dir missing: $B"; exit 1; }
echo "-- on-disk partitions: $A  |  $B"

STATUS=PASS
echo "PASS — two isolated partitions on disk; screenshots in $ART"
