import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bus from '../main/bus.ts';
import * as busRuns from '../main/bus-runs.ts';
import { getRunPause } from '../main/bus-pause.ts';
import { insertBilan } from '../main/bus-pause-records.ts';
import { readCarrierColumns, readRoster } from '../main/pause-reprise.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';
import { commandHelp, wantsCommandHelp } from './help.ts';

// #255 `orchestra run resume | release | confirm reprise` — the BUILT CLI, socket dead on purpose (every verb is store-less: it must work with the app
// DOWN), isolated ORCHESTRA_HOME/HOME under the real home (btrfs; never the live bus). State is read back through a FRESH connection. Literal expectations.
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };
const ROOT = path.join(os.homedir(), '.cache', `pause-e2-cli-${process.pid}`);
const ON: BusSwitches = { ...DEFAULT_BUS_SWITCHES, pause: true };
let n = 0;

function cli(home: string, args: string[], wsId: string | null): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_SOCK: path.join(home, 'no.sock') };
  if (wsId !== null) env.ORCHESTRA_WS_ID = wsId;
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** L mission ⊃ O (workers o1, o2) ; run id == coordinator id (the app's anchor rule). A paused fleet whose host trap FINISHED (Bilan rows + pause_trap_at). */
function pausedFleet(t: { after: (fn: () => void) => void }): string {
  const h = path.join(ROOT, `h${n++}`);
  mkdirSync(h, { recursive: true });
  t.after(() => rmSync(h, { recursive: true, force: true }));
  const db = bus.openBus(path.join(h, 'bus.sqlite'));
  try {
    busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
    busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, ON);
  } finally {
    db.close();
  }
  assert.equal(cli(h, ['run', 'pause', '--hard', '--run', 'L'], 'L').code, 0);
  const d2 = bus.openBus(path.join(h, 'bus.sqlite'));
  try {
    const pausedAt = getRunPause(d2, 'L')!.pausedAt;
    for (const [ws, run] of [['L', 'L'], ['O', 'O'], ['o1', 'O'], ['o2', 'O']] as const) {
      insertBilan(d2, {
        runId: 'L', wsId: ws, pausedAt,
        activity: { surface: 'sdk', memberRun: run, branch: `br-${ws}`, head: `head-${ws}` },
        snapshotRef: `refs/orchestra/pause/L/${ws}/1`, dirty: ws === 'o1',
        killed: { killed: ws === 'o1' ? [{ pid: 5, comm: 'bash', cmd: 'make slow-rig', cwd: '/w/o1', signal: 'SIGTERM', outcome: 'exited', startTicks: 1, evidence: 'e', via: 'child' }] : [], survivors: [], refused: [], spared: [] },
        error: null,
      });
    }
    d2.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  } finally {
    d2.close();
  }
  return h;
}

