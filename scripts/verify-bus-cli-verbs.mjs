#!/usr/bin/env node
// #115 acceptance, driven against the BUILT dist-electron/cli.js under REAL
// ELECTRON — the runtime the packaged CLI actually has.
//
// WHY THIS EXISTS SEPARATELY FROM src/cli/bus-verbs.test.ts. The unit tests run
// under system node and call the verb functions in-process; they can prove the
// SEMANTICS (which lot a reader gets, who may ack) and nothing about the
// runtime. Two things are only observable here:
//
//   1. A bare `process.exit()` after an await does NOT terminate inside the
//      Electron main process (issue #59). The unit tests PASS on CLI code that
//      is broken this way, because plain node's process.exit is synchronous.
//   2. better-sqlite3 defers its native load to the first `new Database()`
//      (spike #109). Any ABI check that only require()s is a false pass by
//      construction, so every arm below CONSTRUCTS a database and reads a row
//      BACK out of it.
//
// ELECTRON_RUN_AS_NODE IS DELIBERATELY NOT SET for the arms that drive the CLI:
// that flag degrades Electron to plain node and would silently reintroduce the
// synchronous process.exit that HIDES defect (1). One arm sets it on purpose —
// T115.5's ABI arm — because that IS the packaged CLI's real configuration.
//
// Arms (each names the observation that would disprove it):
//   T115.1  concurrency: N CLI processes + a live app connection → no lost rows.
//           MUST-FAIL CONTROL: busy_timeout=0 on the same rig MUST lose rows.
//           A clean control means the rig created no contention and the passing
//           arm proved nothing.
//   T115.2  ack-replay across a SIGKILL: kill the consumer after `check`, before
//           `ack` → the next `check` returns the BYTE-IDENTICAL lot; after the
//           ack, only newer rows.
//   T115.3  app DOWN: `send` succeeds with nothing else holding the DB, and the
//           row is visible to a connection opened afterwards.
//   T115.4  `check` never acks (also unit-tested; asserted here through the real
//           binary, because that is the surface #117 will drive).
//   T115.5  runtime: the verbs work under real Electron, constructing a DB and
//           reading a row back; a SYSTEM-NODE launch against the Electron-ABI
//           binding fails LOUDLY with a diagnosable message, RC=1, no stack.
//   T115.6  `ask` does not block: it writes, prints an id and EXITS, measured on
//           the wall clock, far under the 600s Bash cap.
//
// Usage: node scripts/verify-bus-cli-verbs.mjs

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
const ELECTRON = path.join(ROOT, 'node_modules', '.bin', 'electron');

if (!fs.existsSync(CLI)) {
  console.error(`[rig] MISSING ${CLI} — run: pnpm run build:cli`);
  process.exit(1);
}
if (!fs.existsSync(ELECTRON)) {
  console.error(`[rig] MISSING ${ELECTRON} — run: pnpm install`);
  process.exit(1);
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-bus-cli-'));
const BUS = path.join(HOME, 'bus.sqlite');
process.on('exit', () => fs.rmSync(HOME, { recursive: true, force: true }));

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✔' : '✘'} ${name}\n    ${detail}`);
}

// ─── driving the CLI ────────────────────────────────────────────────────────

/**
 * Run the built CLI inside a real Electron main process, exactly as
 * `Orchestra.AppImage cli …` does (src/main/index.ts's dual-mode entry).
 *
 * Note `env` is built by SPREAD-then-override, and ORCHESTRA_HOME is set
 * explicitly on every call: the rig must never touch the developer's real
 * ~/.orchestra/bus.sqlite, and an inherited ORCHESTRA_HOME from the caller's
 * shell would silently point every arm at it.
 */
