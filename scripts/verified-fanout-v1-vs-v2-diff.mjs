#!/usr/bin/env node
// #470: regenerate docs/evidence/470-v1-vs-v2.diff — the FULL-CONTEXT `diff -u` of the frozen v1 SKILL.md against the rendered v2 text, so the
// prose→code movement is visible and the test can rebuild BOTH sides from it (v1 side hashed, v2 side compared to the module).
//   node --experimental-strip-types --no-warnings scripts/verified-fanout-v1-vs-v2-diff.mjs <path to v1 SKILL.md>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const v1 = process.argv[2];
if (!v1 || !fs.existsSync(v1)) { console.error('usage: verified-fanout-v1-vs-v2-diff.mjs <v1 SKILL.md>'); process.exit(2); }
const { VERIFIED_FANOUT_SKILL } = await import(`${REPO}/src/shared/verified-fanout-skill.ts`);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-diff-'));
const v2 = path.join(dir, 'v2.md');
fs.writeFileSync(v2, VERIFIED_FANOUT_SKILL);
let out = '';
try { execFileSync('diff', ['-u', '-U', '100000', '--label', 'v1/verified-fanout/SKILL.md', '--label', 'v2/src/shared/verified-fanout-skill.ts (rendered)', v1, v2]); }
catch (e) { if (e.status !== 1) throw e; out = e.stdout.toString(); } // diff exits 1 when the files differ
fs.rmSync(dir, { recursive: true, force: true });
fs.writeFileSync(path.join(REPO, 'docs', 'evidence', '470-v1-vs-v2.diff'), out);
console.log(`wrote docs/evidence/470-v1-vs-v2.diff (${out.split('\n').length} lines)`);
