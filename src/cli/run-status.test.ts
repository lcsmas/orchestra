// #252 D1b — `orchestra run status`: the Bilan de pause a coordinator reads. Real bus + migrations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openBus, type BusDb } from '../main/bus.ts';
import { startRun, getRun } from '../main/bus-runs.ts';
import * as busPause from '../main/bus-pause.ts';
import * as records from '../main/bus-pause-records.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';
import { gatherRunStatus, renderRunStatus, type RunStatus, type RunStatusDeps } from './run-status.ts';

const deps: RunStatusDeps = {
  getRunPause: busPause.getRunPause,
  activePauseFor: busPause.activePauseFor,
  listBilanForRun: records.listBilanForRun,
  runExists: (d, id) => getRun(d, id) !== null,
  latestPauseBilan: records.latestPauseBilanFor,
};

function rig(t: { after: (f: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-status-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const sw = { ...DEFAULT_BUS_SWITCHES, pause: true };
  startRun(db, { id: 'M', kind: 'mission', coordinator: 'lead' }, sw);
  startRun(db, { id: 'W', kind: 'vague', coordinator: 'ops', parentRunId: 'M' }, sw);
  return db;
}

test('not paused: says so, no Bilan', (t) => {
  const db = rig(t);
  const st = gatherRunStatus(db, 'W', deps);
  assert.equal(st.pause, null);
  assert.match(renderRunStatus(st), /Run W: not paused\./);
});

test('unknown run: says it has no row (never a silent "not paused")', (t) => {
  const db = rig(t);
  assert.match(renderRunStatus(gatherRunStatus(db, 'nope', deps)), /no row in the bus 'runs' table/);
});

test('paused + trap owed: says the host trap is NOT FINISHED; paused + done: DONE', (t) => {
  const db = rig(t);
  assert.equal(busPause.setRunPause(db, 'W', true, 'ops'), 'paused');
  assert.match(renderRunStatus(gatherRunStatus(db, 'W', deps)), /PAUSED \(hard\).*by ops.*\nHost trap: NOT FINISHED/s);
  const p = busPause.getRunPause(db, 'W')!;
  records.markTrapDone(db, 'W', p.pausedAt, p.pausedAt + 5);
  assert.match(renderRunStatus(gatherRunStatus(db, 'W', deps)), /Host trap: DONE at /);
});

test('the Bilan renders: dirty tree, snapshot ref, what it was doing, killed commands, survivors, notes, error', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const p = busPause.getRunPause(db, 'W')!;
  records.insertBilan(db, {
    runId: 'W',
    wsId: 'ws-impl',
    pausedAt: p.pausedAt,
    activity: {
      surface: 'sdk', memberRun: 'W', turnRunning: true, branch: 'feature-x', head: 'abcdef1234567',
      changed: { modified: 2, added: 1, deleted: 0 },
      inFlightTools: [{ tool: 'Bash', toolUseId: 't', sinceMs: 42_000 }],
      bgTasks: [{ id: 'b', type: 'shell', description: 'pnpm test rig', status: 'running' }],
      interrupt: 'interrupted', notes: ['turn started while paused at X'],
    },
    snapshotRef: 'refs/orchestra/pause/W/ws-impl/123',
    dirty: true,
    killed: { killed: [{ pid: 7, cmd: 'sleep 600', signal: 'SIGTERM', outcome: 'exited' }], survivors: [{ pid: 9, cmd: 'stuck', reason: 'unreadable' }], refused: [], spared: [{ pid: 3, cmd: 'lazy-mcp.mjs' }] },
    error: 'kill: 1 tool process(es) still alive after the trap',
  });
  const text = renderRunStatus(gatherRunStatus(db, 'W', deps));
  for (const needle of [
    'ws-impl [feature-x] — dirty tree: yes (2 modified, 1 added, 0 deleted)',
    'snapshot: refs/orchestra/pause/W/ws-impl/123',
    'git diff abcdef123 refs/orchestra/pause/W/ws-impl/123',
    'was doing: turn running · in-flight Bash 42s · background shell "pnpm test rig" (running)',
    'interrupt: interrupted',
    'killed: 1 tool process(es) — sleep 600 (pid 7)',
    'STILL ALIVE: stuck (pid 9: unreadable)',
    'left running (not tool processes): lazy-mcp.mjs',
    'note: turn started while paused at X',
    'error: kill: 1 tool process(es) still alive after the trap',
    'nothing restarts on its own',
  ]) assert.ok(text.includes(needle), `missing: ${needle}\n${text}`);
});

test('a DESCENDANT run reads the ANCESTOR pause, names the carrier to lift, and sees only its own members', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'M', true, 'lead');
  const p = busPause.getRunPause(db, 'M')!;
  const mk = (ws: string, run: string) => records.insertBilan(db, { runId: 'M', wsId: ws, pausedAt: p.pausedAt, activity: { surface: 'none', memberRun: run }, snapshotRef: null, dirty: false, killed: { skipped: 'x' }, error: null });
  mk('lead-ws', 'M');
  mk('w1', 'W');
  const st = gatherRunStatus(db, 'W', deps);
  assert.equal(st.inherited, true);
  assert.deepEqual(st.bilan.map((r) => r.wsId), ['w1']);
  assert.match(renderRunStatus(st), /carried by ancestor run M; lift it with: orchestra run resume --run M/);
});

