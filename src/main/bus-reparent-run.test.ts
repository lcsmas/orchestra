// #439 — attach and detach under ANY agent. Drives the BUILT CLI (`send`, `check`, `ack`) against a REAL bus.sqlite and a REAL store.json (the CLI's
// own offline reader), plus the REAL shipped functions the host composes on a move: `decideAttachTarget` (the refusals), `ownerToMark` (attach marks
// the new parent an owner), `rederiveRunOnBus` (row + pointer + mail; the same function `reconcileRunAfterReparent` calls for EVERY moved agent, noop
// branch included). The store write of the move is composed as `dispatchAttachRequest` does it (parentId + the link-only ownership clear). No app.
// Mutants: scripts/attach-any-agent-mutants.mjs (`pnpm run test:attach-any-agent-mutants`).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openBus, type BusDb } from './bus.ts';
import { getRun, refreezeRun, startRun } from './bus-runs.ts';
import { computeAnchorInfo, maybeStartRunAtAnchor, ownerToMark, runAnchorProbe, startRunsForParentless, type BusRunAnchorDeps } from './bus-run-anchor.ts';
import { forwardUnreadMail, rederiveRunOnBus, relatedRunsOf, repointRun, runClosedAt } from './bus-reparent-run.ts';
import { offlineWaveNodes } from '../cli/index.ts';
import { coordinates, runIdOf } from '../shared/run-position.ts';
import { decideAttachTarget } from '../shared/attach-target.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: fs.existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };
const LIVE: BusSwitches = { ...DEFAULT_BUS_SWITCHES, delivery: true, wake: true, askGate: true, liveness: true, pause: true };

const P = 'dddddddd-0000-4000-8000-000000000001'; // a never-promoted top-level agent
const M = 'dddddddd-0000-4000-8000-000000000002'; // its plain child
const Q = 'dddddddd-0000-4000-8000-000000000003'; // ANOTHER never-promoted top-level agent: the attach target
const X = 'dddddddd-0000-4000-8000-000000000004'; // a top-level agent that has / had a child
const C = 'dddddddd-0000-4000-8000-000000000005'; // X's child
const G = 'dddddddd-0000-4000-8000-000000000006'; // C's child (a subtree member)

interface Rec { id: string; name: string; kind: string; parentId?: string; ownsRun?: boolean; archived?: boolean }
interface World { home: string; db: BusDb; storeFile: string; deps: BusRunAnchorDeps; warns: string[] }
type After = { after: (fn: () => void) => void };

