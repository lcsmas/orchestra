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

/**
 * Display env for every Electron we spawn.
 *
 * CONTAINMENT (ledger #70 LEAD order). This rig spawns many Electron processes
 * and would otherwise inherit the HUMAN'S real WAYLAND_DISPLAY/DISPLAY. Nothing
 * on the CLI path opens a window, but "it happens not to" is luck, not
 * containment.
 *
 * FAIL-CLOSED ON A MISSING RIG (issue #76). The previous version silently fell
 * back to blanking both display handles when `RIG_WAYLAND` was absent. That is
 * the defect this block now exists to prevent, and it is worse than a crash:
 * a display-less Electron dies on "Missing X server or $DISPLAY" and exits at
 * ZERO BYTES, which this gate then scores as TRUNCATION — i.e. running the
 * script bare FABRICATES a failure shaped exactly like issue #62, the very bug
 * under test. Wave-6's verifier hit this for real and read `TRUNCATED 20/20`,
 * `HUNG 6/6`, RC=1; it correctly diagnosed its own rig rather than the product,
 * but a naive CI invocation would have "reproduced" #62 forever.
 *
 * A generic non-zero exit is NOT sufficient here — the whole defect is that the
 * failure LOOKS like the bug. So the precondition is checked BEFORE any Electron
 * is spawned and reported by NAME, saying which precondition is unmet and the
 * exact command that satisfies it.
 *
 * `RIG_WAYLAND` is set only by scripts/e2e-contained-rig.sh, so its presence is
 * the discriminator — and it is compared against WAYLAND_DISPLAY so a stale
 * export cannot silently re-enable the human's compositor.
 */
const RIG_PRECONDITION_RC = 3;

/** Exit with a NAMED precondition failure: what is unmet, and how to satisfy it.
 *  Distinct RC so a caller can tell "rig not provisioned" from "gate failed". */
function diePrecondition(what, detail) {
  console.error(`\n\u2718 PRECONDITION NOT MET: ${what}`);
  console.error(`  ${detail}`);
  console.error('');
  console.error('  This gate spawns Electron and MUST run inside the contained rig,');
  console.error('  which creates its own headless sway, verifies it with a unique');
  console.error('  marker, and exports RIG_WAYLAND. Run it as:');
  console.error('');
  console.error('      scripts/e2e-contained-rig.sh pnpm run test:cli-pipe');
  console.error('');
  console.error('  Refusing to run bare: a display-less Electron exits at 0 bytes,');
  console.error('  which this gate would score as TRUNCATION — a FABRICATED failure');
  console.error('  shaped exactly like issue #62, the bug under test. (issue #76)');
  process.exit(RIG_PRECONDITION_RC);
}

const RIG_WAYLAND = process.env.RIG_WAYLAND;
const WAYLAND_DISPLAY = process.env.WAYLAND_DISPLAY;

if (!RIG_WAYLAND) {
  diePrecondition(
    'RIG_WAYLAND is not set — this gate is not running inside the contained rig.',
    `WAYLAND_DISPLAY=${WAYLAND_DISPLAY ? `'${WAYLAND_DISPLAY}'` : '<unset>'}, RIG_WAYLAND=<unset>.`,
  );
}
if (RIG_WAYLAND !== WAYLAND_DISPLAY) {
  diePrecondition(
    `RIG_WAYLAND='${RIG_WAYLAND}' does not match WAYLAND_DISPLAY=${WAYLAND_DISPLAY ? `'${WAYLAND_DISPLAY}'` : '<unset>'}.`,
    'A stale RIG_WAYLAND export is present without the compositor it names.',
  );
}
if (RIG_WAYLAND === 'wayland-1') {
  diePrecondition(
    "RIG_WAYLAND='wayland-1' is the HUMAN'S real compositor.",
    'Refusing to launch: test windows must never reach the human\'s screen.',
  );
}

