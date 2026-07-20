#!/usr/bin/env node
/**
 * Record the provenance of every capture in CAPTURED-AT.json.
 *
 * WHY A SIDECAR AND NOT PNG METADATA. Both work; the sidecar wins on the axis
 * that matters here — being NOTICED. A tEXt chunk is invisible in a diff, in a
 * file listing and in review, so a set whose provenance silently stopped being
 * updated looks exactly like one that is current. CAPTURED-AT.json shows up in
 * `git diff` as a changed commit hash next to changed PNGs; a reviewer seeing
 * new binaries WITHOUT a manifest change has an obvious tell. It is also
 * greppable and readable without an image library, and it survives any tool
 * that rewrites a PNG (optimizers strip ancillary chunks by default).
 *
 * The md5 of each file is recorded alongside the commit so an image edited
 * AFTER capture — which the commit field alone cannot detect — is caught too.
 *
 * Usage: write-manifest.mjs <dir> [commit]
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: write-manifest.mjs <dir> [commit]');
  process.exit(1);
}

const commit =
  process.argv[3] ??
  execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

// Only the paired reference surfaces are manifested. Other PNGs in this
// directory (triptychs, probe artifacts) are narrative evidence about the
// commit that produced them, not a yardstick read against the tip, so holding
// them to HEAD would fail the check forever for no gain.
const PAIRED = /^(electron|gtk)-(full-window|sidebar|workspace-selected|main-pane|toolbar|sidebar-selected|dialog)\.png$/;

const captures = {};
for (const f of readdirSync(dir).sort()) {
  if (!PAIRED.test(f)) continue;
  captures[f] = {
    commit,
    md5: createHash('md5').update(readFileSync(path.join(dir, f))).digest('hex'),
  };
}

const n = Object.keys(captures).length;
if (n === 0) {
  console.error('write-manifest: no paired captures found — refusing to write an empty manifest');
  process.exit(1);
}

const manifest = {
  _comment:
    'Provenance for the paired visual-reference captures. Each entry is the commit the ' +
    'capture was taken at. A capture is VALID evidence about ITS OWN commit and stale only ' +
    'when read as evidence about a later one — staleness is per-file-per-commit, not a ' +
    'property of this directory. check-fresh.sh fails when any entry is not HEAD.',
  captures,
};

const out = path.join(dir, 'CAPTURED-AT.json');
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`-- wrote CAPTURED-AT.json: ${n} captures at ${commit.slice(0, 7)}`);