function read<T>(h: string, fn: (db: bus.BusDb) => T): T {
  const db = bus.openBus(path.join(h, 'bus.sqlite'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('FLOW (app DOWN): resume starts the Reprise → workers stay BLOCKED → their OPS releases them (each gets its Consigne) → run ACTIVE → accusés', needsBuild, (t) => {
  const h = pausedFleet(t);
  // a paused (not yet resuming) run has nothing to release
  const early = cli(h, ['run', 'release', '--all', '--run', 'O'], 'O');
  assert.notEqual(early.code, 0);
  assert.match(early.stderr, /is not under a RESUMING pause — nothing to release/);

  const r = cli(h, ['run', 'resume', '--run', 'L'], 'L');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Run L: REPRISE STARTED/);
  // a RESUMING carrier is still a carried pause for the reader — `run status` says RESUMING (never "not paused" / "Last pause (LIFTED)") even to the released LEAD
  const stResuming = cli(h, ['run', 'status', '--run', 'L'], 'L').stdout;
  assert.match(stResuming, /^Run L: RESUMING — the hard pause of /);
  assert.doesNotMatch(stResuming, /not paused|LIFTED/);
  assert.match(stResuming, /^reprise: RESUMING \(carrier L\) — 2\/4 libérés$/m);
  assert.equal((stResuming.match(/0\/4 repris/g) ?? []).length, 1, 'the N/M repris count is printed ONCE (the Pause roster line) — the reprise view adds only libérés + bloqués');
  const roster = read(h, (db) => readRoster(db, 'L', readCarrierColumns(db, 'L')!.pausedAt!));
  assert.deepEqual(roster.filter((m) => m.releasedAt !== null).map((m) => m.wsId).sort(), ['L', 'O'], 'only the coordinators are released');
  assert.deepEqual(roster.filter((m) => m.releasedAt === null).map((m) => m.wsId).sort(), ['o1', 'o2'], 'workers stay blocked');
  assert.equal(read(h, (db) => db.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'reprise'").get() as { c: number }).c, 2, 'one Bilan row per coordinator, none for a worker');

  // a worker may not release itself or a peer; a stranger neither; --help never acts
  assert.notEqual(cli(h, ['run', 'release', 'o1', '--run', 'O'], 'o2').code, 0);
  const help = cli(h, ['run', 'release', '--all', '--help', '--run', 'O'], 'O');
  assert.equal(help.code, 0);
  assert.match(help.stdout, /usage: orchestra run refreeze/);
  assert.equal(read(h, (db) => readRoster(db, 'L', readCarrierColumns(db, 'L')!.pausedAt!).filter((m) => m.releasedAt === null).length), 2, '--help released nothing');
  assert.notEqual(cli(h, ['run', 'release', '--bogus', '--run', 'O'], 'O').code, 0);
  assert.notEqual(cli(h, ['run', 'release', '--run', 'O'], 'O').code, 0, 'no target');

  // not released yet ⇒ its accusé is refused
  const early2 = cli(h, ['run', 'confirm', 'reprise'], 'o1');
  assert.notEqual(early2.code, 0);
  assert.match(early2.stderr, /you are not released yet/);

  const rel = cli(h, ['run', 'release', 'o1', '--run', 'O'], 'O');
  assert.equal(rel.code, 0, rel.stderr);
  assert.match(rel.stdout, /Released 1 member\(s\): o1 — each was sent its Consigne de reprise/);
  const consigne = read(h, (db) => db.prepare("SELECT * FROM messages WHERE kind = 'reprise' AND recipient = 'o1'").get() as { body: string; sender: string; run_id: string });
  assert.deepEqual([consigne.sender, consigne.run_id], ['O', 'O']);
  for (const needle of ['Snapshot ref: refs/orchestra/pause/L/o1/1', 'make slow-rig', 'Dirty tree: YES']) assert.ok(consigne.body.includes(needle), needle);

  const all = cli(h, ['run', 'release', '--all', '--run', 'O'], 'O');
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /Released 1 member\(s\): o2/);
  assert.match(all.stdout, /every member is released — the pause is LIFTED, the run is ACTIVE/);
  assert.equal(read(h, (db) => readCarrierColumns(db, 'L')!.pausedAt), null, 'ACTIVE: every pause column NULL');

  assert.match(cli(h, ['run', 'confirm', 'reprise'], 'o1').stdout, /Reprise accusé recorded for o1/);
  assert.match(cli(h, ['run', 'confirm', 'reprise'], 'o1').stdout, /already recorded/);
  assert.match(cli(h, ['run', 'confirm', 'reprise'], 'o2').stdout, /Reprise accusé recorded for o2/, 'the last worker confirms after the run is active');
  const st = cli(h, ['run', 'status', '--run', 'L'], 'L').stdout;
  assert.match(st, /reprise: 2\/4 repris — manquent : L, O/, 'run status carries the same N/M line the bus-status prints');
});

test('resume with the host trap FINISHED and nothing but coordinators to wait for closes the Reprise at once (the plain-lift text)', needsBuild, (t) => {
  const h = path.join(ROOT, `h${n++}`);
  mkdirSync(h, { recursive: true });
  t.after(() => rmSync(h, { recursive: true, force: true }));
  const db = bus.openBus(path.join(h, 'bus.sqlite'));
  try {
    busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
  } finally {
    db.close();
  }
  cli(h, ['run', 'pause', '--hard', '--run', 'L'], 'L');
  read(h, (d) => d.prepare('UPDATE runs SET pause_trap_at = paused_at + 1 WHERE id = ?').run('L'));
  const r = cli(h, ['run', 'resume', '--run', 'L'], 'L');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Run L pause LIFTED — réveils, turns and spawns are allowed again\./);
  assert.equal(read(h, (d) => getRunPause(d, 'L')), null);
});

test('confirm: unknown subcommand / extra argument / no roster are refused with a usage line', needsBuild, (t) => {
  const h = pausedFleet(t);
  assert.match(cli(h, ['run', 'confirm'], 'o1').stderr, /orchestra run confirm reprise \[--as <handle>\]/);
  assert.match(cli(h, ['run', 'confirm', 'nonsense'], 'o1').stderr, /orchestra run confirm reprise \[--as <handle>\]/);
  assert.match(cli(h, ['run', 'confirm', 'reprise', 'x'], 'o1').stderr, /unexpected argument "x"/);
  assert.match(cli(h, ['run', 'confirm', 'reprise'], 'stranger').stderr, /stranger is in no Reprise roster/);
  assert.match(cli(h, ['run', 'confirm', 'reprise'], null).stderr, /no identity/);
});

test('help: `run --help` documents resume/release/confirm; `release` and `confirm` are help-able verbs (never act on --help)', () => {
  const help = commandHelp('run') ?? '';
  assert.match(help, /orchestra run release <workspace-id>\.\.\. \| --all/);
  assert.match(help, /orchestra run confirm reprise/);
  assert.match(help, /CONSIGNE DE REPRISE/);
  assert.match(help, /Every worker stays BLOCKED/);
  assert.doesNotMatch(help, /there is no structured Reprise yet/);
  for (const a of [['release', '--all', '--help'], ['release', 'o1', '-h'], ['confirm', 'reprise', '--help']]) assert.equal(wantsCommandHelp(a, 'run'), true, a.join(' '));
});

test('NESTED carriers: an inner Reprise that closes (resume or last release) while an ANCESTOR run still pauses it says so — never "LIFTED / ACTIVE / allowed again"', needsBuild, (t) => {
  const h = path.join(ROOT, `h${n++}`);
  mkdirSync(h, { recursive: true });
  t.after(() => rmSync(h, { recursive: true, force: true }));
  const db = bus.openBus(path.join(h, 'bus.sqlite'));
  try {
    busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
    busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O', parentRunId: 'L' }, ON);
    busRuns.startRun(db, { id: 'P', kind: 'vague', coordinator: 'P', parentRunId: 'L' }, ON);
  } finally {
    db.close();
  }
  assert.equal(cli(h, ['run', 'pause', '--hard', '--run', 'L'], 'L').code, 0);
  assert.equal(cli(h, ['run', 'pause', '--hard', '--run', 'O'], 'O').code, 0);
  assert.equal(cli(h, ['run', 'pause', '--hard', '--run', 'P'], 'P').code, 0);
  // O: trap finished, only its coordinator → the Reprise closes AT ONCE inside `resume`; P: one worker `pw`, so the LAST RELEASE closes it
  read(h, (d) => {
    const po = getRunPause(d, 'O')!.pausedAt, pp = getRunPause(d, 'P')!.pausedAt;
    d.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(po + 1, 'O');
    d.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pp + 1, 'P');
    insertBilan(d, { runId: 'P', wsId: 'pw', pausedAt: pp, activity: { surface: 'sdk', memberRun: 'P' }, snapshotRef: 'refs/orchestra/pause/P/pw/1', dirty: false, killed: { killed: [] }, error: null });
  });
  const o = cli(h, ['run', 'resume', '--run', 'O'], 'O');
  assert.equal(o.code, 0, o.stderr);
  assert.equal(o.stdout, "Run O's own pause is LIFTED, but it is still PAUSED by run L — lift that one: orchestra run resume --run L\n");
  assert.equal(read(h, (d) => getRunPause(d, 'O')), null, 'precondition: O closed at once');
  assert.equal(cli(h, ['run', 'resume', '--run', 'P'], 'P').code, 0);
  // `run status` of a RESUMING run names the ANCESTOR that still gates it (the gate is correct; the text must not hide it)
  const stP = cli(h, ['run', 'status', '--run', 'P'], 'P').stdout;
  assert.match(stP, /^Run P: RESUMING/);
  assert.match(stP, /Still PAUSED by run L \(an ancestor\) — its members stay blocked until that one resumes too: orchestra run resume --run L/);
  const rel = cli(h, ['run', 'release', '--all', '--run', 'P'], 'P');
  assert.equal(rel.code, 0, rel.stderr);
  assert.match(rel.stdout, /Run P: every member is released — its own pause is LIFTED, but it is still PAUSED by run L — lift that one: orchestra run resume --run L/);
  assert.doesNotMatch(rel.stdout, /ACTIVE/);
});

test('`run status` of a RESUMING run whose host trap had NOT finished says the trap is not owed any more (never "NOT FINISHED … completed at the next launch")', needsBuild, (t) => {
  const h = path.join(ROOT, `h${n++}`);
  mkdirSync(h, { recursive: true });
  t.after(() => rmSync(h, { recursive: true, force: true }));
  const db = bus.openBus(path.join(h, 'bus.sqlite'));
  try { busRuns.startRun(db, { id: 'Q', kind: 'mission', coordinator: 'Q' }, ON); } finally { db.close(); }
  assert.equal(cli(h, ['run', 'pause', '--hard', '--run', 'Q'], 'Q').code, 0);
  assert.match(cli(h, ['run', 'status', '--run', 'Q'], 'Q').stdout, /Host trap: NOT FINISHED/, 'control: paused, trap owed');
  assert.equal(cli(h, ['run', 'resume', '--run', 'Q'], 'Q').code, 0);
  const st = cli(h, ['run', 'status', '--run', 'Q'], 'Q').stdout;
  assert.match(st, /Host trap: not owed any more — the Reprise began before it finished/);
  assert.doesNotMatch(st, /NOT FINISHED/);
});

test('M1 the LEAD\'s `release --all` (the path the host\'s own message recommends) releases only the LEAD\'s OWN run: the OPS\'s workers stay BLOCKED and are named as BELOW; an explicit id releases them', needsBuild, (t) => {
  const h = pausedFleet(t);
  assert.equal(cli(h, ['run', 'resume', '--run', 'L'], 'L').code, 0);
  const all = cli(h, ['run', 'release', '--all', '--run', 'L'], 'L');
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /2 member\(s\) belong to a run BELOW yours — `--all` leaves them to their own coordinator \(or release them by explicit id\): o1, o2/);
  assert.doesNotMatch(all.stdout, /Nothing left for you to release/);
  const unreleased = () => read(h, (db) => readRoster(db, 'L', readCarrierColumns(db, 'L')!.pausedAt!).filter((m) => m.releasedAt === null).map((m) => m.wsId).sort());
  assert.deepEqual(unreleased(), ['o1', 'o2'], 'AC1: the workers still wait for THEIR OPS');
  const byId = cli(h, ['run', 'release', 'o1', 'o2', '--run', 'L'], 'L');
  assert.equal(byId.code, 0, byId.stderr);
  assert.match(byId.stdout, /Released 2 member\(s\): o1, o2/);
});

