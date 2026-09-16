import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { openBus, open as openBusConn, send, type BusDb } from './bus.ts';
import {
  armBusWalWatcher,
  stopBusWake,
  setWakeRoster,
  setWakeDeliver,
  busWakeCounters,
  __setBusReaderForTests,
  __resetBusWakeForTests,
  __armStartedForTests,
  __freezeSwitchForTests,
  __setWatcherEnabledForTests,
  __setWatchPathForTests,
} from './bus-wake.ts';

// #149 — the WAL ACCELERATOR, driven end to end over a REAL directory watch.
//
// This file exists because the sweep tests call `sweepBusWake()` directly and so
// are BLIND to how the sweep is TRIGGERED. The whole #149 defect lives in the
// trigger: the shipped `fs.watch(bus.sqlite-wal)` pins the watch to the WAL
// file's inode, which SQLite recycles (unlink + recreate at a new inode) on a
// last-connection close — after which the inode watch is silently dead and the
// wake rides the 60s sweep (ledger #151 STEP 1: 0/10 through a recycled inode).
//
// Every arm here drives the ACTUAL `armBusWalWatcher()` and asserts the OBSERVABLE
// the fix promises — a wake DELIVERED, triggered ONLY by a filesystem event on
// the WAL, within a sub-second window (SWEEP_MS is 60s and the timer is NOT armed
// here, so a wake inside ~1s can only have come from the watcher). Reverting the
// production line to `fs.watch(\`${'${busPath()}'}-wal\`)` reddens the recycle arm
// by construction — that inode watch delivers 0 events after the recycle.
//
// Runtime: `pnpm run test` is system node (ABI 127); bus-binding loads the
// abi127 build from build/bus-abi/. `pnpm run build:bus-abi` produces it.

const RUN = 'run-W149';
const R1 = 'ws-149';

/** A real on-disk bus in its OWN temp dir (never the live ~/.orchestra one). The
 *  directory is what the watcher watches, so it must be a genuine directory.
 *
 *  ── Why NOT os.tmpdir() ─────────────────────────────────────────────────────
 *  The #149 defect (WAL inode recycle detaches an inode-pinned fs.watch) is
 *  FILESYSTEM-SPECIFIC: it reproduces on btrfs (ledger #151 STEP 1) but NOT on
 *  tmpfs, where the inode watch keeps firing across a recycle. `os.tmpdir()` is
 *  tmpfs here, so the mutant (revert to `fs.watch(-wal)`) would SURVIVE the
 *  recycle arm on tmpfs — a vacuous gate. We put the bus on the SAME filesystem
 *  as production instead: a fresh dir under $HOME (btrfs). If $HOME is somehow
 *  not btrfs, the recycle arm is SKIPPED with a loud note rather than passing
 *  vacuously (see ARM 2). */
const HOME_FS = (() => {
  try {
    return execSync(`findmnt -no FSTYPE -T ${JSON.stringify(os.homedir())}`).toString().trim();
  } catch {
    return '?';
  }
})();

function realBus(t: { after: (fn: () => void) => void }): { db: BusDb; busFile: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.orchestra-wake149-test-'));
  const busFile = path.join(dir, 'bus.sqlite');
  const db = openBus(busFile);
  t.after(() => {
    stopBusWake();
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
    __resetBusWakeForTests();
  });
  return { db, busFile, dir };
}

/** Wire the sweep machinery to record wakes, WITHOUT starting the 60s timer. The
 *  watcher is the only thing that can fire a sweep in these tests. Also points
 *  the accelerator at THIS temp bus (never the live ~/.orchestra one). */
function wireWakes(db: BusDb, busFile: string): { reader: string; text: string }[] {
  const wakes: { reader: string; text: string }[] = [];
  __resetBusWakeForTests();
  __setBusReaderForTests(() => db);
  __setWatchPathForTests(() => busFile); // AFTER reset, which restores busPath()
  setWakeRoster(() => [{ reader: R1, wakeable: true, runId: RUN }]);
  setWakeDeliver(async (reader, text) => {
    wakes.push({ reader, text });
    return true;
  });
  __freezeSwitchForTests(true);
  __armStartedForTests(); // started=true so the sweep is not inert; timer stays OFF
  return wakes;
}