test('--json shape is the RunStatus object (machine-readable Bilan)', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const st = JSON.parse(JSON.stringify(gatherRunStatus(db, 'W', deps)));
  assert.deepEqual(Object.keys(st).sort(), ['bilan', 'inherited', 'lastPause', 'pause', 'reprise', 'runExists', 'runId', 'stillPausedBy']);
  assert.equal(st.pause.runId, 'W');
});

test('AFTER the lift the Bilan is still readable (the footer tells the coordinator to re-dispatch from it): "not paused" + the last pause\'s rows', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const p = busPause.getRunPause(db, 'W')!;
  records.insertBilan(db, { runId: 'W', wsId: 'ws-x', pausedAt: p.pausedAt, activity: { surface: 'sdk', memberRun: 'W', turnRunning: true }, snapshotRef: 'refs/orchestra/pause/W/ws-x/9', dirty: true, killed: { killed: [{ pid: 1, cmd: 'sleep 9', signal: 'SIGTERM', outcome: 'exited' }] }, error: null });
  assert.equal(busPause.setRunPause(db, 'W', false, 'ops'), 'lifted');
  const st = gatherRunStatus(db, 'W', deps);
  assert.equal(st.pause, null);
  assert.equal(st.lastPause?.carrierRunId, 'W');
  const text = renderRunStatus(st);
  assert.match(text, /Run W: not paused\./);
  assert.match(text, /Last pause \(LIFTED\): carried by run W/);
  assert.match(text, /snapshot: refs\/orchestra\/pause\/W\/ws-x\/9/);
  assert.match(text, /killed: 1 tool process\(es\) — sleep 9/);
  // a run that never had a pause says nothing extra
  assert.ok(!/Last pause/.test(renderRunStatus(gatherRunStatus(db, 'M', { ...deps, latestPauseBilan: () => null }))));
});

test('D11: a killed ORPHAN is listed with its cmdline, pid, cwd and the reason that matched', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const p = busPause.getRunPause(db, 'W')!;
  records.insertBilan(db, {
    runId: 'W', wsId: 'ws-o', pausedAt: p.pausedAt, activity: { surface: 'sdk', memberRun: 'W' }, snapshotRef: null, dirty: null, error: null,
    killed: { cli: { pid: 100, startTicks: 1000 }, killed: [
      { pid: 7, cmd: 'sleep 7715', signal: 'SIGTERM', outcome: 'exited', via: 'env', cwd: '/work/tree-ws-o', evidence: "CLAUDE_PID=100 names this member's CLI (pid 100, start-time 1000) | re-read now: environ CLAUDE_PID=100 == CLI 100" },
      { pid: 8, cmd: 'sleep 1', signal: 'SIGTERM', outcome: 'exited', via: 'chain', cwd: '/x', evidence: 'chain' },
    ] },
  });
  const text = renderRunStatus(gatherRunStatus(db, 'W', deps));
  assert.match(text, /orphan killed \(left the CLI's tree, via env\): sleep 7715 pid 7 cwd \/work\/tree-ws-o — CLAUDE_PID=100 names this member's CLI \(pid 100, start-time 1000\)/);
  assert.equal((text.match(/orphan killed/g) ?? []).length, 1, 'only the orphan (not the ppid-tree child) is listed as one');
});