test('a PARTIAL release is reported before the failure: `release o1 ghost` releases o1, says so, then fails on the unknown id (rc≠0)', needsBuild, (t) => {
  const h = pausedFleet(t);
  assert.equal(cli(h, ['run', 'resume', '--run', 'L'], 'L').code, 0);
  const r = cli(h, ['run', 'release', 'o1', 'ghost-ws', '--run', 'O'], 'O');
  assert.notEqual(r.code, 0);
  assert.match(r.stdout, /Released 1 member\(s\): o1/, 'what WAS released is committed — it is printed even though the verb fails');
  assert.match(r.stderr, /no member of the Reprise of run L matches: ghost-ws/);
  assert.equal(read(h, (db) => readRoster(db, 'L', readCarrierColumns(db, 'L')!.pausedAt!).find((m) => m.wsId === 'o1')!.releasedAt) !== null, true);
  // both failures are reported: a refusal must not be hidden by an unknown id (and vice versa)
  const both = cli(h, ['run', 'release', 'o2', 'ghost-ws', '--run', 'O'], 'o1'); // o1 is a worker: it may release nobody
  assert.notEqual(both.code, 0);
  assert.match(both.stderr, /may not release them/);
  assert.match(both.stderr, /no member of the Reprise of run L matches: ghost-ws/);
});