function world(t: After, recs: Array<Omit<Rec, 'name'>>): World {
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'orch-439-'));
  const db = openBus(path.join(home, 'bus.sqlite'));
  t.after(() => {
    db.close();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const dir = path.join(home, 'userData', 'orchestra');
  fs.mkdirSync(dir, { recursive: true });
  const storeFile = path.join(dir, 'store.json');
  fs.writeFileSync(storeFile, JSON.stringify({ workspaces: recs.map((r) => ({ ...r, name: `ws-${r.id.slice(-2)}` })) }));
  const warns: string[] = [];
  const deps: BusRunAnchorDeps = { getBus: () => db, startRun, getRun, refreezeRun, getLiveSwitches: () => LIVE, warn: (m) => warns.push(m) };
  return { home, db, storeFile, deps, warns };
}

const nodes = (w: World) => offlineWaveNodes(w.storeFile);
const lookup = (w: World) => { const n = nodes(w); return (id: string) => n.get(id); };
const runOf = (w: World, id: string): string => runIdOf(nodes(w).get(id)!, lookup(w));
/** The raw store record (carries `archived`, which the CLI's offline node shape drops) — what `store.getWorkspace` answers in the host. */
const rawLookup = (w: World) => { const recs = (JSON.parse(fs.readFileSync(w.storeFile, 'utf8')) as { workspaces: Rec[] }).workspaces; return (id: string) => recs.find((r) => r.id === id); };
const edit = (w: World, fn: (recs: Rec[]) => void): void => {
  const raw = JSON.parse(fs.readFileSync(w.storeFile, 'utf8')) as { workspaces: Rec[] };
  fn(raw.workspaces);
  fs.writeFileSync(w.storeFile, JSON.stringify(raw));
};
const runRows = (w: World) => w.db.prepare('SELECT id, kind, coordinator, parent_run_id AS parent, closed_at AS closed FROM runs ORDER BY rowid').all() as Array<{ id: string; kind: string; coordinator: string; parent: string | null; closed: number | null }>;
/** What #437's `closeRunsCoordinatedBy` writes: `runs.closed_at` (kept as raw SQL so this file does not depend on that branch). */
const closeRunOf = (w: World, coordinator: string): void => { w.db.prepare('UPDATE runs SET closed_at = ? WHERE coordinator = ? AND closed_at IS NULL').run(Date.now(), coordinator); };
const mailRows = (w: World, run: string, to: string) => w.db.prepare('SELECT sequence, sender, kind, body FROM messages WHERE run_id = ? AND recipient = ? ORDER BY sequence').all(run, to) as Array<{ sequence: number; sender: string; kind: string; body: string }>;

/** The app-start / creation mission of every top-level workspace (#433). */
function birth(w: World): void {
  const n = nodes(w);
  startRunsForParentless(w.deps, [...n.values()], (id) => n.get(id));
}
/** A first spawn as `createWorkspace` composes it: the parent records `ownsRun`, then the child's anchor row starts. */
function spawn(w: World, child: string): void {
  edit(w, (recs) => {
    const n = nodes(w);
    const owner = ownerToMark(n.get(child)!, (id) => n.get(id));
    if (owner) recs.find((r) => r.id === owner.id)!.ownsRun = true;
  });
  maybeStartRunAtAnchor(w.deps, computeAnchorInfo(nodes(w).get(child)!, lookup(w), runAnchorProbe(w.deps)));
}

/** What `reconcileRunAfterReparent` snapshots BEFORE the move: every subtree agent's related runs. */
function snapshot(w: World, ids: string[]): Map<string, string[]> {
  return new Map(ids.map((id) => [id, relatedRunsOf(w.db, runOf(w, id))]));
}
interface Move { verdict: { ok: boolean; error?: string }; reports: Map<string, ReturnType<typeof rederiveRunOnBus>> }
/** attach (`parentId` set) / detach (`null`) as `dispatchAttachRequest` + `reconcileRunAfterReparent` compose them, for the moved agent + `subtree`. */
function move(w: World, id: string, parentId: string | null, subtree: string[] = []): Move {
  const ids = [id, ...subtree];
  const before = snapshot(w, ids);
  if (parentId) {
    const verdict = decideAttachTarget({ id, parentId, lookup: rawLookup(w), targetRunClosed: runClosedAt(w.db, parentId) != null });
    if (!verdict.ok) return { verdict, reports: new Map() };
  }
  edit(w, (recs) => {
    const rec = recs.find((r) => r.id === id)!;
    const childless = !recs.some((r) => r.parentId === id);
    if (parentId) {
      // the link-only ownership clear of dispatchAttachRequest (#434)
      if (rec.ownsRun === true && rec.kind !== 'orchestrator' && childless) delete rec.ownsRun;
      rec.parentId = parentId;
    } else delete rec.parentId;
  });
  if (parentId) edit(w, (recs) => { const o = ownerToMark(nodes(w).get(id)!, (x) => nodes(w).get(x)); if (o) recs.find((r) => r.id === o.id)!.ownsRun = true; }); // ensureParentOwnsRun
  const reports = new Map<string, ReturnType<typeof rederiveRunOnBus>>();
  for (const aid of ids) reports.set(aid, rederiveRunOnBus(w.deps, w.db, nodes(w).get(aid)!, lookup(w), before.get(aid)));
  return { verdict: { ok: true }, reports };
}

interface Out { code: number; stdout: string; stderr: string }
/** The BUILT CLI as `ws`, `$ORCHESTRA_RUN_ID` = what the host answers for it NOW (`runIdOf`). Allowlist env; the live socket never leaks. */
function cli(w: World, ws: string, args: string[]): Out {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: w.home, ORCHESTRA_HOME: w.home, ORCHESTRA_SOCK: path.join(w.home, 'dead.sock'), ORCHESTRA_WS_ID: ws, ORCHESTRA_RUN_ID: runOf(w, ws) };
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }), stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
type Lot = { count: number; replay: boolean; lot: number | null; messages: Array<{ sender: string; body: string; kind: string }> };
const check = (w: World, ws: string, extra: string[] = []): Lot => JSON.parse(cli(w, ws, ['check', ...extra]).stdout || '{"count":-1}') as Lot;
const bodies = (l: Lot): string => l.messages.map((m) => m.body).join('|');