/** Poll for a condition up to `timeoutMs`, returning true as soon as it holds. */
async function waitFor(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return pred();
}

// The watcher-triggered wake must land far inside the 60s sweep. 3s gives inotify
// and the 150ms debounce ample room while still being < 2s of "real" wake latency
// plus slack; a failure here is the sweep-only regression, not flake.
const WAKE_WINDOW_MS = 3_000;

// ── ARM 1 — the watcher fires a sweep on a cross-process WAL write ──────────

test('#149 the directory watcher wakes on a cross-process WAL write (no direct sweep call)', async (t) => {
  const { db, busFile } = realBus(t);
  const wakes = wireWakes(db, busFile);
  armBusWalWatcher();
  await new Promise((r) => setTimeout(r, 100)); // let the watch settle

  // A SEPARATE connection (the CLI shape) writes a message → touches -wal.
  const cli = openBusConn(busFile);
  send(cli, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'wake up', recipient: R1 });
  cli.close();

  const woke = await waitFor(() => wakes.length > 0, WAKE_WINDOW_MS);
  assert.equal(woke, true, 'the WAL write must trigger a watcher sweep and a wake within the window');
  assert.equal(wakes[0].reader, R1);
  assert.equal(busWakeCounters().fired, 1);
});

// ── ARM 2 — THE MUTANT-KILLER: the watch survives a WAL inode RECYCLE ───────

test('#149 the watch survives a WAL inode recycle (unlink + recreate at a new inode)', async (t) => {
  // This is the arm the OLD `fs.watch(-wal)` FAILS. Reverting the production line
  // to watch the -wal file inode makes this arm RED: after the recycle the inode
  // watch is detached and delivers 0 events, so no wake lands in the window.
  //
  // The defect only reproduces on btrfs (ledger #151 STEP 1). On tmpfs the inode
  // watch survives the recycle, so this arm would pass on the MUTANT too — a
  // vacuous gate. Refuse to run vacuously: if $HOME is not btrfs, SKIP loudly.
  if (HOME_FS !== 'btrfs') {
    t.skip(`recycle arm requires btrfs to be non-vacuous; $HOME is ${HOME_FS} — mutant would survive here`);
    return;
  }
  const { db, busFile } = realBus(t);
  const wakes = wireWakes(db, busFile);
  const walFile = `${busFile}-wal`;
  armBusWalWatcher();
  await new Promise((r) => setTimeout(r, 100));

  // Record the inode, then force a REAL recycle: close every connection (SQLite
  // unlinks -wal), reopen → -wal is recreated at a NEW inode on the next write.
  const inoBefore = fs.existsSync(walFile) ? fs.statSync(walFile).ino : null;
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  await new Promise((r) => setTimeout(r, 100));
  const walUnlinked = !fs.existsSync(walFile);

  // Re-point the sweep's bus reader at a fresh connection. The reopen recreates
  // -wal at the new inode. CRITICAL: the checkpoint/close above touch the OLD
  // inode and fire the mutant's inode watch, which schedules a DEBOUNCED sweep;
  // if the test message arrived before that debounce elapsed, the mutant would
  // catch it and pass VACUOUSLY. So we settle every pending debounce here (wait
  // > WATCH_DEBOUNCE_MS with no unread mail) BEFORE the message exists — after
  // this point, only a wake TRIGGERED BY THE POST-RECYCLE WRITE can fire, which
  // is exactly what the inode mutant cannot produce.
  const app2 = openBus(busFile);
  __setBusReaderForTests(() => app2);
  await new Promise((r) => setTimeout(r, 400)); // drain any pre-recycle debounce
  assert.equal(wakes.length, 0, 'no wake may be pending from the recycle itself (else the arm is vacuous)');

  const cli = openBusConn(busFile);
  send(cli, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'after recycle', recipient: R1 });
  cli.close();
  const inoAfter = fs.existsSync(walFile) ? fs.statSync(walFile).ino : null;

  const woke = await waitFor(() => wakes.length > 0, WAKE_WINDOW_MS);

  // Diagnostics prove the recycle actually happened (else the arm is vacuous).
  assert.equal(walUnlinked, true, '-wal must be unlinked on last-connection close (recycle precondition)');
  assert.notEqual(inoAfter, inoBefore, 'the -wal inode must have changed (a real recycle, not a truncate)');
  assert.equal(woke, true, 'a directory watch must still fire after the inode recycle — the inode watch would not');
  assert.equal(wakes[0].reader, R1);

  app2.close();
});

