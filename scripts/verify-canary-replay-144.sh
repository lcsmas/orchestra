#!/usr/bin/env bash
# #144 G6 — the canary replay runner. Both arms required.
#
# Drives the REAL sweep against a REAL SQLite bus + a real structured session and
# counts the `user-message` events the reader's transcript would render (the same
# observable #117's e2e uses — not the ledger/predicate/return-value the wake code
# itself writes).
#
#   full   ★ recipient = the canonicalized FULL id  -> reader woken (1 turn)
#   short  ★ recipient = the 8-char SHORT handle    -> reader NEVER woken (0 turns)
#            = the exact rows 444-448 canary symptom the fix removes upstream.
#
# The two arms differ ONLY in the stored recipient, so a build that ignored the
# recipient would wake on both (short fails) and one that never wakes would wake
# on neither (full fails). Only the correct full-id comparison passes both.
#
# This is the SYSTEM-NODE fast variant. The PACKAGED arm (VERIFY-G, the installed
# env) additionally proves the packaged CLI's `send --to <8-char>` CANONICALIZES
# to the full id on the Electron ABI before the sweep runs — see the note below.
set -uo pipefail
cd "$(dirname "$0")/.."
ARMS=(full short)
FAILED=0
for arm in "${ARMS[@]}"; do
  out="$(E2E_HOME="${E2E_HOME:-/tmp/canary-144}" \
         node --experimental-strip-types --import ./scripts/.r2-register.mjs \
         scripts/canary-replay-144.mjs "$arm" 2>/dev/null | tail -1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    printf '  FAIL %-6s rc=%s %s\n' "$arm" "$rc" "$out"
    FAILED=1
  else
    printf '  ok   %-6s %s\n' "$arm" "$out"
  fi
done
if [ "$FAILED" -ne 0 ]; then
  echo "#144 canary replay: FAILED"
  exit 1
fi
echo "#144 canary replay: PASS — ${#ARMS[@]}/${#ARMS[@]} arms"

# ── PACKAGED arm (VERIFY-G, the installed env) ──────────────────────────────
# The rig above proves the WAKE side on system-node. The remaining packaged
# proof is that the shipped CLI, on the Electron ABI, canonicalizes a short
# handle to the full id BEFORE writing the row — so the stored recipient the
# sweep matches is the full id. Recipe (own ORCHESTRA_HOME + a COPY of a bus,
# headless, DISPLAY unset), run by VERIFY-G against the installed AppImage:
#
#   1. Seed a workspace whose id is the FULL uuid (via the app store / a
#      resolvable /resolveHandle candidate).
#   2. `Orchestra.AppImage cli send --type dispatch --to <8-char> --run <r>
#         --as <member-full-id> "report"` against the COPY bus.
#   3. Assert the stored `recipient` is the FULL id (post-fix), NOT the 8-char
#      handle (must-FAIL: the unfixed AppImage stores the short handle).
#   4. Assert `check --run <r> --as <full-ops-id>` returns the row and, with the
#      wake sweep live, the reader is woken within one sweep.
# never the live ~/.orchestra/bus.sqlite; DISPLAY unset; env -i +
# XDG_RUNTIME_DIR=/run/user/<uid> per headless-sway-e2e.