// ── 1. attach under a NEVER-PROMOTED agent ─────────────────────────────────────────────────────────────────────────────
test('#439 attach under a never-promoted, never-spawned agent is accepted; the moved agent joins ITS run and can send at once', needsBuild, (t) => {
  const w = world(t, [{ id: P, kind: 'worktree' }, { id: Q, kind: 'worktree' }]);
  birth(w);
  assert.equal(coordinates(nodes(w).get(Q)!), true, 'Q is a top-level agent: it owns its mission, it is NOT promoted');
  // failing control: P's own run is P's; a send into Q's run as P is not P's address yet
  assert.equal(runOf(w, P), P);
  const m = move(w, P, Q);
  assert.equal(m.verdict.ok, true, 'no "must be an orchestrator" refusal');
  assert.equal(runOf(w, P), Q, 'P is a member of Q\'s run');
  assert.equal(cli(w, P, ['send', '--type', 'status', '--to', Q, 'attached and talking']).code, 0, 'the moved agent can send in its new run');
  assert.equal(bodies(check(w, Q)), 'attached and talking', 'and Q receives it');
});

// ── 2. detach: the agent becomes the LEAD of a mission of its own, immediately ──────────────────────────────────────────
test('#439 a detached agent has a mission of its own AT ONCE (no session start): it can send, and its mission row is a mission', needsBuild, (t) => {
  const w = world(t, [{ id: P, kind: 'worktree' }, { id: M, kind: 'worktree', parentId: P }]);
  birth(w);
  spawn(w, M);
  assert.equal(getRun(w.db, M), null, 'M owns nothing while it is a plain member');
  assert.equal(cli(w, M, ['send', '--type', 'status', '--to', P, 'member report']).code, 0, 'a member can send in its parent\'s run');
  // failing control (the unfixed state): the store moved, nothing re-derived → no row for the run the host now names
  const control = world(t, [{ id: P, kind: 'worktree' }, { id: M, kind: 'worktree', parentId: P }]);
  birth(control);
  edit(control, (recs) => { delete recs.find((r) => r.id === M)!.parentId; });
  assert.equal(runOf(control, M), M);
  assert.equal(getRun(control.db, M), null, 'unfixed: no run row exists for the detached agent');
  assert.notEqual(cli(control, M, ['send', '--type', 'status', '--to', M, 'x']).code, 0, 'unfixed: it cannot send');

  const mv = move(w, M, null);
  assert.equal(mv.reports.get(M)!.startedRow, true);
  const row = getRun(w.db, M)!;
  assert.deepEqual([row.kind, row.parent_run_id, row.coordinator, row.closed_at], ['mission', null, M, null], 'its own, open mission');
  assert.equal(cli(w, M, ['send', '--type', 'status', '--to', M, 'now a lead']).code, 0, 'the running detached agent can send at once');
  assert.equal(bodies(check(w, M)), 'now a lead');
});

test('#439 (#433 M1) the NOOP branch too: a live agent whose run id does not change when it leaves a dangling parent still gets its row', needsBuild, (t) => {
  const w = world(t, [{ id: M, kind: 'worktree', parentId: P }]); // P was deleted while the app ran: M's run id is M before AND after the detach
  assert.equal(runOf(w, M), M);
  assert.equal(getRun(w.db, M), null, 'no row (the sweep ran at app start, before the parent vanished)');
  const mv = move(w, M, null);
  assert.equal(mv.reports.get(M)!.home, M);
  assert.ok(getRun(w.db, M), 'the row exists although the anchor did not change');
  assert.equal(cli(w, M, ['send', '--type', 'status', '--to', M, 'alive']).code, 0);
});