// ── review r2 (R2r2-m2 / R2r2-m3): the CLI reads the LIVE tree from the app's store.json ─────────────────────────────────────────

const STORE_WS = [
  { id: 'L', kind: 'orchestrator' },
  { id: 'O', kind: 'orchestrator', parentId: 'L' },
  { id: 'o1', parentId: 'O' },
  { id: 'o2', parentId: 'O' },
];
const writeStore = (h: string, content: unknown) => {
  const f = path.join(h, 'userData', 'orchestra', 'store.json');
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, typeof content === 'string' ? content : JSON.stringify({ workspaces: content }));
};
/** L mission, O created TOP-LEVEL (no `parent_run_id`, write-once) and re-parented under L by the store later; the host trap finished. */
function reparentedFleet(t: { after: (fn: () => void) => void }, storeAtResume: unknown): string {
  const h = path.join(ROOT, `rp${n++}`);
  mkdirSync(h, { recursive: true });
  t.after(() => rmSync(h, { recursive: true, force: true }));
  writeStore(h, STORE_WS);
  const db = bus.openBus(path.join(h, 'bus.sqlite'));
  try {
    busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'L' }, ON);
    busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'O' }, ON);
  } finally {
    db.close();
  }
  assert.equal(cli(h, ['run', 'pause', '--hard', '--run', 'L'], 'L').code, 0);
  const d2 = bus.openBus(path.join(h, 'bus.sqlite'));
  try {
    const pausedAt = getRunPause(d2, 'L')!.pausedAt;
    for (const [ws, run] of [['L', 'L'], ['O', 'O'], ['o1', 'O'], ['o2', 'O']] as const) {
      insertBilan(d2, { runId: 'L', wsId: ws, pausedAt, activity: { surface: 'sdk', memberRun: run, branch: `br-${ws}`, head: `h-${ws}` }, snapshotRef: `refs/orchestra/pause/L/${ws}/1`, dirty: false, killed: { killed: [], survivors: [], refused: [], spared: [] }, error: null });
    }
    d2.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(pausedAt + 1, 'L');
  } finally {
    d2.close();
  }
  writeStore(h, storeAtResume);
  return h;
}
const rosterOf = (h: string) => read(h, (db) => readRoster(db, 'L', readCarrierColumns(db, 'L')!.pausedAt!).map((r) => `${r.wsId}:${r.role}:${r.releasedBy ?? '-'}`).sort());