function runElectronCli(args, extraEnv = {}) {
  const mainJs = path.join(HOME, `main-${Math.random().toString(36).slice(2)}.cjs`);
  fs.writeFileSync(
    mainJs,
    `const { app } = require('electron');
     app.disableHardwareAcceleration();
     app.whenReady().then(async () => {
       const { runCli } = require(${JSON.stringify(CLI)});
       await runCli(${JSON.stringify(args)});
     });`,
  );
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(ELECTRON, [mainJs, '--no-sandbox'], {
      env: {
        ...process.env,
        ORCHESTRA_HOME: HOME,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr: `${stderr}\n[rig] TIMEOUT`, ms: Date.now() - started });
    }, 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

// Electron's own stderr is noisy (dbus, GPU, sandbox). Filter to lines the CLI
// could plausibly have written, so an assertion about OUR message is not
// satisfied — or defeated — by the host's chatter.
function cliStderr(r) {
  return r.stderr
    .split('\n')
    .filter((l) => !/^\[\d+:|libva|dbus|Gtk|MESA|Fontconfig|ERROR:.*gpu|Warning:|^\s*$/i.test(l))
    .join('\n');
}

/**
 * A FRESH, EMPTY bus for one arm.
 *
 * THE DEFECT THIS EXISTS FOR, found by running this script: every arm used to
 * share one ORCHESTRA_HOME, so T115.4's reader took a lot containing five
 * messages when the arm had sent two — earlier arms' rows, addressed to other
 * readers but on the same run, were in range. The replay assertion still held
 * (the code was fine), but "the second check returns the same lot" was being
 * asserted over a lot the arm did not control, and a count assertion over it
 * could only be written by reading off the answer. An arm whose subject
 * includes state from another arm measures neither.
 *
 * So each arm gets its own home, and the count in each arm is the number that
 * arm sent — a quantity written before the run, not read off it.
 */
function freshHome(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `orchestra-bus-${tag}-`));
  homes.push(dir);
  return dir;
}
const homes = [];
process.on('exit', () => {
  for (const d of homes) fs.rmSync(d, { recursive: true, force: true });
});

// Where the T115.1 contention arms put their DB. NOT os.tmpdir(): /tmp is tmpfs
// on this host (RAM, no real fsync), an easier and DIFFERENT experiment than the
// disk the bus actually lives on — the spike measured btrfs. Default to a
// scratch dir under the real ORCHESTRA_HOME's filesystem, falling back to tmpdir
// only if that path does not exist, and record the filesystem either way so a
// tmpfs run can never be silently mistaken for a disk one.
const contentionScratchParent = (() => {
  const homeRoot = process.env.ORCHESTRA_HOME_REAL || path.join(os.homedir(), '.orchestra');
  return fs.existsSync(homeRoot) ? homeRoot : os.tmpdir();
})();
const contentionFsType = (() => {
  try {
    return spawnSync('df', ['-T', contentionScratchParent], { encoding: 'utf8' })
      .stdout.trim().split('\n').pop().split(/\s+/)[1];
  } catch {
    return 'unknown';
  }
})();

// ─── artifact identity (never assert by path) ───────────────────────────────

const electronVersion = spawnSync(ELECTRON, ['--version'], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  encoding: 'utf8',
}).stdout.trim();
const cliBytes = fs.statSync(CLI).size;
const abiProbe = await runElectronCli(['--help']);
console.log(`\n[rig] electron        ${electronVersion}`);
console.log(`[rig] CLI bundle      ${CLI} (${cliBytes} bytes, mtime ${fs.statSync(CLI).mtime.toISOString()})`);
console.log(`[rig] ORCHESTRA_HOME  ${HOME}`);
console.log(`[rig] node (this rig) abi ${process.versions.modules}`);
// The bundle we are about to drive must actually CARRY the verbs. Grepping the
// artifact rather than the source: a stale dist-electron/cli.js would otherwise
// let every arm below run the PREVIOUS build and report a green about it.
const bundle = fs.readFileSync(CLI, 'utf8');
for (const verb of ['send', 'check', 'ack', 'ask', 'gate']) {
  if (!bundle.includes(`case "${verb}"`)) {
    console.error(`[rig] the built bundle has no \`case "${verb}"\` — it is STALE. Run: pnpm run build:cli`);
    process.exit(1);
  }
}
record(
  'ARTIFACT the bundle under test carries all five verbs and its --help runs under Electron',
  abiProbe.code === 0 && /orchestra send --type/.test(abiProbe.stdout),
  `RC=${abiProbe.code}, usage lists the bus verbs: ${/orchestra send --type/.test(abiProbe.stdout)}`,
);

// ─── T115.5 — runtime: construct a DB under real Electron, read the row back ─

{
  const home = freshHome('runtime');
  const send = await runElectronCli(
    ['send', '--type', 'dispatch', '--to', 'w1', '--as', 'ops', 'RUNTIME-PROBE'],
    { ORCHESTRA_HOME: home },
  );
  const seq = Number(send.stdout.trim());
  // READ THE ROW BACK, and read it back through a SEPARATE process — a send
  // that printed an id while writing nothing would satisfy any check that only
  // looked at stdout.
  const check = await runElectronCli(['check', '--as', 'w1'], { ORCHESTRA_HOME: home });
  let lot = null;
  try {
    lot = JSON.parse(check.stdout.trim());
  } catch {
    /* reported below */
  }
  record(
    'T115.5a real Electron: send CONSTRUCTS the DB and check reads the row back',
    send.code === 0 && Number.isInteger(seq) && seq > 0 && check.code === 0 &&
      !!lot && lot.count === 1 && lot.messages[0].body === 'RUNTIME-PROBE',
    `send RC=${send.code} seq=${seq}; check RC=${check.code} count=${lot?.count} body=${JSON.stringify(lot?.messages?.[0]?.body)}`,
  );
}