// ── 3. unread mail follows, exactly once ───────────────────────────────────────────────────────────────────────────────
test('#439 unread mail before a DETACH is delivered after it, once; mail already acked is not; a broadcast of the run left stays', needsBuild, (t) => {
  const w = world(t, [{ id: P, kind: 'worktree' }, { id: M, kind: 'worktree', parentId: P }]);
  birth(w);
  spawn(w, M);
  assert.equal(cli(w, P, ['send', '--type', 'status', '--to', M, 'old, acked']).code, 0);
  const first = check(w, M);
  assert.equal(cli(w, M, ['ack', String(first.lot)]).code, 0);
  assert.equal(cli(w, P, ['send', '--type', 'status', '--to', M, 'unread one']).code, 0);
  assert.equal(cli(w, P, ['send', '--type', 'status', '--to', M, 'unread two']).code, 0);
  assert.equal(cli(w, P, ['send', '--type', 'status', 'to the whole run']).code, 0, 'a broadcast of P\'s run');
  assert.equal(mailRows(w, P, M).length, 3);

  move(w, M, null);
  const after = check(w, M);
  assert.equal(bodies(after), 'unread one|unread two', 'exactly the two unread directed messages, in order — not the acked one, not the broadcast');
  assert.equal(cli(w, M, ['ack', String(after.lot)]).code, 0);
  assert.equal(check(w, M).count, 0, 'delivered ONCE: acknowledged, nothing left');
  // the source run holds nothing pending for M any more (cursor advanced, no outstanding lot)
  assert.equal(bodies(check(w, M, ['--run', P])), 'to the whole run', 'the run it left keeps only its own broadcast (run-wide mail does not follow)');
  assert.equal(runClosedAt(w.db, P), null, 'the run it left is untouched');
  // the move is idempotent: a second pass re-delivers nothing
  assert.equal(forwardUnreadMail(w.db, M, [P], M).forwarded, 0);
});

test('#439 a lot taken but NOT acked before the move counts as unread: delivered once after, the old lot is closed (no replay in the run left)', needsBuild, (t) => {
  const w = world(t, [{ id: P, kind: 'worktree' }, { id: M, kind: 'worktree', parentId: P }]);
  birth(w);
  spawn(w, M);
  assert.equal(cli(w, P, ['send', '--type', 'status', '--to', M, 'taken, never acked']).code, 0);
  const taken = check(w, M);
  assert.equal(taken.count, 1);
  move(w, M, null);
  const after = check(w, M);
  assert.equal(bodies(after), 'taken, never acked', 'redelivered in its new run (unacked = unread)');
  assert.equal(cli(w, M, ['ack', String(after.lot)]).code, 0);
  assert.equal(check(w, M, ['--run', P]).count, 0, 'the old outstanding lot is closed: no replay when it looks at the run it left');
  assert.equal(check(w, M).count, 0);
});

test('#439 mail follows an ATTACH too: the unread mail an agent holds in its old parent\'s run is delivered once in the new parent\'s run', needsBuild, (t) => {
  const w = world(t, [{ id: P, kind: 'worktree' }, { id: M, kind: 'worktree', parentId: P }, { id: Q, kind: 'worktree' }]);
  birth(w);
  spawn(w, M);
  assert.equal(cli(w, P, ['send', '--type', 'status', '--to', M, 'from the old parent']).code, 0);
  move(w, M, Q);
  assert.equal(runOf(w, M), Q);
  assert.equal(getRun(w.db, Q)!.closed_at, null);
  const got = check(w, M);
  assert.equal(bodies(got), 'from the old parent');
  assert.equal(cli(w, M, ['ack', String(got.lot)]).code, 0);
  assert.equal(check(w, M).count, 0);
  assert.equal(mailRows(w, Q, M).length, 1, 'one copy on the bus in the new run');
});

test('#439 there and back: a message forwarded on attach and still unread follows again on detach — still delivered once', needsBuild, (t) => {
  const w = world(t, [{ id: P, kind: 'worktree' }, { id: M, kind: 'worktree', parentId: P }, { id: Q, kind: 'worktree' }]);
  birth(w);
  spawn(w, M);
  assert.equal(cli(w, P, ['send', '--type', 'status', '--to', M, 'one']).code, 0);
  move(w, M, Q);
  move(w, M, null);
  const got = check(w, M);
  assert.equal(bodies(got), 'one', 'once, in the run it lives in now');
  assert.equal(cli(w, M, ['ack', String(got.lot)]).code, 0);
  assert.equal(check(w, M).count + check(w, M, ['--run', P]).count + check(w, M, ['--run', Q]).count, 0, 'nowhere left');
});

