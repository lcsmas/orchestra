#!/usr/bin/env bash
# #421 — the phone's bloc HTML on a real headless Chromium in iPhone emulation (no window: --headless=new, scratch profile, scratch HOME).
# Usage: scripts/acces-mobile-bloc-rig.sh [--out <dir>]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node --experimental-strip-types --no-warnings "${HERE}/acces-mobile-bloc-rig.mjs" "$@"