// ─── T115.5b — the must-FAIL arm: system node against the Electron ABI ──────
//
// This is the arm the ticket's Boundaries name. It is run with the per-ABI dev
// bindings HIDDEN, because bus-binding.ts pins build/bus-abi/…-abi127.node when
// it exists precisely so `pnpm run test` can construct a database — with it
// present, system node works and there is no mismatch to diagnose. Hiding it
// puts system node in front of the ELECTRON-ABI binding in node_modules, which
// is the configuration a human hits by running `node dist-electron/cli.js`.

{
  const abiHome = freshHome('abi');
  const abiDir = path.join(ROOT, 'build', 'bus-abi');
  const hidden = `${abiDir}.hidden-by-rig`;
  const hadAbiDir = fs.existsSync(abiDir);
  if (hadAbiDir) fs.renameSync(abiDir, hidden);
  let r;
  try {
    r = spawnSync(process.execPath, [CLI, 'send', '--type', 'status', '--as', 'nobody', 'x'], {
      env: { ...process.env, ORCHESTRA_HOME: abiHome },
      encoding: 'utf8',
    });
  } finally {
    // ALWAYS restore — a rig that leaves the tree mutated makes every later run,
    // mine or a sibling's, measure a state nobody chose.
    if (hadAbiDir) fs.renameSync(hidden, abiDir);
  }
  const err = r.stderr ?? '';
  const nodeAbi = process.versions.modules;
  const electronAbiBinding = /NODE_MODULE_VERSION 130/.test(err);
  const diagnosable =
    /ELECTRON_RUN_AS_NODE/.test(err) && /build:bus-abi/.test(err) && /cannot open/.test(err);
  const noStack = !/\n\s+at\s+\S+/.test(err);
  record(
    'T115.5b system node against the Electron-ABI binding fails LOUDLY (RC=1, diagnosable, no stack)',
    r.status === 1 && diagnosable && noStack && r.stdout.trim() === '',
    `RC=${r.status}, stdout=${JSON.stringify(r.stdout.trim())}, names ELECTRON_RUN_AS_NODE+build:bus-abi=${diagnosable}, ` +
      `carries the native NODE_MODULE_VERSION 130 evidence=${electronAbiBinding}, no stack frames=${noStack} (rig node abi ${nodeAbi})`,
  );
  // POSITIVE CONTROL for the arm above (carry-forward 4): with the dev binding
  // RESTORED, the very same command under the very same system node SUCCEEDS.
  // Without this, "RC=1 under node" could just mean the CLI is broken for
  // everyone, and the arm would prove nothing about the ABI.
  const ctl = spawnSync(process.execPath, [CLI, 'send', '--type', 'status', '--as', 'nodectl', 'ABI-CONTROL'], {
    env: { ...process.env, ORCHESTRA_HOME: abiHome },
    encoding: 'utf8',
  });
  record(
    'T115.5c CONTROL same command, same node, dev binding restored → RC=0 (so 5b measured the ABI, not a broken CLI)',
    hadAbiDir ? ctl.status === 0 && Number(ctl.stdout.trim()) > 0 : true,
    hadAbiDir
      ? `RC=${ctl.status}, seq=${ctl.stdout.trim()}`
      : 'SKIPPED — build/bus-abi/ absent (run pnpm run build:bus-abi); 5b is then UNCONTROLLED',
  );
  if (!hadAbiDir) {
    console.error('[rig] REFUSING a green: build/bus-abi/ is absent so T115.5b has no positive control.');
    process.exit(2);
  }
}

// ─── T115.6 — ask does not block ────────────────────────────────────────────

{
  const home = freshHome('ask');
  const r = await runElectronCli(['ask', '--to', 'ops', '--as', 'w1', 'may I proceed?'], {
    ORCHESTRA_HOME: home,
  });
  const seq = Number(r.stdout.trim());
  // The bound is wall-clock, and generous: the claim is "it does not WAIT", and
  // an Electron cold start is a few hundred ms. A verb that waited on an answer
  // would sit here until the rig's 60s SIGKILL (code -1).
  record(
    'T115.6 ask writes the row, prints its id and EXITS (no blocking wait)',
    r.code === 0 && Number.isInteger(seq) && seq > 0 && r.ms < 30_000,
    `RC=${r.code}, printed id=${seq}, wall clock ${r.ms}ms (Bash cap is 600000ms)`,
  );
  const back = await runElectronCli(['check', '--as', 'ops'], { ORCHESTRA_HOME: home });
  const lot = JSON.parse(back.stdout.trim());
  const q = lot.messages.find((m) => m.sequence === seq);
  record(
    'T115.6b the ask actually LANDED as a question row addressed to the target',
    !!q && q.kind === 'question' && q.recipient === 'ops' && q.body === 'may I proceed?',
    `kind=${q?.kind}, recipient=${q?.recipient}, body=${JSON.stringify(q?.body)}`,
  );
}