test('#439 a dispatch followed into the new run keeps its capability (the agent\'s end-of-work report is verified in the run it checks)', needsBuild, (t) => {
  const w = world(t, [{ id: P, kind: 'worktree' }, { id: M, kind: 'worktree', parentId: P }]);
  birth(w);
  spawn(w, M);
  const sent = cli(w, P, ['send', '--type', 'dispatch', '--to', M, 'do the thing']);
  assert.equal(sent.code, 0, sent.stderr + sent.stdout);
  const oldCap = w.db.prepare('SELECT dispatch_seq, token_hash, state FROM dispatch_capabilities WHERE run_id = ?').all(P) as Array<{ dispatch_seq: number; token_hash: string; state: string }>;
  assert.equal(oldCap.length, 1, 'a capability was minted');
  move(w, M, null);
  const moved = mailRows(w, M, M);
  assert.equal(moved.length, 1);
  const newCap = w.db.prepare('SELECT dispatch_seq, token_hash, state FROM dispatch_capabilities WHERE run_id = ?').all(M) as Array<{ dispatch_seq: number; token_hash: string; state: string }>;
  assert.deepEqual(newCap.map((c) => [c.dispatch_seq, c.token_hash, c.state]), [[moved[0].sequence, oldCap[0].token_hash, oldCap[0].state]], 'the same capability, re-keyed to the copy');
});

test('#439 (#436) a STRANGER\'s status filed in an agent\'s own run follows that agent when it is attached under another', needsBuild, (t) => {
  const w = world(t, [{ id: P, kind: 'worktree' }, { id: M, kind: 'worktree' }, { id: Q, kind: 'worktree' }]); // three unrelated top-level agents
  birth(w);
  const sent = cli(w, P, ['send', '--type', 'status', '--to', M, 'hello from a stranger']);
  assert.equal(sent.code, 0, sent.stderr + sent.stdout);
  assert.equal(mailRows(w, M, M).length, 1, 'filed in the recipient\'s own run');
  move(w, M, Q);
  const got = check(w, M);
  assert.equal(bodies(got), 'hello from a stranger', 'M reads it in Q\'s run');
  assert.equal(cli(w, M, ['ack', String(got.lot)]).code, 0);
  assert.equal(check(w, M).count, 0, 'once');
});

// ── 4. the subtree ────────────────────────────────────────────────────────────────────────────────────────────────────
test('#439 the SUBTREE is re-derived: a moved owner takes its run with it (parent pointer re-pointed), its members\' runs and unread mail are untouched', needsBuild, (t) => {
  const w = world(t, [{ id: X, kind: 'worktree' }, { id: C, kind: 'worktree', parentId: X }, { id: G, kind: 'worktree', parentId: C }, { id: Q, kind: 'worktree' }]);
  birth(w);
  spawn(w, C);
  spawn(w, G);
  assert.deepEqual(runRows(w).map((r) => `${r.id}:${r.kind}:${r.parent}`), [`${X}:mission:null`, `${Q}:mission:null`, `${C}:vague:${X}`]);
  assert.equal(cli(w, C, ['send', '--type', 'status', '--to', G, 'for the grandchild']).code, 0, 'filed in C\'s run');
  assert.equal(cli(w, X, ['send', '--type', 'status', '--to', C, 'for the child']).code, 0, 'filed in X\'s run');
  const mv = move(w, X, Q, [C, G]);
  assert.equal(mv.verdict.ok, true);
  assert.deepEqual(runRows(w).filter((r) => r.id === X).map((r) => `${r.kind}:${r.parent}`), [`vague:${Q}`], 'X\'s mission became a vague of Q\'s run');
  assert.equal(runOf(w, C), C, 'C still owns its run (G is its member)');
  assert.equal(runOf(w, G), C, 'G still of C\'s');
  assert.equal(getRun(w.db, C)!.parent_run_id, X, 'C\'s run still hangs under X\'s: only the moved root\'s pointer changes');
  assert.ok(relatedRunsOf(w.db, Q).includes(X) && relatedRunsOf(w.db, Q).includes(C), 'the whole chain is related to Q now (wake / pause see it)');
  assert.equal(runRows(w).filter((r) => r.closed != null).length, 0, 'nothing closed');
  assert.equal(bodies(check(w, G)), 'for the grandchild', 'a member\'s unread mail is delivered once, where it was');
  assert.equal(bodies(check(w, C, ['--run', X])), 'for the child', 'and C still reads what X sent it in X\'s run');
  assert.equal(mailRows(w, X, C).length + mailRows(w, C, G).length, 2, 'no copies were made for members whose runs did not change');
});

