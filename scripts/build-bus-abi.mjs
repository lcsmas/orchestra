#!/usr/bin/env node
// Build the better-sqlite3 native binding for BOTH ABIs this repo runs under and
// stash each one in build/bus-abi/, then leave node_modules holding the ELECTRON
// build (the one that ships).
//
// WHY TWO. `pnpm run test` runs on system node (ABI 127). The AppImage runs
// Electron 33.4.11 (ABI 130), and so does the packaged CLI via
// ELECTRON_RUN_AS_NODE. A `.node` built for one ABI is unusable under the other.
// Only the ABI-130 build is packaged; the ABI-127 copy exists so the bus unit
// tests can construct a REAL database instead of a mock. src/main/bus-binding.ts
// picks the right one at runtime via better-sqlite3's `nativeBinding` option.
//
// EVERY CHECK HERE CONSTRUCTS A DATABASE. `require('better-sqlite3')` succeeds
// under the WRONG ABI (the native load is deferred to the first `new Database()`)
// — spike #109's headline trap. A require-only check is not a check.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build', 'bus-abi');
const PKG = path.join(
  ROOT,
  'node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3',
);
const BUILT = path.join(PKG, 'build/Release/better_sqlite3.node');
const ELECTRON = path.join(ROOT, 'node_modules/.bin/electron');
const ELECTRON_VERSION = '33.4.11';

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8', ...opts });
}