test('F11: control characters in a raw argv / task text are stripped before they reach the terminal (no ESC / CR / NUL in the output)', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const p = busPause.getRunPause(db, 'W')!;
  records.insertBilan(db, {
    runId: 'W', wsId: 'ws-c', pausedAt: p.pausedAt, activity: { surface: 'sdk', memberRun: 'W', lastTask: 'do x\u001b[2J\u001b]0;pwned\u0007 then\r\ny', bgTasks: [{ id: 'b', type: 'shell', description: 'rig\u001b[31mRED', status: 'running' }] },
    snapshotRef: null, dirty: null, error: null,
    killed: { killed: [{ pid: 1, cmd: 'sleep\u001b[1m 9\u0000', signal: 'SIGTERM', outcome: 'exited' }] },
  });
  const text = renderRunStatus(gatherRunStatus(db, 'W', deps));
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text.replace(/\n/g, '')), 'no control character survives (newlines are the output\'s own)');
  assert.match(text, /sleep.* 9/);
});

test('F11 (round 2): EVERY recorded string is sanitized — orphan cwd/evidence, skipped paths, snapshot warnings, submodule path/error, notes, errors, refused/survivor reasons — and a newline inside a value cannot forge a line', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const p = busPause.getRunPause(db, 'W')!;
  records.insertBilan(db, {
    runId: 'W', wsId: 'ws-d', pausedAt: p.pausedAt,
    activity: {
      surface: 'sdk', memberRun: 'W', branch: 'b\u001b[1m', head: 'abc\u001bdef0123456',
      snapshotWarnings: ['unreadable f\u001b[2J'], skippedLarge: [{ path: 'big\u0007.bin', bytes: 3e7 }],
      submodules: [{ path: 'sub\u001b[0m', ref: null, dirty: false, error: 'boom\u001b[0m' }],
      notes: ['note\u001b[0m\nFORGED: note line'],
      observerKilled: [{ pid: 9, cmd: 'x', signal: 'SIGTERM', outcome: 'exited', via: 'env', cwd: '/w\u001b[0m\nkilled: FORGED', evidence: 'ev\u001b[0m' }],
    },
    snapshotRef: 'refs/x\u001b[0m', dirty: true, error: 'err\u001b[0m\nFORGED: error line',
    killed: { killed: [{ pid: 1, cmd: 'orphan', signal: 'SIGTERM', outcome: 'exited', via: 'env', cwd: '/cwd\u001b[2J\nkilled: FORGED', evidence: 'why\u001b[0m' }], refused: [{ pid: 2, cmd: 'r', reason: 'nope\u001b[0m' }], survivors: [{ pid: 3, cmd: 's', reason: 'alive\u001b[0m' }] },
  });
  const text = renderRunStatus(gatherRunStatus(db, 'W', deps));
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f]/.test(text.replace(/\n/g, '')), 'no control character survives');
  assert.ok(!/^\s*(FORGED|killed: FORGED)/m.test(text), 'a newline inside a value did not start a forged line');
  assert.match(text, /orphan killed \(left the CLI's tree, via env\)/);
});

