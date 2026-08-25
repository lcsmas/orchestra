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
 * `verify-landed` NOT-LANDED verdict is 181945 bytes, well past the 146496 that
 * survived when it truncated. (146496 is an observed figure, not a round buffer
 * size: 143*1024 = 146432, 64 bytes short. No mechanism is claimed for it.)
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
 * That arm asserts THREE things, not one. Asserting only "some run was short"
 * was itself a defect (issue #62 R1): it passed on a bundle whose drain was
 * fully intact and whose verdict body had merely been shortened, i.e. it could
 * not tell "the drain is missing" from "stdout is short for any other reason".
 * So a short run only counts as #62 truncation when the bytes received are a
 * genuine PREFIX of the expected verdict AND the run still exits 2.
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
    const c = spawn(ELECTRON, [f, '--no-sandbox', `--user-data-dir=${path.join(tmp, 'electron-user-data')}`], {
      env: {
        ...process.env,
        ORCHESTRA_SOCK: SOCK,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        // CONTAINMENT (ledger #70 LEAD order). This rig inherits the parent env,
        // which in an agent workspace carries the HUMAN'S real WAYLAND_DISPLAY /
        // DISPLAY. Nothing here should ever open a window — the CLI path exits
        // before any BrowserWindow — but "it happens not to" is luck, not
        // containment, and this rig spawns hundreds of Electron processes.
        // Blank the display handles and pin a throwaway user-data-dir so a
        // window CANNOT land on the user's screen even if a future edit creates
        // one. Also keeps ~/.config/Electron untouched.
        WAYLAND_DISPLAY: '',
        DISPLAY: '',
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
      },
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
let notAPrefix = 0;
for (let i = 0; i < RUNS; i += 1) {
  const r = await run(['verify-landed', 'some-id'], `big-${i}`);
  const bytes = r.buf.length;
  const text = r.buf.toString('utf8');
  const isTrunc = bytes < EXPECTED_BYTES;
  // A run only counts as #62 TRUNCATION if what arrived is a genuine PREFIX of
  // the verdict — i.e. an in-flight write was abandoned. Output that is merely
  // SHORT (a different verdict body, an error, a reordered payload) is a
  // different defect and must NOT be able to satisfy --expect-broken. Without
  // this, `--expect-broken` passed on a bundle whose drain was fully intact and
  // only the verdict body had been shortened (issue #62 R1).
  const isPrefix = EXPECTED.startsWith(text);
  if (isTrunc) truncated += 1;
  if (isTrunc && !isPrefix) notAPrefix += 1;
  if (r.code !== 2) badCode += 1;
  if (!isTrunc && text !== EXPECTED) inexact += 1;
  marks.push(isTrunc ? `${bytes}${isPrefix ? 'T' : 'X'}` : `${bytes}.`);
}
console.log(
  `big verdict  TRUNCATED ${truncated}/${RUNS}   RC!=2 ${badCode}/${RUNS}   ` +
    `short-but-NOT-a-prefix ${notAPrefix}/${RUNS}`,
);
console.log(`  runs: ${marks.join(' ')}`);

if (EXPECT_BROKEN) {
  if (truncated === 0)
    failures.push(
      `PROVE-CAN-FAIL: expected truncation to appear in ${RUNS} runs and it never did. ` +
        `Either the bundle is already fixed (the gate proves nothing) or ${RUNS} runs is ` +
        `too few for this race — raise --runs before concluding.`,
    );
  // #62 truncation is a RACE, so the surviving prefix must be UNSTABLE: across
  // runs it lands at different byte counts, and at least one run flushes fully.
  // A bundle that is simply short prints the SAME byte count every time and
  // never completes. This is the assertion that actually separates "abandoned
  // an in-flight write" from "printed less" — the prefix check alone does NOT:
  // a shortened verdict body can be a byte-exact prefix of the full verdict by
  // construction (measured: `commits.slice(0,10)` yields 635 bytes that
  // `EXPECTED.startsWith()` accepts), which is precisely how the drain-intact
  // mutant defeated the first version of this arm (issue #62 R1).
  const distinctSizes = new Set(marks.map((m) => m.replace(/[TX.]$/, ''))).size;
  if (truncated === RUNS && distinctSizes === 1)
    failures.push(
      `PROVE-CAN-FAIL: all ${RUNS} runs were short at the SAME byte count and none ` +
        `completed. #62 is a race — a genuine unfixed bundle varies and sometimes ` +
        `flushes fully. This looks like output that is simply shorter, not truncation.`,
    );
  // The observed short output must be the #62 defect, not merely less output.
  // A bundle that fails with a non-2 status is short for a different reason.
  if (notAPrefix !== 0)
    failures.push(
      `PROVE-CAN-FAIL: ${notAPrefix}/${RUNS} short runs were NOT a prefix of the expected ` +
        `verdict. That is short output, not #62 truncation — this arm would "reproduce" ` +
        `the bug on a bundle whose drain is intact.`,
    );
  if (badCode !== 0)
    failures.push(
      `PROVE-CAN-FAIL: ${badCode}/${RUNS} runs exited != 2. A bundle that truncates because ` +
        `it is failing differently does not demonstrate #62.`,
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

// --- BROKEN PIPE: `| head -1` must not HANG (issue #62 R2) -----------------
// The reader closes after the first chunk. The CLI must still terminate. The
// first cut of the fix hung 8/10 here (10s+ each) against 0/10 on master,
// because the drain waited on a callback that a destroyed stream never fires.
// A same-rig POSITIVE CONTROL (pipe NOT destroyed) is in the big-verdict arm
// above: it returns 181945 bytes and RC=2, proving this rig can see a non-hang.
reply = { ok: true, id: 'x', branch: 'child', target: 'main', unmerged: N, commits };
{
  const HANG_RUNS = Math.min(RUNS, 6);
  const HANG_TIMEOUT_MS = 10_000;
  let hung = 0;
  const hangMarks = [];
  for (let i = 0; i < HANG_RUNS; i += 1) {
    const f = path.join(tmp, `hangup-${i}.cjs`);
    writeFileSync(
      f,
      `const { app } = require('electron');
       app.disableHardwareAcceleration();
       app.whenReady().then(async () => {
         const { runCli } = require(${JSON.stringify(CLI)});
         await runCli(['verify-landed', 'some-id']);
       });`,
    );
    const r = await new Promise((resolve) => {
      const t0 = Date.now();
      const c = spawn(ELECTRON, [f, '--no-sandbox', `--user-data-dir=${path.join(tmp, 'electron-user-data')}`], {
        env: {
        ...process.env,
        ORCHESTRA_SOCK: SOCK,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        // CONTAINMENT (ledger #70 LEAD order). This rig inherits the parent env,
        // which in an agent workspace carries the HUMAN'S real WAYLAND_DISPLAY /
        // DISPLAY. Nothing here should ever open a window — the CLI path exits
        // before any BrowserWindow — but "it happens not to" is luck, not
        // containment, and this rig spawns hundreds of Electron processes.
        // Blank the display handles and pin a throwaway user-data-dir so a
        // window CANNOT land on the user's screen even if a future edit creates
        // one. Also keeps ~/.config/Electron untouched.
        WAYLAND_DISPLAY: '',
        DISPLAY: '',
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '',
      },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      c.stdout.on('data', () => c.stdout.destroy()); // <-- this IS `| head -1`
      c.stderr.on('data', () => {});
      const timer = setTimeout(() => {
        try {
          process.kill(-c.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
        resolve({ hung: true, ms: Date.now() - t0 });
      }, HANG_TIMEOUT_MS);
      c.on('close', () => {
        clearTimeout(timer);
        resolve({ hung: false, ms: Date.now() - t0 });
      });
    });
    if (r.hung) hung += 1;
    hangMarks.push(r.hung ? `HUNG(${r.ms}ms)` : `${r.ms}ms`);
  }
  console.log(`CONTROL broken pipe (| head -1)  HUNG ${hung}/${HANG_RUNS}   ${hangMarks.join(' ')}`);
  // REPORTED, and failed only on a TOTAL hang.
  //
  // Why not `hung !== 0`: this rate is NOT attributable to the build. Measured
  // block-wise (all runs of one bundle, then the other) it swings wildly for a
  // FIXED bundle and for MASTER alike — 0/10, 8/10 and 10/10 were all observed
  // for the same unchanged master bytes within one session. Run INTERLEAVED
  // with alternating order, which cancels machine-state drift, master and the
  // #62 fix came out 0/25 vs 0/25 (and 0/10 vs 1/10 on a smaller run). So a
  // nonzero count here is evidence about the MACHINE, not the candidate, and
  // asserting on it would fail honest builds at random.
  //
  // A TOTAL hang is still worth failing on: if every run hangs while the
  // big-verdict arm above completed, the process genuinely cannot terminate on
  // a closed reader. That is the shape the R2 fix guards (bounded timer +
  // 'error'/'close' listeners), and it is not something drift produces.
  if (hung === HANG_RUNS && HANG_RUNS > 1)
    failures.push(
      `broken-pipe hang: ${hung}/${HANG_RUNS} runs — EVERY run failed to terminate when ` +
        `the reader closed early (\`orchestra verify-landed | head -1\`) while the ` +
        `big-verdict arm completed. The drain must be bounded and must observe ` +
        `'error'/'close', not wait on a callback a dead stream never fires.`,
    );
}

server.close();
rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✘ FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(EXPECT_BROKEN ? '\n✔ truncation reproduced on the unfixed bundle' : '\n✔ #62 gate PASSED');
