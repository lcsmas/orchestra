#!/usr/bin/env bash
# Fail LOUDLY when a committed capture was taken at a commit that is no longer
# HEAD — i.e. when the visual reference set silently misrepresents the tip.
#
# WHY THIS EXISTS. The captures are the yardstick for visual-parity work: an
# agent samples gtk-toolbar.png and reasons about whether a milestone landed.
# When the PNGs lag the code, that reasoning produces a clean, specific and
# COMPLETELY WRONG finding — this really happened: the set was last written at
# 8924229, two milestones (V3 headers/toolbar, V4 dialogs) landed after it, and
# sampling the stale toolbar gave "36px tall, flat colour" which reads as
# "V3's toolbar work did nothing". A fresh capture at the tip gives 48px and a
# three-step gradient. Nothing failed; a stale file just answered the question.
#
# STALENESS IS PER-FILE-PER-COMMIT, NOT A PROPERTY OF THE DIRECTORY. A capture
# taken at commit X is perfectly VALID evidence about X — it only becomes a lie
# when read as evidence about a LATER commit. So this script reports which
# surfaces were captured at which commit, and compares that to HEAD.
#
# Exit 0 = every capture was taken at HEAD. Exit 1 = at least one is stale.
#
# Usage: docs/visual-reference/check-fresh.sh [--at <commit>]
#   --at lets you ask "is this set fresh for commit X" — used to prove the
#   detector FIRES (point it at a wrong commit, demand exit 1).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
MANIFEST="$HERE/CAPTURED-AT.json"

REF="HEAD"
if [ "${1:-}" = "--at" ]; then REF="${2:?--at needs a commit}"; fi
WANT="$(git -C "$REPO" rev-parse "$REF")"

# A MISSING manifest must fail, not pass. An unmanifested set is exactly the
# state this tool exists to prevent, and "no manifest, no complaint" would make
# deleting the file the easiest way to silence the check.
if [ ! -f "$MANIFEST" ]; then
  echo "STALENESS CHECK FAILED: no $MANIFEST" >&2
  echo "  The capture set has no recorded provenance, so it cannot be trusted" >&2
  echo "  as evidence about any commit. Regenerate: docs/visual-reference/recapture.sh" >&2
  exit 1
fi

# Parsed with node (already a repo dependency) rather than jq, which is not
# guaranteed present on this host.
node - "$MANIFEST" "$WANT" "$HERE" <<'NODE'
const [, , manifestPath, want, dir] = process.argv;
const fs = require('node:fs');
const crypto = require('node:crypto');

const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const stale = [];
const missing = [];
const modified = [];

for (const [file, rec] of Object.entries(m.captures ?? {})) {
  const path = `${dir}/${file}`;
  if (!fs.existsSync(path)) { missing.push(file); continue; }
  if (rec.commit !== want) stale.push({ file, at: rec.commit });
  // A capture EDITED after the manifest was written is stale in a way the
  // commit field alone cannot see, so the digest is checked too.
  const md5 = crypto.createHash('md5').update(fs.readFileSync(path)).digest('hex');
  if (rec.md5 && rec.md5 !== md5) modified.push(file);
}

const short = (c) => c.slice(0, 7);
if (!stale.length && !missing.length && !modified.length) {
  const n = Object.keys(m.captures ?? {}).length;
  console.log(`staleness check PASSED: all ${n} captures were taken at ${short(want)}`);
  process.exit(0);
}

console.error(`STALENESS CHECK FAILED — the visual reference set does not describe ${short(want)}`);
if (stale.length) {
  console.error(`\n  ${stale.length} capture(s) were taken at a DIFFERENT commit:`);
  const byCommit = {};
  for (const s of stale) (byCommit[s.at] ??= []).push(s.file);
  for (const [c, files] of Object.entries(byCommit)) {
    console.error(`    captured at ${short(c)} (valid evidence about ${short(c)}, NOT about ${short(want)}):`);
    for (const f of files) console.error(`      - ${f}`);
  }
}
if (modified.length) {
  console.error(`\n  ${modified.length} capture(s) were MODIFIED after the manifest was written:`);
  for (const f of modified) console.error(`      - ${f}`);
}
if (missing.length) {
  console.error(`\n  ${missing.length} manifested capture(s) are MISSING from disk:`);
  for (const f of missing) console.error(`      - ${f}`);
}
console.error(`\n  Do NOT read these as evidence about ${short(want)}. Regenerate first:`);
console.error(`    docs/visual-reference/recapture.sh`);
process.exit(1);
NODE
