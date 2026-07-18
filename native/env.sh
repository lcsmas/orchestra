# source this before cargo build / cargo run in native/
# (harmless no-op if .localdeps is absent because the devel packages are
# system-installed — see setup-localdeps.sh)
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
_P="$_HERE/.localdeps/prefix"
export PKG_CONFIG_PATH="$_P/usr/lib64/pkgconfig:$_P/usr/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
# .pc files say libdir=/usr/lib64 where the dev .so symlinks don't exist;
# add the extracted libdir so the linker finds them.
export RUSTFLAGS="-L native=$_P/usr/lib64${RUSTFLAGS:+ $RUSTFLAGS}"
# vte291-gtk4 runtime is only in the prefix, not the system.
export LD_LIBRARY_PATH="$_P/usr/lib64${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
