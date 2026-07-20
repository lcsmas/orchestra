#!/usr/bin/env bash
# Fail LOUDLY when the committed captures no longer describe the current tip —
# i.e. when the visual reference set has silently become a yardstick that lies.
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
# when read as evidence about a LATER commit. Every message below keeps that
# qualification, so this tool can never be read as "the old set was worthless"
# (M4-V2 was genuinely verified against those very captures).
#
# WHAT COUNTS AS STALE. Not "taken at a different commit than HEAD" — that rule
# is unusably strict, and a check that cries wolf is a check people learn to
# ignore, which is the very failure this tool exists to prevent. Committing the
# captures NECESSARILY creates a new HEAD, so a correctly-regenerated set would
# fail its own check one second after being written. (Observed, not theorised:
# the first version of this script did exactly that.)
#
# The captures are stale when RENDERING-AFFECTING CODE changed since they were
# taken. So the comparison is: did anything under the watched paths change
# between the capture commit and the target? A capture from an older commit
# whose rendering inputs are untouched is still honest evidence about the tip.
#
# Exit 0 = no rendering-affecting change since capture. Exit 1 = stale.
#
# Usage: docs/visual-reference/check-fresh.sh [--at <commit>]
#   --at lets you ask "is this set evidence about commit X" — used to prove the
#   detector FIRES (point it at a pre-V3 commit, demand exit 1).
set -euo pipefail

# Everything whose change can move a pixel in either frontend. Deliberately
# WIDE: a false "stale" costs one recapture, a false "fresh" costs a wrong
# verdict about whether a milestone landed — the asymmetry that motivated the
# whole tool. docs/ is excluded (except the drivers/seed, which determine WHAT
# is captured) so editing this file or the README does not invalidate the set.
WATCHED=(
  native/orchestra-gtk/src
  native/orchestra-gtk/Cargo.toml
  src/renderer
  src/main
  src/shared
  src/preload
  docs/visual-reference/seed-store.mjs
  docs/visual-reference/drive-gtk.py
  docs/visual-reference/drive-electron.mjs
)

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
node - "$MANIFEST" "$WANT" "$HERE" "$REPO" "${WATCHED[@]}" <<'NODE'
const [, , manifestPath, want, dir, repo, ...watched] = process.argv;
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const stale = [];
const missing = [];
const modified = [];

/** Rendering-affecting files changed between a capture's commit and the target.
 *  Memoised: every capture in a set almost always shares one commit. */
const churnCache = new Map();
const churnSince = (from) => {
  if (churnCache.has(from)) return churnCache.get(from);
  let files;
  try {
    files = execFileSync(
      'git',
      ['-C', repo, 'diff', '--name-only', `${from}..${want}`, '--', ...watched],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    )
      .split('\n')
      .filter(Boolean);
  } catch {
    // An unknown commit (rewritten history, capture from a dropped branch)
    // means we CANNOT prove freshness. Fail — an unanswerable question is not
    // a pass, and treating it as one is how a stale set slips through.
    files = ['<capture commit unreachable from the target — freshness unprovable>'];
  }
  churnCache.set(from, files);
  return files;
};

for (const [file, rec] of Object.entries(m.captures ?? {})) {
  const path = `${dir}/${file}`;
  if (!fs.existsSync(path)) {
    missing.push(file);
    continue;
  }
  const churn = churnSince(rec.commit);
  if (churn.length) stale.push({ file, at: rec.commit, churn });
  // A capture EDITED after the manifest was written is stale in a way the
  // commit field alone cannot see, so the digest is checked too.
  const md5 = crypto.createHash('md5').update(fs.readFileSync(path)).digest('hex');
  if (rec.md5 && rec.md5 !== md5) modified.push(file);
}

const short = (c) => c.slice(0, 7);
if (!stale.length && !missing.length && !modified.length) {
  const n = Object.keys(m.captures ?? {}).length;
  const at = [...new Set(Object.values(m.captures).map((r) => short(r.commit)))].join(', ');
  console.log(
    `staleness check PASSED: ${n} captures (taken at ${at}) — ` +
      `no rendering-affecting change between there and ${short(want)}`,
  );
  process.exit(0);
}

console.error(`STALENESS CHECK FAILED — the visual reference set does not describe ${short(want)}`);
if (stale.length) {
  const byCommit = {};
  for (const s of stale) (byCommit[s.at] ??= { files: [], churn: s.churn }).files.push(s.file);
  for (const [c, { files, churn }] of Object.entries(byCommit)) {
    console.error(
      `\n  ${files.length} capture(s) taken at ${short(c)} — still valid evidence about ` +
        `${short(c)}, but NOT about ${short(want)}, because rendering code changed since:`,
    );
    for (const f of churn.slice(0, 12)) console.error(`      changed: ${f}`);
    if (churn.length > 12) console.error(`      ... and ${churn.length - 12} more`);
    console.error('    affected captures:');
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
