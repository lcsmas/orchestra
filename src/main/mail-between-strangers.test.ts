// #436 — two agents with no common ancestry write to each other. Drives the BUILT CLI (`send`, `ask`, `gate open`, `check`, `ack`) against a REAL bus
// and a REAL workspace store (store.json, no app), then reads what the bus holds (the rows) and what the wake sweep hands each reader (turns delivered at
// the wake seam — never an internal helper's return). Mutants: scripts/mail-strangers-mutants.mjs (`pnpm run test:mail-strangers-mutants`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBus, type BusDb } from './bus.ts';
import { startRun, busSwitch } from './bus-runs.ts';
import {
  sweepBusWake,
  readPendingReaders,
  setWakeRoster,
  setWakeDeliver,
  __setBusReaderForTests,
  __resetBusWakeForTests,
  __freezeSwitchForTests,
} from './bus-wake.ts';
import { wakeOrderRuns } from '../shared/bus-wake.ts';
import { runIdOf } from '../shared/run-position.ts';
import { offlineWaveNodes } from '../cli/index.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: fs.existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };
const LIVE: BusSwitches = { ...DEFAULT_BUS_SWITCHES, delivery: true, wake: true, askGate: true, liveness: true, pause: true };

const id = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = id(1); // top-level agent, mission A
const B = id(2); // top-level agent, mission B — shares no ancestry with A
const X = id(3); // top-level outsider
const LEAD = id(4); // an existing fleet: LEAD → OPS → M ; LEAD → OPS2 → M2
const OPS = id(5);
const M = id(6);
const OPS2 = id(7);
const M2 = id(8);
const C = id(9); // top-level whose mission row is MISSING (a run the app has not started)

interface World { home: string; db: BusDb; storeFile: string }

function world(t: { after: (fn: () => void) => void }): World {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'orch-436-'));
  const db = openBus(path.join(home, 'bus.sqlite'));
  t.after(() => { db.close(); __resetBusWakeForTests(); fs.rmSync(home, { recursive: true, force: true }); });
  const dir = path.join(home, 'userData', 'orchestra');
  fs.mkdirSync(dir, { recursive: true });
  const storeFile = path.join(dir, 'store.json');
  const rec = (wid: string, extra: Record<string, unknown> = {}) => ({ id: wid, name: `ws-${wid.slice(-2)}`, kind: 'worktree', ...extra });
  fs.writeFileSync(storeFile, JSON.stringify({
    workspaces: [
      rec(A), rec(B), rec(X), rec(C),
      rec(LEAD, { kind: 'orchestrator' }),
      rec(OPS, { parentId: LEAD, canOrchestrate: true }), rec(M, { parentId: OPS }),
      rec(OPS2, { parentId: LEAD, canOrchestrate: true }), rec(M2, { parentId: OPS2 }),
    ],
  }));
  for (const m of [A, B, X, LEAD]) startRun(db, { id: m, kind: 'mission', coordinator: m }, LIVE);
  startRun(db, { id: OPS, kind: 'vague', coordinator: OPS, parentRunId: LEAD }, LIVE);
  startRun(db, { id: OPS2, kind: 'vague', coordinator: OPS2, parentRunId: LEAD }, LIVE);
  return { home, db, storeFile };
}

