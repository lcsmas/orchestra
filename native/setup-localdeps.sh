#!/usr/bin/env bash
# Rootless dev-dependency setup for the native Rust workspace (orchestra-gtk).
# Adapted from prototypes/gtk4-shell/setup-localdeps.sh — see its NOTES.md for
# the full story.
#
# This machine (Asahi Fedora 42) has the gtk4 RUNTIME installed but not the
# -devel packages, and no sudo. The Rust gtk4-rs/vte4 -sys crates never compile
# C — they only need (a) the pkg-config .pc files and (b) linkable .so symlinks.
# So we download the devel RPMs with plain `dnf download` (no root needed),
# extract them into .localdeps/prefix with rpm2cpio, and repoint the dangling
# dev symlinks (libfoo.so -> libfoo.so.X) at the system runtime libs in
# /usr/lib64. vte291-gtk4 has no system runtime at all, so its runtime RPM is
# extracted too and used via LD_LIBRARY_PATH at run time.
#
# On a machine with sudo, `dnf install gtk4-devel vte291-gtk4-devel` replaces
# all of this (env.sh then becomes a harmless no-op prefix).
#
# Scope: the full M2 surface — gtk4 + vte4 (terminals), gtksourceview5 (diff),
# webkitgtk6.0 (per-account OAuth window), gstreamer1 (chime playback).
# gtksourceview5 and webkitgtk6.0 have no system runtime on this box, so their
# runtime RPMs are extracted alongside the -devel ones (vte pattern).
#
# Usage:  ./setup-localdeps.sh          # download + extract + fix symlinks
# Then:   source ./env.sh && cargo build
set -euo pipefail
cd "$(dirname "$0")"

DEPS=(gtk4-devel vte291-gtk4 vte291-gtk4-devel glib2-devel cairo-devel
      cairo-gobject-devel pango-devel gdk-pixbuf2-devel graphene-devel
      harfbuzz-devel vulkan-loader-devel
      gtksourceview5 gtksourceview5-devel
      webkitgtk6.0 webkitgtk6.0-devel libsoup3-devel
      gstreamer1-devel gstreamer1-plugins-base-devel)

mkdir -p .localdeps/rpms .localdeps/prefix
if ! ls .localdeps/rpms/*.rpm >/dev/null 2>&1; then
  (cd .localdeps/rpms && dnf download "${DEPS[@]}")
fi

for rpm in .localdeps/rpms/*.rpm; do
  rpm2cpio "$rpm" | (cd .localdeps/prefix && cpio -idmu --quiet)
done

# We never compile C against these packages and always link dynamically, so
# the Requires.private/Libs.private chains (freetype, x11, pcre2, sysprof, …
# ~20 more devel packages) are irrelevant — but pkg-config still insists on
# resolving them. Strip them from the extracted .pc files.
sed -i -E '/^(Requires|Libs)\.private:/d' .localdeps/prefix/usr/lib64/pkgconfig/*.pc

# Dev symlinks extracted from -devel RPMs are relative (libgtk-4.so ->
# libgtk-4.so.1) and dangle when the versioned runtime lives in the system
# /usr/lib64 instead of our prefix. Repoint dangling ones at the system copy.
LIBDIR=.localdeps/prefix/usr/lib64
for link in "$LIBDIR"/*.so; do
  [ -L "$link" ] || continue
  if ! [ -e "$link" ]; then
    target=$(readlink "$link")
    if [ -e "/usr/lib64/$target" ]; then
      ln -sf "/usr/lib64/$target" "$link"
    else
      echo "WARN: no system runtime for $link -> $target (kept relative)" >&2
    fi
  fi
done

echo "OK. Now: source ./env.sh && cargo build"
