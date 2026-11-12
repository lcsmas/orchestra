#!/usr/bin/env bash
# #442 prep (D) — packaged-app proof rig SKELETON for spec #431 ("every agent has a run"): boots a PACKAGED Orchestra
# (AppImage or unpacked binary) in its OWN headless sway on a SYNTHETIC pre-update data dir (scripts/build-pre-update-fixture.mjs)
# and reports which workspaces have a run. Driver + clauses: scripts/e2e-packaged-run-proof.mjs.
#
# Usage: scripts/e2e-packaged-run-proof.sh --exe <Orchestra.AppImage|unpacked-binary> [--arm before|after|fleet] [--settle <s>] [--base <ref>] [--min-avail-gb <n>] [--list]
#   before  the CURRENT master build: the census MUST show the gap (run-less workspaces) — the arm that proves the rig can see it
#   after   the built vague: every workspace has a run, mail flows (criterion + mail clauses are filled by the final #442 run)
#   fleet   the unchanged LEAD → OPS → workers runs keep their rows/flags/mail
# Containment (own sway, marker-verified, private XDG runtime dir, `env -i` allowlist) is e2e-contained-rig.sh's; this wrapper only
# picks a short btrfs rig base (never tmpfs, never /tmp) and tells the driver which live config dirs to PROTECT.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for a in "$@"; do [[ "$a" == "--list" ]] && exec node "${HERE}/e2e-packaged-run-proof.mjs" --list; done
[[ " $* " == *" --exe "* ]] || { echo "usage: $0 --exe <app> [--arm before|after|fleet] [--settle <s>] [--base <ref>] [--min-avail-gb <n>] [--list]" >&2; exit 2; }

# The invoker's LIVE config dir is only PROTECTED (snapshot before/after), never handed to the app.
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
export CLAUDE_CONFIG_DIR_PIN="${CFG}"
# SHORT on purpose: keeper socket paths under the rig dir must stay < 100 chars (see e2e-agent-view-removal.sh).
export E2E_RIG_BASE="${E2E_RIG_BASE:-/var/tmp/ppr-$(id -u)}"
mkdir -p -m 700 "${E2E_RIG_BASE}"
[[ -O "${E2E_RIG_BASE}" && ! -L "${E2E_RIG_BASE}" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is not a directory owned by me (or is a symlink)" >&2; exit 2; }
chmod 700 "${E2E_RIG_BASE}"
[[ "$(findmnt -no FSTYPE -T "${E2E_RIG_BASE}")" != "tmpfs" ]] || { echo "ABORT: rig base ${E2E_RIG_BASE} is on tmpfs — must be a real disk filesystem" >&2; exit 2; }
# Foreground, no inner `&`: the contained rig tears its sway down on exit.
exec "${HERE}/e2e-contained-rig.sh" node "${HERE}/e2e-packaged-run-proof.mjs" "$@"