interface Out { code: number; stdout: string; stderr: string }
/** `ws` types the verb; its env names its own run (what the host answers for it) — the recipient's run is resolved from the store by the CLI. */
function cli(w: World, ws: string, args: string[]): Out {
  const nodes = offlineWaveNodes(w.storeFile);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: w.home, ORCHESTRA_HOME: w.home, ORCHESTRA_SOCK: path.join(w.home, 'dead.sock'), ORCHESTRA_WS_ID: ws, ORCHESTRA_RUN_ID: runIdOf(nodes.get(ws)!, (i) => nodes.get(i)) };
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }), stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
const seqOf = (o: Out): number => { assert.equal(o.code, 0, o.stderr); return Number(o.stdout.split('\n')[0]); };
type Row = { run_id: string; sender: string; recipient: string | null; kind: string; body: string; thread_id: string | null };
const rows = (w: World): Row[] => w.db.prepare('SELECT run_id, sender, recipient, kind, body, thread_id FROM messages ORDER BY sequence').all() as Row[];
const count = (w: World, table: string): number => (w.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

/** The host's wake roster, derived like the app does: every workspace is a reader in the run `runIdOf` places it in; the wake switch is each run's FROZEN flag. */
function wakeRig(w: World): { reader: string; text: string }[] {
  const wakes: { reader: string; text: string }[] = [];
  const nodes = offlineWaveNodes(w.storeFile);
  __resetBusWakeForTests();
  __setBusReaderForTests(() => w.db);
  setWakeRoster(() => [...nodes.values()].map((n) => ({ reader: n.id, wakeable: true, runId: runIdOf(n, (i) => nodes.get(i)) })));
  setWakeDeliver(async (reader, text) => { wakes.push({ reader, text }); return true; });
  __freezeSwitchForTests((runId) => busSwitch(w.db, runId, 'wake'), (runId) => busSwitch(w.db, runId, 'ask_gate'));
  return wakes;
}
const wokenFor = (wakes: { reader: string }[], r: string): number => wakes.filter((x) => x.reader === r).length;

test('#436 two parentless agents: a status is filed in the RECIPIENT\'s run and wakes it; the reply comes back the same way', needsBuild, async (t) => {
  const w = world(t);
  const wakes = wakeRig(w);
  await sweepBusWake();
  assert.equal(wakes.length, 0, 'control: with no mail the sweep wakes nobody (the instrument can say "no wake")');

  const seq = seqOf(cli(w, A, ['send', '--type', 'status', '--to', B, 'hello B']));
  assert.deepEqual(rows(w).map((r) => [r.run_id, r.sender, r.recipient, r.kind, r.body]), [[B, A, B, 'status', 'hello B']], 'filed in B\'s run, not A\'s');
  await sweepBusWake();
  assert.equal(wokenFor(wakes, B), 1, 'B is woken');
  assert.equal(wokenFor(wakes, A), 0, 'the sender is not');
  assert.deepEqual(wakeOrderRuns(wakes.find((x) => x.reader === B)!.text), [B], 'the order names B\'s run');
  const chk = cli(w, B, ['check']);
  assert.equal(chk.code, 0, chk.stderr);
  assert.deepEqual((JSON.parse(chk.stdout).messages as { sender: string; body: string; sequence: number }[]).map((m) => [m.sender, m.body, m.sequence]), [[A, 'hello B', seq]], 'B reads it with a plain check');

  seqOf(cli(w, B, ['send', '--type', 'status', '--to', A, 'hello A'])); // no --run gymnastics either way
  assert.equal(rows(w)[1].run_id, A, 'the reply is filed in A\'s run');
  await sweepBusWake();
  assert.equal(wokenFor(wakes, A), 1, 'A is woken by the reply');
});

test('#436 an ask between two parentless agents wakes the recipient; the cross-run answer clears the ask (no endless re-wake)', needsBuild, async (t) => {
  const w = world(t);
  const wakes = wakeRig(w);
  const q = seqOf(cli(w, A, ['ask', '--to', B, 'ship or hold?']));
  assert.deepEqual(rows(w).map((r) => [r.run_id, r.kind, r.recipient]), [[B, 'question', B]], 'the question is filed in B\'s run');
  await sweepBusWake();
  assert.equal(wokenFor(wakes, B), 1, 'B is woken for the ask');
  const lot = JSON.parse(cli(w, B, ['check']).stdout) as { lot: number };
  assert.equal(cli(w, B, ['ack', String(lot.lot)]).code, 0);
  const pending = () => readPendingReaders(w.db, [{ reader: B, runId: B }])[0];
  assert.equal(pending().pending, true, 'control: acked but UNANSWERED — B stays pending (the re-wake-until-answered arm is live across the two runs)');

  seqOf(cli(w, B, ['send', '--type', 'status', '--to', A, '--thread', String(q), 'ship']));
  const answer = rows(w)[1];
  assert.deepEqual([answer.run_id, answer.thread_id, answer.recipient], [A, String(q), A], 'the answer sits in the ASKER\'s run (the only one A reads)');
  assert.equal(pending().pending, false, 'the answer clears the ask although it sits in another run');
  await sweepBusWake();
  assert.equal(wokenFor(wakes, A), 1, 'A is woken with the answer');
  assert.equal(wokenFor(wakes, B), 1, 'B is not woken again for an answered ask');
});

test('#436 an outside agent (and a sibling vague\'s member) writes to a member of a vague and wakes it', needsBuild, async (t) => {
  const w = world(t);
  const wakes = wakeRig(w);
  seqOf(cli(w, X, ['send', '--type', 'status', '--to', M, 'from outside']));
  seqOf(cli(w, M2, ['ask', '--to', M, 'from the sibling vague']));
  assert.deepEqual(rows(w).map((r) => [r.run_id, r.sender, r.kind]), [[OPS, X, 'status'], [OPS, M2, 'question']], 'both filed in M\'s vague (OPS run)');
  await sweepBusWake();
  assert.equal(wokenFor(wakes, M), 1, 'M is woken');
  assert.deepEqual(wakeOrderRuns(wakes.find((x) => x.reader === M)!.text), [OPS], 'the order names the vague run');
  const got = JSON.parse(cli(w, M, ['check']).stdout) as { messages: { sender: string }[] };
  assert.deepEqual(got.messages.map((m) => m.sender), [X, M2]);
});

test('#436 a dispatch or a decision gate to an agent outside the sender\'s related runs is refused with the reason; so is any other kind', needsBuild, (t) => {
  const w = world(t);
  const refused = (o: Out, re: RegExp) => { assert.equal(o.code, 1, `expected a refusal, got rc ${o.code}: ${o.stdout}`); assert.match(o.stderr, re); };
  refused(cli(w, X, ['send', '--type', 'dispatch', '--to', M, 'do this']), /a dispatch to .*outside your related runs.*only a coordinator gives or withdraws the right to act/is);
  refused(cli(w, M2, ['send', '--type', 'dispatch', '--to', M, 'do this']), /outside your related runs/); // sibling vagues
  refused(cli(w, A, ['send', '--type', 'dispatch', '--to', B, 'do this']), /only a coordinator gives or withdraws the right to act/i);
  refused(cli(w, X, ['gate', 'open', '--to', M, 'may I?']), /a decision gate to .*outside your related runs.*right to act/is);
  refused(cli(w, X, ['send', '--type', 'escalation', '--to', M, 'urgent']), /only a status or an ask reaches an agent outside/i);
  refused(cli(w, X, ['send', '--type', 'worker_done', '--to', M, 'done']), /only a status or an ask reaches an agent outside/i);
  assert.equal(rows(w).length, 0, 'nothing was written');
  assert.equal(count(w, 'decision_gates'), 0, 'no gate row');
  assert.equal(count(w, 'dispatch_capabilities'), 0, 'no capability minted');
  // The refusal names the way through, and that way works.
  assert.equal(cli(w, X, ['send', '--type', 'status', '--to', M, 'status instead']).code, 0);
});

test('#436 a recipient whose run has no row yet is refused loudly (nothing would wake it)', needsBuild, (t) => {
  const w = world(t);
  const r = cli(w, A, ['send', '--type', 'status', '--to', C, 'anyone?']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /has no row on the bus yet/);
  assert.equal(rows(w).length, 0);
});

test('#436 inside an existing fleet mail is unchanged: filed in the SENDER\'s run, dispatch and gate to related agents still work', needsBuild, async (t) => {
  const w = world(t);
  const wakes = wakeRig(w);
  seqOf(cli(w, OPS, ['send', '--type', 'status', '--to', LEAD, 'digest']));
  const d = cli(w, LEAD, ['send', '--type', 'dispatch', '--to', OPS, 'brief']);
  assert.equal(d.code, 0, d.stderr);
  assert.equal(d.stdout.trim().split('\n').length, 2, 'a dispatch still prints its sequence and mints its capability token');
  seqOf(cli(w, M, ['send', '--type', 'status', '--to', OPS, 'progress']));
  const g = cli(w, LEAD, ['gate', 'open', '--to', OPS, 'rule on this']);
  assert.equal(g.code, 0, g.stderr);
  assert.deepEqual(rows(w).map((r) => [r.run_id, r.sender, r.kind]), [[OPS, OPS, 'status'], [LEAD, LEAD, 'dispatch'], [OPS, M, 'status']], 'each row sits in its sender\'s run');
  assert.equal(count(w, 'dispatch_capabilities'), 1);
  await sweepBusWake();
  assert.ok(wokenFor(wakes, LEAD) >= 1 && wokenFor(wakes, OPS) >= 1, 'the related readers are woken as before');
});

test('#436 inside a fleet "answered" is unchanged: only a reply in the question\'s own run clears an ask (a related run does not; a run outside the reader\'s related set does)', needsBuild, (t) => {
  const w = world(t);
  const q = seqOf(cli(w, LEAD, ['ask', '--to', OPS, 'which branch?']));
  assert.equal(rows(w)[0].run_id, LEAD, 'in-fleet: filed in the sender\'s run');
  const lot = JSON.parse(cli(w, OPS, ['check', '--run', LEAD]).stdout) as { lot: number };
  assert.equal(cli(w, OPS, ['ack', '--run', LEAD, String(lot.lot)]).code, 0);
  const pending = () => readPendingReaders(w.db, [{ reader: OPS, runId: OPS }])[0].pending;
  assert.equal(pending(), true, 'control: acked, unanswered');
  seqOf(cli(w, OPS, ['send', '--type', 'status', '--to', LEAD, '--thread', String(q), 'main'])); // filed in OPS\'s run — related, not the question's
  assert.equal(pending(), true, 'a reply in a RELATED run other than the question\'s does not clear it — as before #436');
  seqOf(cli(w, OPS, ['send', '--type', 'status', '--run', LEAD, '--to', LEAD, '--thread', String(q), 'main']));
  assert.equal(pending(), false, 'a reply in the question\'s own run clears it — as before #436');
});

test('#436 `--run` / `--as` cannot move the judgement: a stranger claiming the recipient\'s (or an ancestor) run still cannot dispatch or open a gate (review M1)', needsBuild, (t) => {
  const w = world(t);
  const d = cli(w, LEAD, ['send', '--type', 'dispatch', '--to', OPS, 'real brief']);
  assert.equal(d.code, 0, d.stderr);
  const base = rows(w).length;
  const caps = () => w.db.prepare("SELECT state FROM dispatch_capabilities ORDER BY dispatch_seq").all() as { state: string }[];
  assert.deepEqual(caps().map((c) => c.state), ['active'], 'control: LEAD\'s capability is active');
  const refused = (o: Out) => { assert.equal(o.code, 1, `expected a refusal, got rc ${o.code}: ${o.stdout}`); assert.match(o.stderr, /outside your related runs/); };
  refused(cli(w, X, ['send', '--run', LEAD, '--type', 'dispatch', '--to', OPS, 'hijack']));   // an ancestor run of the recipient
  refused(cli(w, X, ['send', '--run', OPS, '--type', 'dispatch', '--to', OPS, 'hijack']));    // the recipient's own run
  refused(cli(w, X, ['send', '--as', LEAD, '--type', 'dispatch', '--to', OPS, 'hijack']));    // a spoofed sender handle
  refused(cli(w, X, ['gate', 'open', '--run', OPS, '--to', M, 'hijack?']));
  assert.equal(rows(w).length, base, 'nothing written');
  assert.deepEqual(caps().map((c) => c.state), ['active'], 'LEAD\'s capability was not superseded');
  assert.equal(count(w, 'decision_gates'), 0);
  // Controls: a related sender keeps using --run as before (OPS answering into the LEAD run), and a stranger's `--run` status still lands in the recipient\'s run.
  assert.equal(cli(w, OPS, ['send', '--run', LEAD, '--type', 'status', '--to', LEAD, 'ok']).code, 0);
  assert.equal(cli(w, X, ['send', '--run', OPS, '--type', 'status', '--to', M, 'fyi']).code, 0);
});