// ─── T115.4 — check never acks, through the real binary ─────────────────────

{
  const home = freshHome('noack');
  const E = { ORCHESTRA_HOME: home };
  // TWO messages, a number written down BEFORE the run — not read off the lot.
  await runElectronCli(['send', '--type', 'dispatch', '--to', 'r4', '--as', 'ops', 'NOACK-1'], E);
  await runElectronCli(['send', '--type', 'dispatch', '--to', 'r4', '--as', 'ops', 'NOACK-2'], E);
  const a = JSON.parse((await runElectronCli(['check', '--as', 'r4'], E)).stdout.trim());
  const b = JSON.parse((await runElectronCli(['check', '--as', 'r4'], E)).stdout.trim());
  record(
    'T115.4 a plain check does NOT ack: the second check replays the same lot, same ids',
    a.count === 2 && a.replay === false && b.replay === true &&
      JSON.stringify(b.messages) === JSON.stringify(a.messages) && b.lot === a.lot,
    `first: lot=${a.lot} count=${a.count} replay=${a.replay}; second: lot=${b.lot} count=${b.count} replay=${b.replay}, ` +
      `messages byte-identical=${JSON.stringify(b.messages) === JSON.stringify(a.messages)}`,
  );
  const acked = await runElectronCli(['ack', String(a.lot), '--as', 'r4'], E);
  const c = JSON.parse((await runElectronCli(['check', '--as', 'r4'], E)).stdout.trim());
  record(
    'T115.4b after the reader acks, the lot is gone (so the replay above was not just "check is broken")',
    acked.code === 0 && c.count === 0 && c.lot === null,
    `ack RC=${acked.code}; next check count=${c.count} lot=${c.lot}`,
  );
}

// ─── T115.2 — ack-replay across a SIGKILL ───────────────────────────────────
//
// The consumer is SIGKILLed after its `check` and before any `ack` — the
// scenario the unique partial index on `deliveries` exists for.
//
// THE KILL IS ON THE REAL CLI PROCESS, MID-FLIGHT. Two designs were tried and
// rejected, and both failures are worth recording because each looked correct:
//
//   (a) Kill the CLI after it exits. That leaves the same DB state, so the arm
//       would pass — but it would be asserting over "nobody acked", not over a
//       crash, and would go green on a rig that never opened the window at all.
//   (b) Shadow `process.exit` inside an Electron holder so the child parks with
//       the lot outstanding. It WEDGED: runCli ends in exitAfterFlush(), which
//       awaits a stream flush and then calls process.exit — neutered, so the
//       await never settles, runCli never returns, and the lot never reaches
//       stdout. A rig that hangs is at least honest; a rig that hung and were
//       given a shorter timeout would have reported "no lot" as a code defect.
//
// So: spawn the real CLI `check`, wait for its lot to arrive on stdout (bounded
// wait-until-or-fail, never sleep-then-read), and SIGKILL it THERE — before it
// has exited, which the arm asserts rather than assumes. The window between the
// relève's COMMIT and the process's exit is exactly where a real consumer dies.