// ── ARM 3 — the must-FAIL control: watcher DISABLED → NO watcher wake ───────

test('#149 must-FAIL arm — watcher disabled: a WAL write produces NO wake in the window (reverts to sweep)', async (t) => {
  // The acceptance must-FAIL: with the accelerator off, the only path left is the
  // 60s sweep, so nothing wakes inside the sub-second window. This proves the
  // watcher — not some other path — is what buys the sub-second latency.
  const { db, busFile } = realBus(t);
  const wakes = wireWakes(db, busFile);
  __setWatcherEnabledForTests(false); // BEFORE arming
  armBusWalWatcher();
  await new Promise((r) => setTimeout(r, 100));

  const cli = openBusConn(busFile);
  send(cli, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'no watcher', recipient: R1 });
  cli.close();

  const woke = await waitFor(() => wakes.length > 0, WAKE_WINDOW_MS);
  assert.equal(woke, false, 'with the watcher disabled, nothing may wake inside the sub-second window');
  assert.equal(busWakeCounters().fired, 0);

  // Positive control, SAME rig: a direct sweep DOES wake — proving the pending
  // message is genuinely wakeable and the zero above is the missing TRIGGER, not
  // a dead predicate or an unaddressed message.
  const { sweepBusWake } = await import('./bus-wake.ts');
  await sweepBusWake();
  assert.equal(wakes.length, 1, 'the sweep path still wakes — only the watcher trigger was removed');
});

// ── ARM 4 — survives 1000 inserts + a forced checkpoint (acceptance 3) ──────

test('#149 the watch survives 1000 inserts + a forced wal_checkpoint(TRUNCATE)', async (t) => {
  // The literal acceptance-3 count: 1000 inserts (which exceed SQLite's default
  // 1000-page auto-checkpoint threshold, so the WAL is checkpointed under us
  // during the run), then a FORCED TRUNCATE, then one more write — the watch must
  // still deliver a wake for that final write.
  const { db, busFile } = realBus(t);
  const wakes = wireWakes(db, busFile);
  armBusWalWatcher();
  await new Promise((r) => setTimeout(r, 100));

  const cli = openBusConn(busFile);
  for (let i = 0; i < 1000; i++) {
    send(cli, { runId: RUN, sender: 'ops', kind: 'dispatch', body: `m${i}`, recipient: R1 });
  }
  cli.close();
  // Fold the WAL back with a forced truncate from the app connection.
  db.pragma('wal_checkpoint(TRUNCATE)');
  await new Promise((r) => setTimeout(r, 150));
  // Drain any debounce scheduled by the flurry so the final wake is attributable
  // to the LAST write, not a straggler from the 1000.
  wakes.length = 0;

  const cli2 = openBusConn(busFile);
  send(cli2, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'final', recipient: R1 });
  cli2.close();

  const woke = await waitFor(() => wakes.length > 0, WAKE_WINDOW_MS);
  assert.equal(woke, true, 'the watch must survive 1000 inserts + a forced checkpoint and keep waking');
});
