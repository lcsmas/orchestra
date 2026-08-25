#!/usr/bin/env node
/**
 * GATE for issue #59 — `orchestra verify-landed` must exit NONZERO on a NOT
 * LANDED verdict, with a code DISTINCT from the error code.
 *
 * WHY THIS FILE EXISTS AND `src/cli/fail-exit-code.test.ts` CANNOT REPLACE IT
 * ---------------------------------------------------------------------------
 * The defect is invisible under plain Node. `process.exit()` terminates
 * synchronously there, so the UNFIXED code passes any node-run assertion — the
 * unit file says so itself at its top. The bug only exists inside the ELECTRON
 * MAIN PROCESS, where the packaged binary doubles as the CLI and `process.exit()`
 * called from inside an HTTP/socket response callback does NOT terminate
 * synchronously: execution ran on past it into `runCli`'s `process.exit(0)`, so
 * `NOT LANDED` printed and the process still exited 0.
 *
 * So this rig runs the REAL built `dist-electron/cli.js` inside a REAL Electron
 * main process, against a REAL unix socket, and reads the REAL exit code. That
 * is the only configuration in which the bug is observable, and therefore the
 * only configuration in which a green result means anything.
 *
 * PROVE-CAN-FAIL: run with `--expect-broken` against a tree whose fix has been
 * reverted; the rig then REQUIRES the buggy RC=0 and fails if it does not see
 * it. A gate nobody has watched fail is not a gate.
 *
 *   node scripts/verify-verify-landed-exit.mjs                 # expect FIXED
 *   node scripts/verify-verify-landed-exit.mjs --expect-broken # expect the bug
 *
 * The socket is a stub that returns a canned `/verifyLanded` payload, so the
 * rig needs no repo, no worktrees and no Orchestra state — it isolates exactly
 * the axis under test (the CLI's exit path) from git and from the store.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const CLI = path.join(REPO, 'dist-electron', 'cli.js');
const ELECTRON = path.join(REPO, 'node_modules', '.bin', 'electron');

const EXPECT_BROKEN = process.argv.includes('--expect-broken');

/** Exit codes this gate pins. */
const LANDED = 0;
const ERROR = 1;
const NOT_LANDED = 2;

function die(msg) {
  console.error(`\n✘ ${msg}`);
  process.exit(1);
}

if (!existsSync(CLI)) die(`missing ${CLI} — run \`pnpm run build:cli\` first`);
if (!existsSync(ELECTRON)) die(`missing ${ELECTRON} — run \`pnpm install\` first`);

// ---------------------------------------------------------------------------
// Stub socket: answers /verifyLanded with whatever the current scenario needs.
// ---------------------------------------------------------------------------
const tmp = mkdtempSync(path.join(os.tmpdir(), 'vl-exit-'));
const SOCK = path.join(tmp, 'orchestra.sock');

/** @type {{ status: number, body: object }} */
let reply = { status: 200, body: { ok: true } };
let hits = 0;

const server = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    hits += 1;
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
});

await new Promise((resolve, reject) => {
  server.on('error', reject);
  server.listen(SOCK, resolve);
});

/**
 * Run the built CLI INSIDE the Electron main process — the configuration in
 * which the bug exists. `ELECTRON_RUN_AS_NODE` is deliberately NOT set: that
 * would degrade Electron to plain node and silently reintroduce the synchronous
 * `process.exit` that hides the defect. A tiny inline main script requires the
 * bundle and calls `runCli`, mirroring `src/main/index.ts`'s dual-mode entry.
 */