test('#439 (#434 m1) an agent that already HAS a mission row and is attached keeps/gets a re-pointed parent_run_id; detached it is a mission again', needsBuild, (t) => {
  const w = world(t, [{ id: X, kind: 'worktree' }, { id: C, kind: 'worktree', parentId: X }, { id: Q, kind: 'worktree' }]);
  birth(w);
  spawn(w, C);
  assert.equal(getRun(w.db, X)!.parent_run_id, null);
  move(w, X, Q, [C]);
  assert.deepEqual([getRun(w.db, X)!.kind, getRun(w.db, X)!.parent_run_id], ['vague', Q]);
  move(w, X, null, [C]);
  assert.deepEqual([getRun(w.db, X)!.kind, getRun(w.db, X)!.parent_run_id], ['mission', null]);
});

test('#439 attach under a target whose run row does not exist yet (pre-#433 data): the row is started first, so the moved run never points at a missing run', needsBuild, (t) => {
  const w = world(t, [{ id: X, kind: 'worktree' }, { id: C, kind: 'worktree', parentId: X }, { id: Q, kind: 'worktree' }]);
  birth(w);
  spawn(w, C);
  w.db.prepare('DELETE FROM runs WHERE id = ?').run(Q); // a target whose mission was never born
  const mv = move(w, X, Q, [C]);
  assert.equal(mv.verdict.ok, true);
  assert.deepEqual(runRows(w).map((r) => `${r.id}:${r.kind}:${r.parent}`).sort(), [`${Q}:mission:null`, `${X}:vague:${Q}`].sort(), 'Q\'s mission was started, X hangs under it');
});

// ── 5. a childless ex-owner that attaches (the #434 "argued" point) ─────────────────────────────────────────────────────
test('#439 a CHILDLESS ex-owner that attaches: the mail left in its old run follows it, the row stays open and empty, and it is reused if the agent spawns / detaches again', needsBuild, (t) => {
  const w = world(t, [{ id: X, kind: 'worktree' }, { id: C, kind: 'worktree', parentId: X }, { id: Q, kind: 'worktree' }]);
  birth(w);
  spawn(w, C);
  assert.equal(cli(w, C, ['send', '--type', 'status', '--to', X, 'last report of a child now deleted']).code, 0);
  edit(w, (recs) => { recs.splice(recs.findIndex((r) => r.id === C), 1); }); // the child is deleted; X keeps ownsRun but has no member
  assert.equal(mailRows(w, X, X).length, 1, 'the report sits in X\'s own run, unread');
  const mv = move(w, X, Q);
  assert.equal(mv.verdict.ok, true);
  assert.equal(runOf(w, X), Q, 'X no longer owns a run: it is a member of Q\'s');
  assert.equal(coordinates(nodes(w).get(X)!), false);
  const got = check(w, X);
  assert.equal(bodies(got), 'last report of a child now deleted', 'the mail followed X');
  assert.equal(cli(w, X, ['ack', String(got.lot)]).code, 0);
  assert.equal(check(w, X).count, 0, 'once');
  assert.equal(check(w, X, ['--run', X]).count, 0, 'nothing is left behind in the old run for X');
  assert.equal(getRun(w.db, X)!.closed_at, null, 'the old row stays OPEN: it is X\'s run (id = coordinator) and closes only when X is archived / deleted (#437) — an app-start reconcile would reopen it anyway');
  // detach later: the same row is the agent's mission again (no second row, parent pointer cleared)
  move(w, X, null);
  assert.equal(runRows(w).filter((r) => r.id === X).length, 1);
  assert.deepEqual([getRun(w.db, X)!.kind, getRun(w.db, X)!.parent_run_id], ['mission', null]);
});