/** The ABI a runtime reports. Cheap, and it tells us which file to name. */
function abiOf(runner) {
  if (runner === 'node') return sh('node', ['-p', 'process.versions.modules']).trim();
  return sh(ELECTRON, ['-p', 'process.versions.modules'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).trim();
}

/**
 * THE gate: construct a Database from `bindingPath` under `runner`.
 * Returns {ok, detail}. Never uses require() as the verdict.
 */
function constructProbe(runner, bindingPath) {
  const script = `
    const path = require('path');
    const Base = require(${JSON.stringify(path.join(PKG, 'lib/database.js'))});
    const db = new Base(':memory:', { nativeBinding: ${JSON.stringify(bindingPath)} });
    db.exec('CREATE TABLE t(x)');
    db.prepare('INSERT INTO t VALUES (?)').run(42);
    const got = db.prepare('SELECT x FROM t').get().x;
    if (got !== 42) throw new Error('readback ' + got);
    console.log('CONSTRUCT_OK abi=' + process.versions.modules);
  `;
  try {
    const out =
      runner === 'node'
        ? sh('node', ['-e', script])
        : sh(ELECTRON, ['-e', script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    return { ok: out.includes('CONSTRUCT_OK'), detail: out.trim() };
  } catch (e) {
    return { ok: false, detail: String(e.stderr || e.message).split('\n').slice(0, 3).join(' ') };
  }
}

fs.mkdirSync(OUT, { recursive: true });

const nodeAbi = abiOf('node');
const electronAbi = abiOf('electron');
console.log(`ABIs: node=${nodeAbi} electron(as-node)=${electronAbi}`);

// 1. node ABI build.
console.log(`building better-sqlite3 for node ABI ${nodeAbi} …`);
sh('npx', ['--yes', 'node-gyp@10', 'rebuild', '--release'], { cwd: PKG });
const nodeBinding = path.join(OUT, `better_sqlite3-abi${nodeAbi}.node`);
fs.copyFileSync(BUILT, nodeBinding);

// 2. Electron ABI build — LAST, so node_modules is left holding the shipped one.
console.log(`building better-sqlite3 for Electron ABI ${electronAbi} …`);
sh('npx', ['@electron/rebuild', '-v', ELECTRON_VERSION, '-m', '.', '-f', '-w', 'better-sqlite3']);
const electronBinding = path.join(OUT, `better_sqlite3-abi${electronAbi}.node`);
fs.copyFileSync(BUILT, electronBinding);

// The two builds must be DIFFERENT files. If node-gyp and @electron/rebuild
// somehow produced identical bytes, one of the two builds did not happen and
// every probe below would be testing the same artifact twice.
const { createHash } = await import('node:crypto');
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
const nodeSha = sha(nodeBinding);
const electronSha = sha(electronBinding);
if (nodeSha === electronSha) {
  console.error(`FAIL: both ABI builds are byte-identical (${nodeSha}) — one build did not run`);
  process.exit(1);
}
console.log(`  abi${nodeAbi}=${nodeSha}  abi${electronAbi}=${electronSha}  (distinct ✓)`);

// 3. The matrix. Each runtime must CONSTRUCT with its own binding (must-PASS)
//    and FAIL to construct with the other's (must-FAIL). The must-FAIL arm is
//    what proves the must-PASS arm measured the ABI at all.
const arms = [
  ['node', nodeBinding, true, `node/abi${nodeAbi}`],
  ['node', electronBinding, false, `node/abi${electronAbi} (must FAIL)`],
  ['electron', electronBinding, true, `electron/abi${electronAbi}`],
  ['electron', nodeBinding, false, `electron/abi${nodeAbi} (must FAIL)`],
];
let bad = 0;
for (const [runner, binding, expectOk, label] of arms) {
  const r = constructProbe(runner, binding);
  const pass = r.ok === expectOk;
  if (!pass) bad++;
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label} → ${r.ok ? 'constructed' : 'refused'}`);
  if (!pass) console.log(`        ${r.detail}`);
}

// 4. THE TRAP ITSELF, asserted so that it can fail.
//
// This arm used to require lib/database.js and call the success "proof" that a
// require is not a gate. That assertion CANNOT FAIL: measured, it prints ok even
// with the binding DELETED from the tree, so it was true for every state and the
// `if (!requireOnly)` branch was dead code — decoration in the one script whose
// entire thesis is "a require-only check is not a check".
//
// The honest form needs BOTH halves against the SAME wrong-ABI binding, in the
// SAME runtime, in one command:
//   (a) require SUCCEEDS   — the false pass a require-only gate would report
//   (b) construct THROWS   — the truth only construction reveals
// Only the pair is evidence. (a) alone is what fooled the spike; (b) alone would
// not show that require is misleading.
const trapScript = (binding) => `
  const path = require('path');
  let requireOk = false, constructOk = false, err = '';
  try { require(${JSON.stringify(path.join(PKG, 'lib/database.js'))}); requireOk = true; } catch (e) { err = String(e.message); }
  try {
    const D = require(${JSON.stringify(path.join(PKG, 'lib/database.js'))});
    new D(':memory:', { nativeBinding: ${JSON.stringify(binding)} });
    constructOk = true;
  } catch (e) { err = String(e.message).split('\\n')[0]; }
  console.log(JSON.stringify({ requireOk, constructOk, abi: process.versions.modules, err: err.slice(0, 90) }));
`;

// Run under node (ABI 127) pointed at the ELECTRON (130) binding: the mismatch.
let trap;
try {
  trap = JSON.parse(sh('node', ['-e', trapScript(electronBinding)]).trim());
} catch (e) {
  console.error('FAIL: the require-trap arm did not run:', String(e.message).slice(0, 120));
  process.exit(1);
}

const trapOk = trap.requireOk === true && trap.constructOk === false;
console.log(
  `  ${trapOk ? 'PASS' : 'FAIL'}  require-trap under node(abi ${trap.abi}) with the abi${electronAbi} binding: ` +
    `require=${trap.requireOk ? 'SUCCEEDED' : 'threw'}, construct=${trap.constructOk ? 'SUCCEEDED' : 'THREW'}`,
);
if (!trapOk) {
  console.error(
    trap.constructOk
      ? '        construct SUCCEEDED against a wrong-ABI binding — the arm is not testing what it claims'
      : '        require THREW, so this arm no longer demonstrates the trap (did better-sqlite3 stop deferring the native load?)',
  );
  bad++;
} else {
  console.log(`        ^ this is why every ABI gate here CONSTRUCTS. (${trap.err})`);
}

if (bad > 0) {
  console.error(`\nbuild-bus-abi: ${bad} arm(s) did not behave as required`);
  process.exit(1);
}
console.log('\nbuild-bus-abi: OK — both bindings built, 4/4 construct arms + require-trap as expected');
console.log(`node_modules now holds the ELECTRON (abi ${electronAbi}) build — the one that ships.`);