function runInElectron(args) {
  const mainJs = path.join(tmp, 'main.cjs');
  writeFileSync(
    mainJs,
    `const { app } = require('electron');
     app.disableHardwareAcceleration();
     app.whenReady().then(async () => {
       const { runCli } = require(${JSON.stringify(CLI)});
       await runCli(${JSON.stringify(args)});
     });`,
  );
  return new Promise((resolve) => {
    const child = spawn(ELECTRON, [mainJs, '--no-sandbox'], {
      env: {
        ...process.env,
        ORCHESTRA_SOCK: SOCK,
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: -1, stdout, stderr: stderr + '\n[rig] TIMEOUT' });
    }, 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✔' : '✘'} ${name}\n    ${detail}`);
}

// --- artifact identity: assert WHAT WE RAN, never by path -------------------
const electronVersion = await new Promise((resolve) => {
  const p = spawn(ELECTRON, ['--version'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  let o = '';
  p.stdout.on('data', (d) => (o += d));
  p.on('close', () => resolve(o.trim()));
});
console.log(`\n[rig] electron ${electronVersion}`);
console.log(`[rig] CLI bundle ${CLI}`);
console.log(`[rig] socket ${SOCK}`);
console.log(`[rig] mode: ${EXPECT_BROKEN ? 'EXPECT-BROKEN (prove-can-fail)' : 'EXPECT-FIXED'}\n`);

// --- POSITIVE CONTROL: a LANDED verdict must still exit 0 -------------------
// Guards the opposite failure: a "fix" that just exits nonzero always would
// pass the NOT-LANDED case while destroying the verb.
reply = {
  status: 200,
  body: { ok: true, id: 'x', branch: 'child', target: 'main', unmerged: 0, commits: [] },
};
{
  const r = await runInElectron(['verify-landed', 'some-id']);
  const textOk = /LANDED: every commit on child is on main \(0 unmerged\)/.test(r.stdout);
  const notNot = !/NOT LANDED/.test(r.stdout);
  record(
    'CONTROL landed → RC=0 and verdict text intact',
    r.code === LANDED && textOk && notNot,
    `RC=${r.code} (want ${LANDED}) · text=${textOk} · stdout=${JSON.stringify(r.stdout.trim())}`,
  );
}

// --- THE REGRESSION: NOT LANDED ---------------------------------------------
reply = {
  status: 200,
  body: {
    ok: true,
    id: 'x',
    branch: 'child',
    target: 'main',
    unmerged: 2,
    commits: ['abc1234 first', 'def5678 second'],
  },
};
{
  const r = await runInElectron(['verify-landed', 'some-id']);

  // The TEXTUAL VERDICT MUST BE UNCHANGED, and must stay on STDOUT.
  const textOk =
    /^NOT LANDED: 2 commit\(s\) on child missing from main:\n {2}abc1234 first\n {2}def5678 second$/m.test(
      r.stdout.trim(),
    );
  record(
    'verdict text unchanged and on STDOUT',
    textOk,
    `stdout=${JSON.stringify(r.stdout.trim())}`,
  );
  record(
    'verdict is NOT on stderr',
    !/NOT LANDED/.test(r.stderr),
    `stderr=${JSON.stringify(r.stderr.trim().slice(0, 200))}`,
  );

  if (EXPECT_BROKEN) {
    // Prove-can-fail arm: on the UNFIXED tree this MUST reproduce RC=0.
    record(
      'PROVE-CAN-FAIL: unfixed tree reproduces the bug (RC=0 on NOT LANDED)',
      r.code === 0,
      `RC=${r.code} (want 0 = the bug reproducing). If this is nonzero the ` +
        `tree is already fixed and the gate proves nothing.`,
    );
  } else {
    record(
      'NOT LANDED exits NONZERO',
      r.code !== 0,
      `RC=${r.code} (want != 0)`,
    );
    record(
      `NOT LANDED exits with the DISTINCT code ${NOT_LANDED}`,
      r.code === NOT_LANDED,
      `RC=${r.code} (want ${NOT_LANDED}, distinct from error code ${ERROR})`,
    );
  }
}

// --- ERROR case must be DISTINCT from the not-landed code -------------------
reply = { status: 200, body: { ok: false, error: 'unknown workspace: some-id' } };
{
  const r = await runInElectron(['verify-landed', 'some-id']);
  const onStderr = /unknown workspace/.test(r.stderr);
  const noVerdict = !/LANDED/.test(r.stdout);
  record(
    `ERROR (unknown workspace) exits ${ERROR}, distinct from ${NOT_LANDED}`,
    r.code === ERROR && r.code !== NOT_LANDED,
    `RC=${r.code} (want ${ERROR}) · error on stderr=${onStderr} · no verdict on stdout=${noVerdict}`,
  );
  record(
    'ERROR prints no verdict on stdout and no "undefined"',
    noVerdict && !/undefined/.test(r.stdout + r.stderr),
    `stdout=${JSON.stringify(r.stdout.trim())}`,
  );
}

// --- usage error (fail BEFORE any socket call) ------------------------------
{
  const before = hits;
  const r = await runInElectron(['verify-landed']);
  record(
    `usage error exits ${ERROR} without reaching the socket`,
    r.code === ERROR && hits === before,
    `RC=${r.code} (want ${ERROR}) · socket hits during call=${hits - before} (want 0)`,
  );
}

server.close();
rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.error(`\n✘ FAILED:\n${failed.map((f) => `  - ${f.name}: ${f.detail}`).join('\n')}`);
  process.exit(1);
}
console.log(EXPECT_BROKEN ? '\n✔ bug reproduced on the unfixed tree' : '\n✔ #59 gate PASSED');
