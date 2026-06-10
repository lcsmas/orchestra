#!/bin/bash
# Orchestra launcher - bypasses FUSE requirement

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPIMAGE="$SCRIPT_DIR/../release/Orchestra.AppImage"

# Check dependencies and install if missing (requires sudo)
check_deps() {
    local missing=()

    # Check for libz
    if ! ldconfig -p 2>/dev/null | grep -q "libz.so"; then
        missing+=("zlib")
    fi

    if [ ${#missing[@]} -gt 0 ]; then
        echo "Missing dependencies: ${missing[*]}"
        echo "Attempting to install..."

        if command -v dnf &>/dev/null; then
            sudo dnf install -y zlib-devel
        elif command -v apt &>/dev/null; then
            sudo apt install -y zlib1g
        elif command -v pacman &>/dev/null; then
            sudo pacman -S --noconfirm zlib
        fi
    fi
}

# Try to run with FUSE first, fallback to extract-and-run
if [ -f "$APPIMAGE" ]; then
    # Check if FUSE is available
    if ldconfig -p 2>/dev/null | grep -q "libfuse.so.2"; then
        exec "$APPIMAGE" "$@"
    else
        # Fallback: extract and run (no FUSE needed)
        exec "$APPIMAGE" --appimage-extract-and-run "$@"
    fi
else
    echo "Error: Orchestra.AppImage not found at $APPIMAGE"
    exit 1
fi
