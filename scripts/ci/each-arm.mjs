#!/usr/bin/env node
// #568 — run a one-arm-per-process rig over EVERY arm it declares: `node each-arm.mjs [--script <file>] <command…>` appends the arm as the last argument.
// Arms are read from the rig's own source (an `ARMS = [...]` array, `ARMS = { key: … }` keys, or an inline `[...].includes(ARM)` list), never typed here:
// a rig whose arms cannot be read FAILS (no arms = no silent green). Prints `ARM <name>: PASS|FAIL` per arm and `EACH-ARM: n/m PASS`; exit 1 if any arm failed.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { judgeArm } from '../../src/shared/ci-rigs.ts';

// `--expect-abort <arm>=<text>` (repeatable, before the command): an arm that is a must-ABORT self-test (e.g. `hang_selftest`, which hangs ON PURPOSE so the rig's deadline fires) passes
// when it exits non-zero AND its output contains <text>; any other outcome of that arm is red.
const argv = process.argv.slice(2);
const expectAbort = new Map();
while (argv[0] === '--expect-abort') { argv.shift(); const [a, ...t] = argv.shift().split('='); expectAbort.set(a, t.join('=')); }
const script = argv.find((a) => /scripts\/(?!\.)[\w./-]+\.mjs$/.test(a));
if (!script) { console.error('each-arm: no scripts/*.mjs in the command'); process.exit(2); }
const src = fs.readFileSync(script, 'utf8');

export function armsOfSource(text) {
  let m = /const ARMS\s*=\s*\[([^\]]*)\]/.exec(text);
  if (m) return [...m[1].matchAll(/['"]([\w-]+)['"]/g)].map((x) => x[1]);
  m = /const ARMS\s*=\s*\{\n([\s\S]*?)\n\};/.exec(text);
  if (m) return [...m[1].matchAll(/^  ['"]?([\w-]+)['"]?\s*:/gm)].map((x) => x[1]);
  m = /\[((?:'[\w-]+',?\s*)+)\]\.includes\(ARM\)/.exec(text);
  if (m) return [...m[1].matchAll(/['"]([\w-]+)['"]/g)].map((x) => x[1]);
  return [];
}
const arms = armsOfSource(src);
if (arms.length === 0) { console.error(`each-arm: cannot read the arms of ${script} — an arm list nobody can read is a rig nobody ran`); process.exit(2); }
// An arm is its own process; a timing arm that fails once and passes on a fresh process is runner flake: up to 3 attempts, ALL printed (a deterministic red fails 3x).
const ATTEMPTS = 3;
let pass = 0;
for (const arm of arms) {
  let ok = false; let r; let tries = 0;
  while (!ok && tries < ATTEMPTS) {
    tries++;
    r = spawnSync('bash', ['-c', `${argv.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')} '${arm}'`], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 240_000 });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const v = judgeArm(r.status, out, expectAbort.get(arm));
    ok = v.ok;
    if (!ok) process.stdout.write(`${out.split('\n').slice(-25).join('\n')}\n[each-arm] ${arm}: red — ${v.why}\n`);
  }
  if (ok) pass++;
  console.log(`ARM ${arm}: ${ok ? 'PASS' : 'FAIL'} (exit ${r.status}${r.signal ? ` ${r.signal}` : ''}${tries > 1 ? `, ${tries} attempts` : ''})`);
}
console.log(`EACH-ARM: ${pass}/${arms.length} PASS`);
process.exit(pass === arms.length ? 0 : 1);