const CONTAINED_DISPLAY_ENV = {
  WAYLAND_DISPLAY: RIG_WAYLAND,
  ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
  ORCHESTRA_OZONE_RELAUNCHED: '1',
};

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
        //
        // Blanking both display handles is what makes a window unable to reach
        // the human's screen. But blanking them ALONE makes Electron abort with
        // "Missing X server or $DISPLAY" before it runs a line of our code, and
        // a 0-byte exit reads to this gate as truncation — a FABRICATED failure
        // (issue #62 NEW-3). The ozone hint is what lets a display-less Electron
        // still boot for a headless/CLI run, so it is load-bearing for the gate
        // being runnable at all, not cosmetic.
        //
        // For a rig that must actually PAINT, use the wave's reference
        // implementation instead (scripts/e2e-contained-rig.sh on impl-64):
        // it stands up its own sway and proves ownership with a unique marker.
        // This gate never opens a window, so display-less + the hint is enough.
        ...CONTAINED_DISPLAY_ENV,
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
let silentTruncation = 0;
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
  // ASSERT 3, with a LIVE subject: this is the arm that actually truncates on a
  // broken build (master: 7/12), so the pair is reachable here and the check is
  // not merely guarding an absent bug.
  if (isTrunc && r.code === 2) silentTruncation += 1;
  if (!isTrunc && text !== EXPECTED) inexact += 1;
  marks.push(isTrunc ? `${bytes}${isPrefix ? 'T' : 'X'}` : `${bytes}.`);
}
console.log(
  `big verdict  TRUNCATED ${truncated}/${RUNS}   RC!=2 ${badCode}/${RUNS}   ` +
    `short-but-NOT-a-prefix ${notAPrefix}/${RUNS}   silent-truncation(RC=2) ${silentTruncation}/${RUNS}`,
);
// Reported in BOTH modes. In --expect-broken this is EXPECTED (that is the very
// shape of the #62 defect and of a8baa2a's regression), so it is informational
// there and only an error on a build claiming to be fixed.
if (!EXPECT_BROKEN && silentTruncation !== 0)
  failures.push(
    `SILENT TRUNCATION: ${silentTruncation}/${RUNS} big-verdict runs delivered an INCOMPLETE ` +
      `verdict while exiting RC=2 (the success code). Truncation must never carry a success status.`,
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
  // Chromium writes its own diagnostics to stderr (dbus/GPU/ozone), and in an
  // isolated rig with no session bus that is guaranteed noise, not our output.
  // Filter to lines that are NOT Chromium's, so this control still catches what
  // it exists to catch — the CLI leaking onto the stream a caller parses — and
  // does not merely measure the sandbox. It stays a REAL check: an
  // UnhandledPromiseRejectionWarning, a stack trace, or any verdict text on
  // stderr survives this filter (that leak is exactly what it caught once).
  const CHROMIUM_NOISE = /^\[\d+:\d{4}\/\d{6}\.\d+:(ERROR|WARNING|INFO|VERBOSE\d*):/;
  const ourStderr = r.stderr
    .split('\n')
    .filter((l) => l.trim() !== '' && !CHROMIUM_NOISE.test(l))
    .join('\n');
  const quiet = ourStderr === '';
  console.log(`CONTROL stderr quiet on big verdict: ${quiet}`);
  if (!quiet && !EXPECT_BROKEN)
    failures.push(
      `stderr not empty on the big verdict (Chromium diagnostics excluded): ` +
        `${JSON.stringify(ourStderr.slice(0, 300))}`,
    );
}

// --- SLOW BUT LIVE READER must NOT be truncated (issue #62 NEW-1) ----------
// The counterpart to the broken-pipe arm, and it pulls the OPPOSITE way: a
// reader that is alive and consuming, just slowly. A drain bounded on a fixed
// wall-clock cannot serve both — a slow reader and a dead reader look identical
// to a timer — so a 2000 ms bound truncated this 4/4 at 146496 bytes with RC=2,
// i.e. #62's exact defect wearing a success status. This arm is what makes that
// regression loud. It must be SLOWER than any fixed bound anyone might
// reintroduce, hence 2500 ms/chunk against the 2000 ms bound that failed.
reply = { ok: true, id: 'x', branch: 'child', target: 'main', unmerged: N, commits };
{
  const SLOW_RUNS = Math.min(RUNS, 3);
  const MS_PER_CHUNK = 2500;
  let slowTruncated = 0;
  let slowSilentTruncation = 0;
  const slowMarks = [];
  for (let i = 0; i < SLOW_RUNS; i += 1) {
    const f = path.join(tmp, `slow-${i}.cjs`);
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
          ...CONTAINED_DISPLAY_ENV,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks = [];
      // ALIVE, but unhurried: pause after each chunk and resume later. The
      // reader never goes away, so nothing here justifies giving up on it.
      c.stdout.on('data', (d) => {
        chunks.push(d);
        c.stdout.pause();
        setTimeout(() => c.stdout.resume(), MS_PER_CHUNK);
      });
      c.stderr.on('data', () => {});
      const timer = setTimeout(() => {
        c.kill('SIGKILL');
        resolve({ buf: Buffer.concat(chunks), ms: Date.now() - t0, code: -1 });
      }, 180_000);
      c.on('close', (code) => {
        clearTimeout(timer);
        resolve({ buf: Buffer.concat(chunks), ms: Date.now() - t0, code });
      });
    });
    const short = r.buf.length < EXPECTED_BYTES;
    if (short) slowTruncated += 1;
    // ASSERT 3: a TRUNCATED verdict must never carry the SUCCESS status.
    // `code` was captured here and never tested until now — which is exactly
    // how a8baa2a shipped green while truncating 4/4 at 146496 bytes with
    // RC=2, through a gate that already had an arm pointed at this arm's
    // subject. Our own close-out consumes these verdicts: a short commit list
    // that exits 2 reads as authoritative and is acted on.
    if (short && r.code === 2) slowSilentTruncation += 1;
    slowMarks.push(`${r.buf.length}${short ? 'T' : '.'}/RC=${r.code}/${r.ms}ms`);
  }
  console.log(
    `CONTROL slow live reader (@${MS_PER_CHUNK}ms/chunk)  TRUNCATED ${slowTruncated}/${SLOW_RUNS}   ` +
      `silent-truncation(RC=2) ${slowSilentTruncation}/${SLOW_RUNS}   ${slowMarks.join(' ')}`,
  );
  // Asserted in BOTH modes and independently of the truncation count above: a
  // build may legitimately truncate a dead reader, but a truncated verdict that
  // reports SUCCESS is never acceptable, because nothing downstream can detect it.
  if (slowSilentTruncation !== 0)
    failures.push(
      `SILENT TRUNCATION: ${slowSilentTruncation}/${SLOW_RUNS} slow-reader runs delivered an ` +
        `INCOMPLETE verdict while exiting RC=2 (the success code). A truncated commit list must ` +
        `carry a failure status — a short list that looks authoritative is acted on.`,
    );
  // Asserted in BOTH modes. Truncating a LIVE reader is never acceptable: the
  // verdict exits 2 looking successful while the commit list is incomplete,
  // which is strictly worse than hanging (a hang is visible).
  if (slowTruncated !== 0)
    failures.push(
      `slow-reader truncation: ${slowTruncated}/${SLOW_RUNS} runs cut off a reader that was ` +
        `ALIVE and consuming at ${MS_PER_CHUNK}ms/chunk. A fixed wall-clock flush bound does ` +
        `this; bound on PROGRESS ('drain'), not elapsed time, so a slow reader keeps extending ` +
        `the deadline while a dead one does not.`,
    );
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
        //
        // Blanking both display handles is what makes a window unable to reach
        // the human's screen. But blanking them ALONE makes Electron abort with
        // "Missing X server or $DISPLAY" before it runs a line of our code, and
        // a 0-byte exit reads to this gate as truncation — a FABRICATED failure
        // (issue #62 NEW-3). The ozone hint is what lets a display-less Electron
        // still boot for a headless/CLI run, so it is load-bearing for the gate
        // being runnable at all, not cosmetic.
        //
        // For a rig that must actually PAINT, use the wave's reference
        // implementation instead (scripts/e2e-contained-rig.sh on impl-64):
        // it stands up its own sway and proves ownership with a unique marker.
        // This gate never opens a window, so display-less + the hint is enough.
        ...CONTAINED_DISPLAY_ENV,
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
  // ZERO HANGS REQUIRED (LEAD ruling, ledger #70).
  //
  // An earlier version of this gate failed only on a TOTAL hang, on the belief
  // that the rate was machine noise rather than a property of the build. That
  // belief came from UNCONTAINED runs; under proper containment the axis is
  // clean and the separation is large:
  //
  //     master 2ebd3fb              HUNG  9/12
  //     drain w/ late listeners     HUNG  5/5   (and 12/12 on another rig)
  //     drain w/ startup listeners  HUNG  0/12  RC=2 in ~280ms every run
  //
  // The mechanism is in exitAfterFlush's docblock: EPIPE is delivered AS the
  // write happens, so listeners attached later wait for an event that already
  // fired. Anything above zero here means that regressed.
  if (hung !== 0)
    failures.push(
      `broken-pipe hang: ${hung}/${HANG_RUNS} runs did not terminate when the reader closed ` +
        `early (\`orchestra verify-landed | head -1\`). Required: 0/${HANG_RUNS}. The ` +
        `stdout/stderr hang-up listeners must be installed at STARTUP — attaching them inside ` +
        `the drain is too late, the EPIPE has already fired (master: 9/12, late listeners: ` +
        `5/5, startup listeners: 0/12).`,
    );
}

server.close();
rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`\n✘ FAILED:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(EXPECT_BROKEN ? '\n✔ truncation reproduced on the unfixed bundle' : '\n✔ #62 gate PASSED');