test('round-3 F8/F7/F5: U+202E / U+2028 are stripped from every recorded string; the snapshot line says "uncommitted non-ignored work"; a total-cap skip names its reason; kills of an incomplete earlier attempt are listed', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const p = busPause.getRunPause(db, 'W')!;
  records.insertBilan(db, {
    runId: 'W', wsId: 'ws-e', pausedAt: p.pausedAt,
    activity: {
      surface: 'sdk', memberRun: 'W',
      skippedLarge: [{ path: 'huge\u202e.bin', bytes: 300 * 1048576, reason: 'file-cap' }, { path: 'dropped.dat', bytes: 40 * 1048576, reason: 'total-cap' }],
      earlierKilled: [{ pid: 77, cmd: 'sleep 9\u2028killed: FORGED', signal: 'SIGTERM', outcome: 'exited' }],
      notes: ['n\u202eote'],
    },
    snapshotRef: 'refs/orchestra/pause/W/ws-e/1', dirty: true, error: 'e\u2029rr',
    killed: { killed: [] },
  });
  const text = renderRunStatus(gatherRunStatus(db, 'W', deps));
  assert.ok(!/[\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(text), 'no Unicode line separator / bidi override survives');
  assert.ok(!/^\s*killed: FORGED/m.test(text));
  assert.match(text, /shows the uncommitted non-ignored work/);
  assert.match(text, /dropped\.dat \(40 MB, total size cap\)/);
  assert.match(text, /killed by EARLIER incomplete attempt\(s\) of the trap: sleep 9 killed: FORGED \(pid 77\)/);
});

test('round-3 review nits: a small skipped file reads "3.0 MB" (never "0 MB"), the skip list is bounded to 20 (+N more), and U+200E / U+200F / U+061C are stripped', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const p = busPause.getRunPause(db, 'W')!;
  records.insertBilan(db, {
    runId: 'W', wsId: 'ws-f', pausedAt: p.pausedAt,
    activity: { surface: 'sdk', memberRun: 'W', skippedLarge: Array.from({ length: 25 }, (_, i) => ({ path: `f${i}\u200e\u200f\u061c.bin`, bytes: 3 * 1048576, reason: 'total-cap' as const })) },
    snapshotRef: 'refs/x', dirty: true, error: null, killed: { killed: [] },
  });
  const text = renderRunStatus(gatherRunStatus(db, 'W', deps));
  assert.match(text, /f0\s*\s*\s*\.bin \(3\.0 MB, total size cap\)/);
  assert.match(text, /; \+5 more/);
  assert.equal((text.match(/\.bin \(3\.0 MB/g) ?? []).length, 20, 'only 20 are printed');
  assert.ok(!/[\u200e\u200f\u061c]/.test(text));
});

test('round-3 F5b: invisible formatting characters (U+200B/2060/FEFF/00AD/180E) and the Unicode TAG block (U+E00xx) never reach the terminal', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const p = busPause.getRunPause(db, 'W')!;
  records.insertBilan(db, {
    runId: 'W', wsId: 'ws-g', pausedAt: p.pausedAt,
    activity: { surface: 'sdk', memberRun: 'W', notes: ['a\u200bb\u2060c\ufeffd\u00ade\u180ef\u{e0041}\u{e0042}g'] },
    snapshotRef: null, dirty: null, error: null, killed: { killed: [] },
  });
  const text = renderRunStatus(gatherRunStatus(db, 'W', deps));
  assert.ok(!/[\u200b\u2060\ufeff\u00ad\u180e\u{e0000}-\u{e007f}]/u.test(text), 'no invisible character survives');
  assert.match(text, /a b c d e f  g/);
});

test('round-3 F1/F4a: snapshot notes (oversize files git < 2.25 could not exclude) read "captured despite the cap", a dropped DIRECTORY shows its file count, and the +N more uses the full count', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const p = busPause.getRunPause(db, 'W')!;
  records.insertBilan(db, {
    runId: 'W', wsId: 'ws-h', pausedAt: p.pausedAt,
    activity: { surface: 'sdk', memberRun: 'W', skippedLarge: [{ path: 'vendor/', bytes: 900 * 1048576, reason: 'total-cap', files: 240000 }], skippedLargeCount: 1500, snapshotNotes: ['30 oversize entr(ies) could NOT be excluded (git < 2.25) — they ARE in the ref'] },
    snapshotRef: 'refs/x', dirty: true, error: null, killed: { killed: [] },
  });
  const text = renderRunStatus(gatherRunStatus(db, 'W', deps));
  assert.match(text, /vendor\/ \(900 MB, 240000 files, total size cap\); \+1499 more/);
  assert.match(text, /captured despite the cap: 30 oversize entr\(ies\) could NOT be excluded/);
});

