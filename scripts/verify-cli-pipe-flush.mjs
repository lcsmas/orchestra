#!/usr/bin/env node
/**
 * GATE for issue #62 — a LARGE verdict piped out of the CLI must arrive
 * COMPLETE, not truncated.
 *
 * THE DEFECT
 * ----------
 * `process.stdout.write()` to a PIPE is asynchronous: libuv buffers whatever
 * the pipe will not take immediately and flushes it on later ticks.
 * `process.exit()` in the SAME TICK as a large write abandons the remainder, so
 * the reader gets a truncated prefix and NO error anywhere. A 3000-commit
 * `verify-landed` NOT-LANDED verdict is ~182 KB, well past the ~143 KB
 * (146496 = 143*1024) that survives.
 *
 * WHY THIS RUNS EACH ARM MANY TIMES — READ BEFORE "SIMPLIFYING" IT
 * ----------------------------------------------------------------
 * **The bug is a RACE, not a deterministic property.** On the unfixed build the
 * same bundle with the same input truncated only 4/20 runs; a neutered-drain
 * mutant truncated 9/20. A SINGLE run of the unfixed build therefore passes
 * most of the time — a one-shot gate here is a dice roll that reads as a
 * measurement. Five separate live-verified mutants of the fix each passed a
 * one-run gate purely by winning the race. So every arm reports a k/n split and
 * the gate asserts on the RATE.
 *
 * This is also why the fixed arm must be 0/N and not merely "better".
 *
 * PROVE-CAN-FAIL: `--expect-broken` runs against a bundle whose drain has been
 * removed and REQUIRES truncation to appear. A gate nobody has watched fail is
 * not a gate.
 *
 *   node scripts/verify-cli-pipe-flush.mjs
 *   node scripts/verify-cli-pipe-flush.mjs --runs 40
 *   node scripts/verify-cli-pipe-flush.mjs --bundle /tmp/mutant.js --expect-broken
 *
 * The socket is a stub returning a canned /verifyLanded payload, so no repo, no
 * worktrees and no Orchestra state are needed — it isolates exactly the axis
 * under test (the CLI's exit path on a pipe).
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const ELECTRON = path.join(REPO, 'node_modules', '.bin', 'electron');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const EXPECT_BROKEN = argv.includes('--expect-broken');
const RUNS = Number(flag('--runs', '20'));
const N = Number(flag('--commits', '3000'));
const CLI = path.resolve(flag('--bundle', path.join(REPO, 'dist-electron', 'cli.js')));

function die(msg) {
  console.error(`\n✘ ${msg}`);
  process.exit(1);
}
if (!existsSync(CLI)) die(`missing ${CLI} — run \`pnpm run build:cli\` first`);
if (!existsSync(ELECTRON)) die(`missing ${ELECTRON} — run \`pnpm install\` first`);

const tmp = mkdtempSync(path.join(os.tmpdir(), 'cli-pipe-flush-'));
const SOCK = path.join(tmp, 'orchestra.sock');

const commits = Array.from(
  { length: N },
  (_, i) =>
    `${(0x1000000 + i).toString(16).padStart(7, '0')} commit message number ${i} padding padding padding`,
);
const EXPECTED =
  `NOT LANDED: ${N} commit(s) on child missing from main:\n` +
  `${commits.map((c) => `  ${c}`).join('\n')}\n`;
const EXPECTED_BYTES = Buffer.byteLength(EXPECTED);

let reply = {
  ok: true,
  id: 'x',
  branch: 'child',
  target: 'main',
  unmerged: N,
  commits,
};
const server = http.createServer((req, res) => {
  let d = '';
  req.on('data', (c) => (d += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
});
await new Promise((resolve, reject) => {
  server.on('error', reject);
  server.listen(SOCK, resolve);
});

/**
 * Run the built CLI INSIDE a real Electron main process with stdout on a PIPE.
 * `ELECTRON_RUN_AS_NODE` is deliberately NOT set — that degrades Electron to
 * plain node and changes the program under test.
 */
function run(args, tag) {
  const f = path.join(tmp, `${tag}.cjs`);
  writeFileSync(
    f,
    `const { app } = require('electron');
     app.disableHardwareAcceleration();
     app.whenReady().then(async () => {
       const { runCli } = require(${JSON.stringify(CLI)});
       await runCli(${JSON.stringify(args)});
     });`,
  );
  return new Promise((resolve) => {
    const c = spawn(ELECTRON, [f, '--no-sandbox'], {
      env: { ...process.env, ORCHESTRA_SOCK: SOCK, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], // <-- STDOUT IS A PIPE: the axis under test
    });
    const chunks = [];
    let stderr = '';
    c.stdout.on('data', (d) => chunks.push(d));
    c.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => {
      c.kill('SIGKILL');
      resolve({ code: -1, buf: Buffer.concat(chunks), stderr: `${stderr}\n[rig] TIMEOUT` });
    }, 120_000);
    c.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, buf: Buffer.concat(chunks), stderr });
    });
  });
}

