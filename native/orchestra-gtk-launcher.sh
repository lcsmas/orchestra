#!/usr/bin/env bash
# Launcher for the native GTK4 frontend, for desktop entries and rofi.
#
# WHY A WRAPPER AND NOT `Exec=orchestra-gtk`: the binary links against
# GTK/libadwaita/gtksourceview/VTE from the rootless prefix in `.localdeps`
# (see setup-localdeps.sh — there is no system-wide install of these on this
# host). Without LD_LIBRARY_PATH pointing there it dies at startup with
# "libgtksourceview-5.so.0: cannot open shared object file".
#
# That failure is silent from a launcher's point of view: rofi/sway fire the
# Exec line, the process exits non-zero before mapping a window, and nothing
# is shown to the user. So the desktop entry MUST point at this script, never
# at the binary directly.

set -euo pipefail

HERE="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
BIN="$HERE/target/release/orchestra-gtk"
DEPS="$HERE/.localdeps/prefix/usr/lib64"

# Fail loudly and visibly rather than exiting into nothing. A launcher that
# dies silently is indistinguishable from one that was never clicked.
die() {
  echo "orchestra-gtk: $1" >&2
  command -v notify-send >/dev/null 2>&1 && notify-send -u critical "Orchestra (Native)" "$1"
  exit 1
}

[ -x "$BIN" ] || die "binary not built — run: cd $HERE && source env.sh && cargo build --release"
[ -d "$DEPS" ] || die "missing .localdeps — run: $HERE/setup-localdeps.sh"

# Source env.sh rather than re-deriving LD_LIBRARY_PATH, so this launcher
# cannot drift from the prefix layout it documents. The $DEPS check above is
# what turns a layout change into a legible error instead of a silent exit.
# shellcheck source=/dev/null
. "$HERE/env.sh"

exec "$BIN" "$@"