test('round-4: a snapshot that timed out reads "snapshot: INCOMPLETE (timeout)" with the error, no ref line', (t) => {
  const db = rig(t);
  busPause.setRunPause(db, 'W', true, 'ops');
  const p = busPause.getRunPause(db, 'W')!;
  records.insertBilan(db, {
    runId: 'W', wsId: 'ws-i', pausedAt: p.pausedAt,
    activity: { surface: 'sdk', memberRun: 'W', snapshotIncomplete: 'timeout' },
    snapshotRef: null, dirty: null, error: 'snapshot incomplete: timeout — git add exceeded 120000 ms', killed: { killed: [] },
  });
  const text = renderRunStatus(gatherRunStatus(db, 'W', deps));
  assert.match(text, /snapshot: INCOMPLETE \(timeout\) — no ref was written; the interrupt and the kills still ran/);
  assert.match(text, /error: snapshot incomplete: timeout/);
});

test('RESUMING: the "N/M repris" count is printed ONCE (the Pause roster line) — the reprise view adds only libérés + bloqués; after ACTIVE (no Pause line left) the count shows', () => {
  const at = 1_780_000_000_000;
  const resuming = {
    runId: 'M',
    runExists: true,
    pause: { runId: 'M', pausedAt: at, pausedBy: 'lead', mode: 'hard', trapAt: at + 1, resumeStartedAt: at + 2 },
    roster: { carrierRunId: 'M', mode: 'hard', phase: 'resuming', pausedAt: at, pausedBy: 'lead', deadlineAt: null, escalatedAt: null, trapAt: at + 1, summary: { phase: 'resuming', total: 2, done: 0, missing: ['a', 'b'] }, rows: [] },
    inherited: false,
    bilan: [],
    lastPause: null,
    reprise: { carrier: 'M', pausedAt: at, phase: 'resuming', total: 2, released: 1, done: 0, missing: ['a', 'b'], blocked: ['b'] },
    stillPausedBy: null,
  } as unknown as RunStatus;
  const text = renderRunStatus(resuming);
  assert.equal((text.match(/0\/2 repris/g) ?? []).length, 1, text);
  assert.match(text, /^reprise: RESUMING \(carrier M\) — 1\/2 libérés$/m);
  assert.match(text, /^reprise: BLOQUÉS .* : b$/m);
  const active = { ...resuming, pause: null, roster: undefined, reprise: { carrier: 'M', pausedAt: at, phase: 'active', total: 2, released: 2, done: 1, missing: ['b'], blocked: [] } } as unknown as RunStatus;
  const t2 = renderRunStatus(active);
  assert.match(t2, /^reprise: 1\/2 repris — manquent : b$/m, t2);
});

test('NESTED: a nearer carrier merely PAUSED under a RESUMING ancestor prints its own roster line — the ancestor\'s "N/M repris — manquent" is NOT dropped', () => {
  const at = 1_780_000_000_000;
  const st = {
    runId: 'O',
    runExists: true,
    pause: { runId: 'O', pausedAt: at + 9, pausedBy: 'lead', mode: 'hard', trapAt: null },
    roster: { carrierRunId: 'O', mode: 'hard', phase: 'paused', pausedAt: at + 9, pausedBy: 'lead', deadlineAt: null, escalatedAt: null, trapAt: null, summary: { phase: 'paused', total: 1, done: 0, missing: ['x'] }, rows: [] },
    inherited: false,
    bilan: [],
    lastPause: null,
    reprise: { carrier: 'L', pausedAt: at, phase: 'resuming', total: 3, released: 1, done: 0, missing: ['a', 'b', 'c'], blocked: ['b'] },
    stillPausedBy: null,
  } as unknown as RunStatus;
  const text = renderRunStatus(st);
  assert.match(text, /^reprise: RESUMING \(carrier L\) — 1\/3 libérés — 0\/3 repris — manquent : a, b, c$/m, text);
});