console.log(`\n[rig] CLI bundle   ${CLI}`);
console.log(`[rig] payload      ${N} commits = ${EXPECTED_BYTES} bytes on a pipe`);
console.log(`[rig] runs per arm ${RUNS}`);
console.log(`[rig] mode         ${EXPECT_BROKEN ? 'EXPECT-BROKEN (prove-can-fail)' : 'EXPECT-FIXED'}\n`);

const failures = [];

// --- THE REGRESSION: N runs of a big NOT-LANDED verdict --------------------
const marks = [];
let truncated = 0;
let badCode = 0;
let inexact = 0;
for (let i = 0; i < RUNS; i += 1) {
  const r = await run(['verify-landed', 'some-id'], `big-${i}`);
  const bytes = r.buf.length;
  const isTrunc = bytes < EXPECTED_BYTES;
  if (isTrunc) truncated += 1;
  if (r.code !== 2) badCode += 1;
  if (!isTrunc && r.buf.toString('utf8') !== EXPECTED) inexact += 1;
  marks.push(isTrunc ? `${bytes}T` : `${bytes}.`);
}
console.log(`big verdict  TRUNCATED ${truncated}/${RUNS}   RC!=2 ${badCode}/${RUNS}`);
console.log(`  runs: ${marks.join(' ')}`);

if (EXPECT_BROKEN) {
  if (truncated === 0)
    failures.push(
      `PROVE-CAN-FAIL: expected truncation to appear in ${RUNS} runs and it never did. ` +
        `Either the bundle is already fixed (the gate proves nothing) or ${RUNS} runs is ` +
        `too few for this race — raise --runs before concluding.`,
    );
} else {
  if (truncated !== 0)
    failures.push(`big verdict truncated ${truncated}/${RUNS} times (want 0/${RUNS})`);
  if (badCode !== 0) failures.push(`big verdict exited != 2 in ${badCode}/${RUNS} runs`);
  if (inexact !== 0)
    failures.push(`${inexact}/${RUNS} untruncated runs did not match the verdict BYTE-EXACTLY`);
}

// --- CONTROL 1: the small LANDED verdict still works and still exits 0 ------
// Guards the opposite failure: a "fix" that drops output or always exits
// nonzero would sail through the truncation check while destroying the verb.
reply = { ok: true, id: 'x', branch: 'child', target: 'main', unmerged: 0, commits: [] };
{
  const r = await run(['verify-landed', 'some-id'], 'landed');
  const want = 'LANDED: every commit on child is on main (0 unmerged)\n';
  const ok = r.code === 0 && r.buf.toString('utf8') === want;
  console.log(`CONTROL landed  RC=${r.code} (want 0) textExact=${r.buf.toString('utf8') === want}`);
  if (!ok) failures.push(`LANDED control broke: RC=${r.code}, stdout=${JSON.stringify(r.buf.toString())}`);
}

// --- CONTROL 2: the ERROR path keeps RC=1 on stderr (issue #59's contract) --
reply = { ok: false, error: 'unknown workspace: some-id' };
{
  const r = await run(['verify-landed', 'some-id'], 'err');
  const onStderr = /unknown workspace/.test(r.stderr);
  const noVerdict = !/LANDED/.test(r.buf.toString('utf8'));
  const ok = r.code === 1 && onStderr && noVerdict;
  console.log(`CONTROL error   RC=${r.code} (want 1) stderrOk=${onStderr} noVerdict=${noVerdict}`);
  if (!ok) failures.push(`ERROR control broke: RC=${r.code}, stderr=${JSON.stringify(r.stderr.slice(0, 200))}`);
}

// --- CONTROL 3: nothing leaks onto stderr on the big happy path ------------
// The first cut of the #62 fix left a `throw` after `process.exit()` that
// escaped runCli as an UnhandledPromiseRejectionWarning — printed on stderr,
// which is exactly the stream a caller parses. Caught by this control.
reply = { ok: true, id: 'x', branch: 'child', target: 'main', unmerged: N, commits };
{
  const r = await run(['verify-landed', 'some-id'], 'noise');
  const quiet = r.stderr.trim() === '';
  console.log(`CONTROL stderr quiet on big verdict: ${quiet}`);
  if (!quiet && !EXPECT_BROKEN)
    failures.push(`stderr not empty on the big verdict: ${JSON.stringify(r.stderr.trim().slice(0, 300))}`);
}

server.close();
rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✘ FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(EXPECT_BROKEN ? '\n✔ truncation reproduced on the unfixed bundle' : '\n✔ #62 gate PASSED');
