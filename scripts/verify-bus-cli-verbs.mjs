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
  const send = await runElectronCli(['send', '--type', 'dispatch', '--to', 'w1', '--as', 'ops', 'RUNTIME-PROBE']);
  const seq = Number(send.stdout.trim());
  // READ THE ROW BACK, and read it back through a SEPARATE process — a send
  // that printed an id while writing nothing would satisfy any check that only
  // looked at stdout.
  const check = await runElectronCli(['check', '--as', 'w1']);
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
  // Leave the bus clean for the later arms.
  if (lot?.lot) await runElectronCli(['ack', String(lot.lot), '--as', 'w1']);
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
  const abiDir = path.join(ROOT, 'build', 'bus-abi');
  const hidden = `${abiDir}.hidden-by-rig`;
  const hadAbiDir = fs.existsSync(abiDir);
  if (hadAbiDir) fs.renameSync(abiDir, hidden);
  let r;
  try {
    r = spawnSync(process.execPath, [CLI, 'send', '--type', 'status', '--as', 'nobody', 'x'], {
      env: { ...process.env, ORCHESTRA_HOME: HOME },
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
    env: { ...process.env, ORCHESTRA_HOME: HOME },
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
  const r = await runElectronCli(['ask', '--to', 'ops', '--as', 'w1', 'may I proceed?']);
  const seq = Number(r.stdout.trim());
  // The bound is wall-clock, and generous: the claim is "it does not WAIT", and
  // an Electron cold start is a few hundred ms. A verb that waited on an answer
  // would sit here until the rig's 60s SIGKILL (code -1).
  record(
    'T115.6 ask writes the row, prints its id and EXITS (no blocking wait)',
    r.code === 0 && Number.isInteger(seq) && seq > 0 && r.ms < 30_000,
    `RC=${r.code}, printed id=${seq}, wall clock ${r.ms}ms (Bash cap is 600000ms)`,
  );
  const back = await runElectronCli(['check', '--as', 'ops']);
  const lot = JSON.parse(back.stdout.trim());
  const q = lot.messages.find((m) => m.sequence === seq);
  record(
    'T115.6b the ask actually LANDED as a question row addressed to the target',
    !!q && q.kind === 'question' && q.recipient === 'ops' && q.body === 'may I proceed?',
    `kind=${q?.kind}, recipient=${q?.recipient}, body=${JSON.stringify(q?.body)}`,
  );
  if (lot.lot) await runElectronCli(['ack', String(lot.lot), '--as', 'ops']);
}

// ─── T115.4 — check never acks, through the real binary ─────────────────────

{
  await runElectronCli(['send', '--type', 'dispatch', '--to', 'r4', '--as', 'ops', 'NOACK-1']);
  await runElectronCli(['send', '--type', 'dispatch', '--to', 'r4', '--as', 'ops', 'NOACK-2']);
  const a = JSON.parse((await runElectronCli(['check', '--as', 'r4'])).stdout.trim());
  const b = JSON.parse((await runElectronCli(['check', '--as', 'r4'])).stdout.trim());
  record(
    'T115.4 a plain check does NOT ack: the second check replays the same lot, same ids',
    a.count === 2 && a.replay === false && b.replay === true &&
      JSON.stringify(b.messages) === JSON.stringify(a.messages) && b.lot === a.lot,
    `first: lot=${a.lot} count=${a.count} replay=${a.replay}; second: lot=${b.lot} count=${b.count} replay=${b.replay}, ` +
      `messages byte-identical=${JSON.stringify(b.messages) === JSON.stringify(a.messages)}`,
  );
  const acked = await runElectronCli(['ack', String(a.lot), '--as', 'r4']);
  const c = JSON.parse((await runElectronCli(['check', '--as', 'r4'])).stdout.trim());
  record(
    'T115.4b after the reader acks, the lot is gone (so the replay above was not just "check is broken")',
    acked.code === 0 && c.count === 0 && c.lot === null,
    `ack RC=${acked.code}; next check count=${c.count} lot=${c.lot}`,
  );
}

// ─── T115.2 — ack-replay across a SIGKILL ───────────────────────────────────
//
// The consumer is KILLED between `check` and `ack`, which is the scenario the
// unique partial index on deliveries exists for. Killing the CLI process after
// it has already exited would prove nothing, so the kill happens inside a child
// that has done its `check` and is waiting for a signal.

{
  await runElectronCli(['send', '--type', 'dispatch', '--to', 'crashy', '--as', 'ops', 'CRASH-1']);
  await runElectronCli(['send', '--type', 'dispatch', '--to', 'crashy', '--as', 'ops', 'CRASH-2']);

  // The check is done by the real CLI; the "crash" is that nothing ever acks it,
  // which is byte-for-byte the state a SIGKILLed consumer leaves behind. To make
  // the kill REAL rather than simulated, run the check in a child we then
  // SIGKILL while it is still alive, and assert the lot survived it.
  const holder = spawn(
    ELECTRON,
    [
      (() => {
        const p = path.join(HOME, 'holder.cjs');
        fs.writeFileSync(
          p,
          `const { app } = require('electron');
           app.disableHardwareAcceleration();
           app.whenReady().then(async () => {
             const { runCli } = require(${JSON.stringify(CLI)});
             // runCli exits the process on completion, so intercept: we want the
             // process ALIVE after the check so the SIGKILL lands between check
             // and ack, not after a clean exit.
             const realExit = process.exit.bind(process);
             process.exit = () => {};
             await runCli(['check', '--as', 'crashy']);
             process.exit = realExit;
             setInterval(() => {}, 1000); // stay alive, un-acked, until killed
           });`,
        );
        return p;
      })(),
      '--no-sandbox',
    ],
    {
      env: { ...process.env, ORCHESTRA_HOME: HOME, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let holderOut = '';
  holder.stdout.on('data', (d) => (holderOut += d));
  // Wait for the check to have PRODUCED its lot — bounded wait-until-or-fail,
  // never sleep-then-read: a fixed sleep either flakes or measures the sleep.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !holderOut.trim().endsWith('}')) {
    await new Promise((r) => setTimeout(r, 100));
  }
  let killedLot = null;
  try {
    killedLot = JSON.parse(holderOut.trim());
  } catch {
    /* reported below */
  }
  const alive = holder.exitCode === null && holder.signalCode === null;
  holder.kill('SIGKILL');
  await new Promise((r) => holder.on('close', r));

  const after = JSON.parse((await runElectronCli(['check', '--as', 'crashy'])).stdout.trim());
  record(
    'T115.2 consumer SIGKILLed after check, before ack → the next check returns the BYTE-IDENTICAL lot',
    !!killedLot && killedLot.count === 2 && alive &&
      after.lot === killedLot.lot &&
      JSON.stringify(after.messages) === JSON.stringify(killedLot.messages) &&
      after.replay === true,
    `killed consumer held lot=${killedLot?.lot} count=${killedLot?.count} (process was alive at kill time: ${alive}); ` +
      `after the kill: lot=${after.lot} count=${after.count} replay=${after.replay}, ` +
      `messages byte-identical=${JSON.stringify(after.messages) === JSON.stringify(killedLot?.messages)}`,
  );
  // …and after the ack, ONLY NEWER rows. The second half of the acceptance:
  // without it, "the same lot forever" would also pass the assertion above.
  await runElectronCli(['ack', String(after.lot), '--as', 'crashy']);
  await runElectronCli(['send', '--type', 'dispatch', '--to', 'crashy', '--as', 'ops', 'CRASH-3']);
  const fresh = JSON.parse((await runElectronCli(['check', '--as', 'crashy'])).stdout.trim());
  record(
    'T115.2b after the ack, check returns ONLY newer rows',
    fresh.count === 1 && fresh.messages[0].body === 'CRASH-3' && fresh.lot !== after.lot,
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
// N REAL CLI processes writing the same DB at once, with a long-lived connection
// attached throughout (the running app's share of the contention). Spike arm 1's
// shape, but through the shipped binary rather than a test harness.
//
// THE CONTROL IS THE POINT. `busy_timeout=0` on the same rig MUST lose rows; the
// spike measured 7-27% loss. A control that comes back clean means the rig never
// created contention, and the passing arm above it proved nothing — so a clean
// control FAILS this script.
//
// Electron cold-starts too slowly to make 10 concurrent CLI launches meaningful
// contention, so the writers here are ELECTRON_RUN_AS_NODE processes running the
// same bundle. That IS the packaged CLI's configuration (spike condition 5: the
// AppImage's `cli` mode is Electron-as-node, ABI 130), so this is not a weaker
// runtime — it is the same one, minus the browser process.

async function contentionArm(busyTimeoutMs, writers, inserts, tag) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `orchestra-bus-cont-${tag}-`));
  const file = path.join(home, 'bus.sqlite');
  const bs3 = path.join(ROOT, 'node_modules', 'better-sqlite3');

  // Create the schema with ONE real send, so the writers below race each other
  // rather than the migration — busy_timeout is the only variable under test.
  spawnSync(ELECTRON, [CLI, 'send', '--type', 'status', '--as', 'seed', '--run', 'contention', 'seed'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCHESTRA_HOME: home },
    encoding: 'utf8',
  });

  // A long-lived reader attached for the whole arm — WAL's promise is that
  // readers never block writers, and without one this would be writers only.
  const readerJs = path.join(home, 'reader.cjs');
  fs.writeFileSync(
    readerJs,
    `const Database = require(${JSON.stringify(bs3)});
     const db = new Database(${JSON.stringify(file)}, { readonly: true });
     db.pragma('busy_timeout = 5000');
     let reads = 0;
     const t = setInterval(() => { try { db.prepare('SELECT COUNT(*) c FROM messages').get(); reads++; } catch {} }, 5);
     process.on('SIGTERM', () => { clearInterval(t); process.stdout.write(String(reads)); process.exit(0); });`,
  );
  const reader = spawn(ELECTRON, [readerJs], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let readerReads = '';
  reader.stdout.on('data', (d) => (readerReads += d));
  await new Promise((r) => setTimeout(r, 300));

  // EACH WRITER IS THE REAL CLI BINARY. Not a harness importing send(): a driver
  // that re-implements its subject measures the re-implementation (the defect
  // scripts/verify-bus-contention.mjs's header records). The only difference
  // between the two arms is $ORCHESTRA_BUS_BUSY_TIMEOUT_MS, which the shipped
  // binary reads in busyTimeoutOverride().
  //
  // One process per INSERT would be N Electron cold starts; instead each writer
  // is a shell loop issuing `inserts` real `orchestra send` invocations, so the
  // concurrency is between genuinely separate short-lived CLI processes — the
  // shape #108 Q2 describes.
  const writerSh = path.join(home, 'writer.sh');
  fs.writeFileSync(
    writerSh,
    `#!/bin/sh
     who="$1"; n="$2"; committed=0; failed=0
     i=0
     while [ "$i" -lt "$n" ]; do
       if "${ELECTRON}" "${CLI}" send --type dispatch --as "$who" --run contention "$who:$i" >/dev/null 2>>"${home}/writer-err.log"; then
         committed=$((committed+1))
       else
         failed=$((failed+1))
       fi
       i=$((i+1))
     done
     printf '{"who":"%s","committed":%d,"failed":%d}' "$who" "$committed" "$failed"`,
  );
  fs.chmodSync(writerSh, 0o755);

  const procs = [];
  for (let w = 0; w < writers; w++) {
    procs.push(
      new Promise((resolve) => {
        const c = spawn('/bin/sh', [writerSh, `w${w}`, String(inserts)], {
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            ORCHESTRA_HOME: home,
            ORCHESTRA_BUS_BUSY_TIMEOUT_MS: String(busyTimeoutMs),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let o = '';
        c.stdout.on('data', (d) => (o += d));
        c.on('close', () => {
          try {
            resolve(JSON.parse(o.trim()));
          } catch {
            resolve({ who: `w${w}`, committed: 0, failed: inserts, parseFail: o.slice(0, 200) });
          }
        });
      }),
    );
  }
  const per = await Promise.all(procs);
  reader.kill('SIGTERM');
  await new Promise((r) => reader.on('close', r));

  // THE COUNT COMES FROM THE DATABASE, never from the writers' self-reports — a
  // writer that BELIEVES it committed is precisely the failure mode here, and a
  // rig that trusts it would report the belief.
  const countOut = spawnSync(ELECTRON, ['-e', `
     const Database = require(${JSON.stringify(bs3)});
     const db = new Database(${JSON.stringify(file)}, { readonly: true });
     db.pragma('busy_timeout = 5000');
     process.stdout.write(String(db.prepare("SELECT COUNT(*) c FROM messages WHERE run_id='contention' AND sender LIKE 'w%'").get().c));
   `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
  const inDb = Number(countOut.stdout.trim());
  const errLog = fs.existsSync(path.join(home, 'writer-err.log'))
    ? fs.readFileSync(path.join(home, 'writer-err.log'), 'utf8')
    : '';
  fs.rmSync(home, { recursive: true, force: true });
  return {
    inDb,
    expected: writers * inserts,
    failedSends: per.reduce((a, p) => a + (p.failed ?? 0), 0),
    claimedCommitted: per.reduce((a, p) => a + (p.committed ?? 0), 0),
    readerReads: Number(readerReads.trim()) || 0,
    busyLines: (errLog.match(/SQLITE_BUSY/g) ?? []).length,
    per,
  };
}

{
  const WRITERS = 6;
  const INSERTS = 25;
  const pass = await contentionArm(5000, WRITERS, INSERTS, 'pass');
  record(
    `T115.1 ${WRITERS} concurrent REAL CLI writers + a live reader → NO lost rows`,
    pass.inDb === pass.expected && pass.failedSends === 0 && pass.readerReads > 0,
    `rows in DB ${pass.inDb}/${pass.expected}, failed sends=${pass.failedSends}, ` +
      `concurrent reader completed ${pass.readerReads} reads (0 would mean nothing was contending)`,
  );
  // THE CONTROL IS THE POINT. Same rig, same shipped binary, busy_timeout=0. If
  // it comes back CLEAN the rig created no contention and the arm above proved
  // nothing — so a clean control FAILS this script.
  const ctl = await contentionArm(0, WRITERS, INSERTS, 'ctl');
  const lost = ctl.expected - ctl.inDb;
  record(
    'T115.1b MUST-FAIL CONTROL busy_timeout=0 on the same rig LOSES rows (a clean control = no contention = the arm above proved nothing)',
    lost > 0,
    `rows in DB ${ctl.inDb}/${ctl.expected} → LOST ${lost} (${((lost / ctl.expected) * 100).toFixed(1)}%), ` +
      `writers reported ${ctl.failedSends} failed sends, ${ctl.busyLines} SQLITE_BUSY lines on stderr`,
  );
  // And the loss is SILENT-ish only in the DB sense: the CLI itself must have
  // REFUSED those sends rather than printing an id for a row it did not write.
  record(
    'T115.1c under the control, the CLI REFUSED the lost sends (it never printed an id for a row it did not write)',
    lost === 0 || ctl.claimedCommitted === ctl.inDb,
    `writers claimed ${ctl.claimedCommitted} committed, DB holds ${ctl.inDb} — a claim ABOVE the DB count would mean ` +
      'the verb reported success for a lost insert',
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