{
  const home = freshHome('crash');
  const E = { ORCHESTRA_HOME: home };
  await runElectronCli(['send', '--type', 'dispatch', '--to', 'crashy', '--as', 'ops', 'CRASH-1'], E);
  await runElectronCli(['send', '--type', 'dispatch', '--to', 'crashy', '--as', 'ops', 'CRASH-2'], E);

  const mainJs = path.join(home, 'consumer.cjs');
  fs.writeFileSync(
    mainJs,
    `const { app } = require('electron');
     app.disableHardwareAcceleration();
     app.whenReady().then(async () => {
       const { runCli } = require(${JSON.stringify(CLI)});
       await runCli(['check', '--as', 'crashy']);
     });`,
  );
  const consumer = spawn(ELECTRON, [mainJs, '--no-sandbox'], {
    env: { ...process.env, ORCHESTRA_HOME: home, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  consumer.stdout.on('data', (d) => (out += d));
  consumer.stderr.on('data', (d) => (err += d));

  const parseLot = (text) => {
    const i = text.indexOf('{');
    if (i < 0) return null;
    try {
      return JSON.parse(text.slice(i, text.lastIndexOf('}') + 1));
    } catch {
      return null;
    }
  };
  const deadline = Date.now() + 60_000;
  let killedLot = null;
  let aliveAtKill = false;
  while (Date.now() < deadline) {
    killedLot = parseLot(out);
    if (killedLot) {
      // Kill IMMEDIATELY, in the same tick the lot became readable — the
      // process is still winding down its flush-and-exit, so this lands in the
      // window the acceptance names.
      aliveAtKill = consumer.exitCode === null && consumer.signalCode === null;
      consumer.kill('SIGKILL');
      break;
    }
    if (consumer.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 5));
  }
  consumer.kill('SIGKILL');
  const [, killSignal] = await new Promise((r) =>
    consumer.on('close', (c, sig) => r([c, sig])),
  );

  const after = JSON.parse((await runElectronCli(['check', '--as', 'crashy'], E)).stdout.trim());
  record(
    'T115.2 consumer SIGKILLed after check, before ack → the next check returns the BYTE-IDENTICAL lot',
    !!killedLot && killedLot.count === 2 && aliveAtKill && killSignal === 'SIGKILL' &&
      after.lot === killedLot.lot &&
      JSON.stringify(after.messages) === JSON.stringify(killedLot.messages) &&
      after.replay === true,
    `killed consumer held lot=${killedLot?.lot} count=${killedLot?.count}; it was STILL RUNNING when we signalled: ` +
      `${aliveAtKill}, and died BY ${killSignal} (not a clean exit); after the kill: lot=${after.lot} ` +
      `count=${after.count} replay=${after.replay}, ` +
      `messages byte-identical=${JSON.stringify(after.messages) === JSON.stringify(killedLot?.messages)}` +
      (killedLot ? '' : ` | consumer stderr: ${err.slice(-300)}`),
  );
  // …and after the ack, ONLY NEWER rows. Without this half, "the same lot
  // forever" — a check that could never advance — would also pass the arm above.
  await runElectronCli(['ack', String(after.lot), '--as', 'crashy'], E);
  await runElectronCli(['send', '--type', 'dispatch', '--to', 'crashy', '--as', 'ops', 'CRASH-3'], E);
  const fresh = JSON.parse((await runElectronCli(['check', '--as', 'crashy'], E)).stdout.trim());
  record(
    'T115.2b after the ack, check returns ONLY newer rows',
    fresh.count === 1 && fresh.messages[0]?.body === 'CRASH-3' && fresh.lot !== after.lot,
    `count=${fresh.count}, bodies=${JSON.stringify(fresh.messages.map((m) => m.body))}, lot=${fresh.lot} (was ${after.lot})`,
  );
}

// ─── T115.3 — app DOWN ──────────────────────────────────────────────────────
//
// The whole reason these verbs bypass the socket (#108 Q2). The assertion is
// deliberately in two halves: `send` SUCCEEDS with nothing else attached, and a
// connection opened AFTERWARDS — the "app restarted" side — sees the row. The
// socket is explicitly pointed at a path that does not exist, so any accidental
// route through the app would fail rather than silently work.

{
  const downHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-bus-down-'));
  try {
    const send = await runElectronCli(
      ['send', '--type', 'escalation', '--as', 'lonely', 'APP-WAS-DOWN'],
      { ORCHESTRA_HOME: downHome, ORCHESTRA_SOCK: path.join(downHome, 'no-such.sock') },
    );
    const dbExisted = fs.existsSync(path.join(downHome, 'bus.sqlite'));
    // A SEPARATE process opened after the fact = the app coming back up.
    const back = await runElectronCli(['check', '--as', 'reader'], {
      ORCHESTRA_HOME: downHome,
      ORCHESTRA_SOCK: path.join(downHome, 'no-such.sock'),
    });
    const lot = JSON.parse(back.stdout.trim());
    record(
      'T115.3 with no app running (and a dead socket) send SUCCEEDS and the row is visible afterwards',
      send.code === 0 && Number(send.stdout.trim()) > 0 && dbExisted &&
        lot.count === 1 && lot.messages[0].body === 'APP-WAS-DOWN',
      `send RC=${send.code} seq=${send.stdout.trim()}, bus.sqlite created=${dbExisted}, ` +
        `post-restart check count=${lot.count} body=${JSON.stringify(lot.messages[0]?.body)}`,
    );
  } finally {
    fs.rmSync(downHome, { recursive: true, force: true });
  }
}

// ─── T115.1 — concurrency + its must-FAIL control ───────────────────────────
//
// N concurrent short-lived processes writing the same WAL database at once,
// through the SHIPPED open()+send() from src/main/bus.ts — the exact write path
// `orchestra send` reaches (index.ts's openBusForVerb() → bus.openBus() →
// bus.send()) — with a long-lived reader attached throughout. Spike #109 arm 1's
// shape, driven under ELECTRON_RUN_AS_NODE (ABI 130), which IS the packaged
// CLI's runtime (spike condition 5: the AppImage's `cli` mode is Electron-as-node).
//
// THE CONTROL IS THE POINT. `busy_timeout=0` on the same rig MUST lose rows; the
// spike measured 7-27% loss, and this rig measures ~21% on btrfs. A control that
// comes back clean means the rig never created contention, and the passing arm
// above it proved nothing — so a clean control FAILS this script.
//
// RUNTIME OF THIS ARM: plain node (ABI 127), the SAME choice the accepted
// scripts/verify-bus-contention.mjs (#114) makes, and for the same reason —
// Electron 33's bundled Node rejects --experimental-strip-types both as a CLI
// flag and in NODE_OPTIONS (measured), so a .ts writer cannot run under
// ELECTRON_RUN_AS_NODE without a separate transpile step. The contention
// guarantee under test is a SQLite-level property (WAL + busy_timeout, set in
// open()) and is independent of the JS ABI: the same open()+send() bytes run
// under either. The packaged ABI-130 runtime is proven SEPARATELY and directly
// by T115.5a/b/c (a real Electron `orchestra send` constructs the DB, reads the
// row back, and system-node-vs-Electron-ABI fails loudly). The .cjs reader and
// count probes pin the per-ABI binding for whatever runtime they run under.
//
// WHY THE WRITER DRIVES bus.send() AND NOT runCli(), AND THE THREE WAYS I FOUND
// THE ALTERNATIVES DEAD (each recorded so nobody re-derives them):
//
// (1) `electron dist-electron/cli.js send …` under ELECTRON_RUN_AS_NODE is a
//     SILENT NO-OP — RC 0, no output, no row. The bundle's auto-run block is
//     guarded on `!process.versions.electron`, and that global is still set
//     under ELECTRON_RUN_AS_NODE. The packaged app reaches the CLI through
//     src/main/index.ts, which imports the bundle and calls runCli() explicitly.
//
// (2) One PROCESS PER runCli() send does not contend. An Electron start is
//     ~150ms and the write itself is microseconds, so two writers essentially
//     never overlap inside a transaction — measured 150/150 on BOTH arms
//     including the busy_timeout=0 control that is supposed to lose rows.
//
// (3) Looping runCli() back-to-back inside ONE process to force overlap is
//     IMPOSSIBLE against the real binary. runCli() ends in exitAfterFlush(),
//     which awaits a stdout drain and then calls process.exit(code). To let the
//     loop continue you must neutralise process.exit — but exitAfterFlush is
//     `Promise<never>` and its ONLY resolution after the drain is that same
//     (now-neutralised) process.exit, plus a fallback setTimeout(process.exit).
//     So `await runCli(...)` NEVER SETTLES once exit is stubbed: the loop hangs
//     on iteration 0. Measured: 10 writers each landed exactly their first send
//     (10 rows) then hung, so BOTH arms read 10/1000 and the "control" passed
//     vacuously. (Proven with a probe: BEFORE runCli → `1` printed →
//     process.exit(0) neutered → 5s later still alive, await never resolved.)
//
// The concurrency guarantee under test is a property of open()'s WAL+busy_timeout
// and send()'s INSERT — bus.ts, reached IDENTICALLY whether via runCli's argv
// shell or a direct send(). The argv/exit shell contributes nothing to the
// SQLite contention behaviour, and is proven separately by T115.5a (a real
// Electron `orchestra send` constructs the DB and `check` reads the row back).
// So T115.1 drives the shipped write path directly, which is the only way to
// create genuine overlap — the same choice scripts/verify-bus-contention.mjs
// makes and the same one #114 accepted. (SEAM NOTE for OPS-B2: if the ticket
// intends the argv shell itself to be under concurrent load, that needs a
// different rig; §Open-questions.)

/**
 * One arm of T115.1: `writers` concurrent processes, each issuing `inserts`
 * SHIPPED send() calls on its own connection, with a long-lived reader attached.
 * The writer reports how many sends it believes it committed (`claimed`); the
 * arm compares that against what the DATABASE actually holds — a writer that
 * believes it committed a row it lost is the failure mode this arm is about.
 */
async function contentionArm(busyTimeoutMs, writers, inserts, tag) {
  // NOT os.tmpdir(): /tmp is tmpfs (RAM, no real fsync) — an easier and
  // different experiment than the btrfs disk the bus lives on. Use a scratch dir
  // on the real filesystem, and print which filesystem so a tmpfs run can never
  // be mistaken for a disk one.
  const home = fs.mkdtempSync(path.join(contentionScratchParent, `orchestra-bus-cont-${tag}-`));
  homes.push(home);
  const file = path.join(home, 'bus.sqlite');
  const busTs = path.join(ROOT, 'src', 'main', 'bus.ts');
  const bs3 = path.join(ROOT, 'node_modules', 'better-sqlite3');

  // The writer imports the SHIPPED open()+send() — never a hand-written INSERT
  // or a copy of open()'s pragmas. A rig that re-implements its subject measures
  // the re-implementation: the canonical contention rig was once green with
  // open()'s busy_timeout line DELETED because its writer hand-rolled the pragmas.
  const writerTs = path.join(home, 'writer.ts');
  fs.writeFileSync(
    writerTs,
    `import { open, send } from ${JSON.stringify(busTs)};
     const who = process.argv[2];
     const n = Number(process.argv[3]);
     const busyTimeoutMs = Number(process.argv[4]);
     // THE SHIPPED open(). Delete its busy_timeout line and this arm loses rows.
     const db = open(${JSON.stringify(file)}, { busyTimeoutMs });
     let claimed = 0, busy = 0, refused = 0;
     for (let i = 0; i < n; i++) {
       try {
         // THE SHIPPED send(), returning the sequence it assigned.
         const seq = send(db, { runId: 'contention', sender: who, kind: 'dispatch', body: who + ':' + i });
         if (Number(seq) > 0) claimed++; else refused++;
       } catch (e) {
         if (String(e.code || e.message).includes('SQLITE_BUSY')) busy++;
         refused++;
       }
     }
     db.close();
     process.stdout.write(JSON.stringify({ who, claimed, busy, refused }));`,
  );

  // Seed the schema through the SHIPPED openBus() with ONE process, so the
  // writers race each other rather than the migration — busy_timeout is the only
  // variable under test.
  const seedTs = path.join(home, 'seed.ts');
  fs.writeFileSync(
    seedTs,
    `import { openBus } from ${JSON.stringify(busTs)};\n` +
      `const db = openBus(${JSON.stringify(file)});\ndb.close();\n`,
  );
  const seed = spawnSync(process.execPath, ['--experimental-strip-types', seedTs], {
    env: { ...process.env, ORCHESTRA_HOME: home },
    encoding: 'utf8',
  });
  if (seed.status !== 0 || !fs.existsSync(file)) {
    console.error(`[rig] contention seed FAILED (RC=${seed.status}) stdout=${JSON.stringify(seed.stdout)} stderr=${seed.stderr.slice(0, 400)}`);
    process.exit(1);
  }

  // A long-lived reader attached for the whole arm — WAL's promise is that
  // readers never block writers, and without one this would be writers only.
  // It pins the per-ABI binding for the runtime it runs under (ABI 130 here).
  const readerJs = path.join(home, 'reader.cjs');
  fs.writeFileSync(
    readerJs,
    `const path = require('path');
     const Database = require(${JSON.stringify(bs3)});
     const binding = path.join(${JSON.stringify(ROOT)}, 'build', 'bus-abi', 'better_sqlite3-abi' + process.versions.modules + '.node');
     const db = new Database(${JSON.stringify(file)}, { readonly: true, nativeBinding: binding });
     db.pragma('busy_timeout = 5000');
     let reads = 0, stop = false;
     process.on('SIGTERM', () => { stop = true; });
     const q = db.prepare("SELECT COUNT(*) c FROM messages WHERE run_id='contention'");
     (function loop() {
       if (stop) { process.stdout.write(String(reads)); process.exit(0); }
       try { q.get(); reads++; } catch {}
       setImmediate(loop);
     })();`,
  );
  const reader = spawn(process.execPath, [readerJs], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let readerReads = '';
  reader.stdout.on('data', (d) => (readerReads += d));
  await new Promise((r) => setTimeout(r, 300));

  // Launch every writer at once. Spawning them in a loop with an await between
  // would serialise the very thing under test.
  const per = await Promise.all(
    Array.from({ length: writers }, (_, w) =>
      new Promise((resolve) => {
        const c = spawn(process.execPath, ['--experimental-strip-types', writerTs, `w${w}`, String(inserts), String(busyTimeoutMs)], {
          env: { ...process.env, ORCHESTRA_HOME: home },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let o = '';
        let e = '';
        c.stdout.on('data', (d) => (o += d));
        c.stderr.on('data', (d) => (e += d));
        // Await EXIT, not just the stdout chunk: reading a child's buffer in the
        // same tick as its death yields an empty string that reads as "nothing
        // happened".
        c.on('exit', () => {
          try {
            resolve(JSON.parse(o.slice(o.lastIndexOf('{'))));
          } catch {
            resolve({ who: `w${w}`, claimed: 0, busy: 0, refused: inserts, parseFail: o.slice(-200), stderr: e.slice(-300) });
          }
        });
      }),
    ),
  );
  reader.kill('SIGTERM');
  await new Promise((r) => reader.on('close', r));

  // THE COUNT COMES FROM THE DATABASE, never from the writers' self-reports.
  const countOut = spawnSync(process.execPath, ['-e', `
     const path = require('path');
     const Database = require(${JSON.stringify(bs3)});
     const binding = path.join(${JSON.stringify(ROOT)}, 'build', 'bus-abi', 'better_sqlite3-abi' + process.versions.modules + '.node');
     const db = new Database(${JSON.stringify(file)}, { readonly: true, nativeBinding: binding });
     db.pragma('busy_timeout = 5000');
     process.stdout.write(String(db.prepare("SELECT COUNT(*) c FROM messages WHERE run_id='contention' AND sender LIKE 'w%'").get().c));
   `], { env: { ...process.env }, encoding: 'utf8' });
  // NaN, not 0, when the probe itself failed — 0 would read as "every insert was
  // lost", a plausible-looking verdict from an instrument that never ran.
  const inDb = countOut.status === 0 ? Number(countOut.stdout.trim()) : NaN;
  if (!Number.isFinite(inDb)) {
    console.error(`[rig] the row-count probe FAILED (RC=${countOut.status}): ${countOut.stderr.slice(0, 400)}`);
    process.exit(1);
  }
  return {
    inDb,
    expected: writers * inserts,
    claimed: per.reduce((a, p) => a + (p.claimed ?? 0), 0),
    busy: per.reduce((a, p) => a + (p.busy ?? 0), 0),
    refused: per.reduce((a, p) => a + (p.refused ?? 0), 0),
    readerReads: Number(readerReads.trim()) || 0,
    per,
  };
}

{
  const WRITERS = 10;
  const INSERTS = 100;
  console.log(`\n[rig] T115.1 contention on ${contentionFsType} (writers run shipped open()+send() under node abi ${process.versions.modules}; packaged ABI 130 proven separately by T115.5)`);
  if (contentionFsType === 'tmpfs') {
    console.log('[rig] WARNING: contention scratch is on TMPFS (RAM) — easier than the real disk the bus lives on.');
  }
  const pass = await contentionArm(5000, WRITERS, INSERTS, 'pass');
  record(
    `T115.1 ${WRITERS} concurrent writers x ${INSERTS} shipped sends + a live reader → NO lost rows`,
    pass.inDb === pass.expected && pass.busy === 0 && pass.refused === 0 && pass.readerReads > 0,
    `rows in DB ${pass.inDb}/${pass.expected}, SQLITE_BUSY ${pass.busy}, refused ${pass.refused}, ` +
      `the concurrent reader completed ${pass.readerReads} reads`,
  );
  // THE CONTROL IS THE POINT. Same rig, same shipped send(), busy_timeout=0.
  // The spike measured 7-27% loss; this rig measures ~21% on btrfs. If this
  // comes back CLEAN the rig created no contention and the arm above proved
  // nothing — so a clean control FAILS.
  const ctl = await contentionArm(0, WRITERS, INSERTS, 'ctl');
  const lost = ctl.expected - ctl.inDb;
  record(
    'T115.1b MUST-FAIL CONTROL busy_timeout=0 on the same rig LOSES rows (a clean control = no contention = the arm above proved nothing)',
    lost > 0,
    `rows in DB ${ctl.inDb}/${ctl.expected} → LOST ${lost} (${((lost / ctl.expected) * 100).toFixed(1)}%), ` +
      `SQLITE_BUSY ${ctl.busy}, the write path REFUSED ${ctl.refused} of them`,
  );
  // The loss must be REFUSED, not silently reported as success: send() must
  // never return a positive sequence for a row it did not land.
  record(
    'T115.1c send() never claimed a row it did not land (claimed == rows in DB on both arms)',
    ctl.claimed === ctl.inDb && pass.claimed === pass.inDb,
    `control: claimed ${ctl.claimed} vs DB ${ctl.inDb}; must-pass arm: claimed ${pass.claimed} vs DB ${pass.inDb}`,
  );
}

// ─── verdict ────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n[rig] ${results.length - failed.length}/${results.length} arms passed`);
if (failed.length) {
  console.log('[rig] FAILED ARMS:');
  for (const f of failed) console.log(`  ✘ ${f.name}\n      ${f.detail}`);
  console.log('verify-bus-cli-verbs: FAIL');
  process.exit(1);
}
console.log('verify-bus-cli-verbs: OK');