test('R2r2-m3 CLI live tree (store.json): a re-parented OPS is a host-RELEASED coordinator at `run resume`, releases its own workers with --all, and its own run shows the Reprise', needsBuild, (t) => {
  const h = reparentedFleet(t, STORE_WS);
  const r = cli(h, ['run', 'resume', '--run', 'L'], 'L');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(rosterOf(h), ['L:coordinator:host', 'O:coordinator:host', 'o1:worker:-', 'o2:worker:-'], 'O is a coordinator the HOST released (the bus tree alone would call it a worker)');
  assert.equal(read(h, (db) => (db.prepare("SELECT COUNT(*) AS c FROM messages WHERE kind = 'reprise' AND recipient = 'O' AND sender = 'host'").get() as { c: number }).c), 1, 'O got its wave\'s Bilan row');
  // R2r2-m2b read side: from the re-parented OPS's own run the Reprise is visible (the bus walk from O alone ends at O)
  const st = cli(h, ['run', 'status', '--run', 'O'], 'O').stdout;
  assert.match(st, /^reprise: RESUMING \(carrier L\) — 2\/4 libérés/m, st);
  assert.match(st, /^reprise: BLOQUÉS .* : o1, o2$/m, st);
  const all = cli(h, ['run', 'release', '--all', '--run', 'O'], 'O');
  assert.equal(all.code, 0, all.stderr + all.stdout);
  assert.match(all.stdout, /Released 2 member\(s\): o1, o2/);
  assert.equal(read(h, (db) => readCarrierColumns(db, 'L')!.pausedAt), null, 'the run is ACTIVE again');
});

test('R2r2-m3 CLI: `run resume` survives an UNREADABLE store.json (absent / corrupt / a null entry) — the Reprise begins from the bus run tree, a re-parented OPS is a blocked worker the host sweep fixes later', needsBuild, (t) => {
  for (const [label, store] of [['absent', null], ['corrupt', '{"workspaces":[{"id":"L"'], ['null entry', '{"workspaces":[null,{"id":"L","kind":"orchestrator"}]}']] as const) {
    const h = reparentedFleet(t, STORE_WS);
    if (store === null) rmSync(path.join(h, 'userData', 'orchestra', 'store.json'), { force: true });
    else writeStore(h, store);
    const r = cli(h, ['run', 'resume', '--run', 'L'], 'L');
    assert.equal(r.code, 0, `${label}: ${r.stderr}`);
    assert.match(r.stdout, /^Run L: REPRISE STARTED/, label);
    assert.deepEqual(rosterOf(h), ['L:coordinator:host', 'O:worker:-', 'o1:worker:-', 'o2:worker:-'], `${label}: O is a blocked worker (the live tree could not say otherwise)`);
  }
});