// ── 6. refusals (each has a mutant in scripts/attach-any-agent-mutants.mjs) ─────────────────────────────────────────────
test('#439 refusals: self, unknown, ARCHIVED target, CLOSED run, a cycle — and nothing is moved', needsBuild, (t) => {
  const w = world(t, [
    { id: P, kind: 'worktree' },
    { id: M, kind: 'worktree', parentId: P },
    { id: Q, kind: 'worktree' },
    { id: X, kind: 'worktree', archived: true },
  ]);
  birth(w);
  spawn(w, M);
  const ask = (id: string, parentId: string, closed = false) => decideAttachTarget({ id, parentId, lookup: rawLookup(w), targetRunClosed: closed });
  assert.equal(ask(P, P).ok, false, 'self');
  assert.match((ask(P, 'nope') as { error: string }).error, /unknown parent workspace/);
  assert.match((ask(Q, X) as { error: string }).error, /archived/);
  assert.match((ask(Q, P, true) as { error: string }).error, /closed/);
  assert.match((ask(P, M) as { error: string }).error, /cycle/, 'P under its own child');
  assert.equal(ask(Q, M).ok, true, 'a plain child is a valid target too');
  assert.equal(ask(Q, P).ok, true);
  // and through the move composition: a closed run is refused with nothing re-derived
  closeRunOf(w, Q);
  const before = JSON.stringify(runRows(w));
  const mv = move(w, P, Q);
  assert.equal(mv.verdict.ok, false);
  assert.equal(runOf(w, P), P, 'the store did not move');
  assert.equal(JSON.stringify(runRows(w)), before, 'no run touched');
});

test('#439 a run is never re-pointed at a CLOSED run, a missing one, or one of its own descendants', needsBuild, (t) => {
  const w = world(t, [{ id: X, kind: 'worktree' }, { id: C, kind: 'worktree', parentId: X }, { id: G, kind: 'worktree', parentId: C }, { id: Q, kind: 'worktree' }]);
  birth(w);
  spawn(w, C);
  spawn(w, G);
  closeRunOf(w, Q);
  assert.equal(repointRun(w.db, X, Q), 'refused-closed');
  assert.equal(getRun(w.db, X)!.parent_run_id, null, 'unchanged');
  assert.equal(repointRun(w.db, X, 'no-such-run'), 'refused-no-parent-row');
  assert.equal(repointRun(w.db, X, C), 'refused-cycle', 'X under its own child run would loop the run tree');
  assert.equal(repointRun(w.db, 'ghost', Q), 'no-row');
  assert.equal(forwardUnreadMail(w.db, X, [X], Q).refusedClosed, true, 'mail is never copied into a closed run');
});

// ── wiring pins: the host seams the composed arms stand in for (workspaces.ts / Sidebar.tsx cannot load under node --test) ──
const src = (rel: string): string => fs.readFileSync(path.resolve(here, '..', '..', rel), 'utf8');

test('#439 wiring: the reconcile re-derives EVERY moved agent BEFORE the noop decision; attach asks decideAttachTarget (no coordinator-only refusal); the snapshot keeps the pre-move related runs', () => {
  const ws = src('src/main/workspaces.ts');
  const rec = ws.slice(ws.indexOf('async function reconcileRunAfterReparent('), ws.indexOf('export function listStaleRunWorkspaces'));
  assert.ok(rec.indexOf('await rederiveBusRunAfterReparent(ws, relatedRunSnapshots.get(oldAnchors)?.get(wsId))') > 0, 'the reconcile calls the bus re-derivation');
  assert.ok(rec.indexOf('rederiveBusRunAfterReparent(') < rec.indexOf('decideReparentAction(candidate, opts.noRestart)'), 'BEFORE the noop decision (#433 M1)');
  const attach = ws.slice(ws.indexOf('export async function dispatchAttachRequest('), ws.indexOf('// ---------- Associate an orchestrator'));
  assert.match(attach, /decideAttachTarget\(\{/, 'attach asks the pure verdict');
  assert.doesNotMatch(attach, /coordinates\(parent\)/, 'no coordinator-only target');
  assert.doesNotMatch(attach, /must be an orchestrator/, 'the old refusal text is gone');
  assert.match(attach, /runClosedAt\(db, rawParent\)/, 'a closed run is read off the bus');
  assert.match(ws, /if \(db\) related\.set\(ws\.id, relatedRunsOf\(db, anchor\)\)/, 'the snapshot records the related runs before the move');
  const sb = src('src/renderer/components/Sidebar.tsx');
  assert.doesNotMatch(sb.slice(sb.indexOf('const canAttachTo'), sb.indexOf('const commitReparent')), /coordinates\(/, 'the sidebar drop rule no longer asks for a coordinator');
  assert.match(sb, /dropIntent\(\{ canAttach: canAttachTo\(w\), canReorder: canReorderOnto\(w, isChild\)/, 'the repo-section rows decide attach vs reorder with dropIntent');
});
