import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bus from '../main/bus.ts';
import { startRun } from '../main/bus-runs.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';

// #379 / ADR 0008 — the BUILT CLI asks the HOST who it is on every bus call. A fake host answers `/identity`
// over a real unix socket (the same wire as the app's hooks server); the CLI, the bus and the marker file are real.
//
// MUST-FAIL on unfixed master (`ORCHESTRA_TEST_CLI=<a master-built cli.js>` runs this file against it): the arms that
// expect the HOST's run/generation to win (HOST-RUN, HOST-GENERATION) and the replaced-session refusals (SUPERSEDED-*).
// MUST-PASS both sides: the fallback arms (they are today's behaviour) — a CLI that always trusts the host, or never falls
// back, reddens exactly those.
//
// Drives dist-electron/cli.js (REBUILD after touching src/cli or src/shared/session-identity.ts); ALLOWLIST env, isolated
// ORCHESTRA_HOME — never the live bus, never a live socket.
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..');
const CLI = process.env.ORCHESTRA_TEST_CLI || path.join(REPO, 'dist-electron', 'cli.js');
const needsBuild = { skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

const OPS = 'b3790000-0000-4000-8000-0000000000a1'; // the promoted agent: it IS its own run's coordinator after the promotion
const LEAD = 'b3790000-0000-4000-8000-0000000000d0';
const OLD_RUN = 'b3790000-0000-4000-8000-0000000000f0'; // its PARENT's run, baked into its env at spawn
const NEW_RUN = OPS; // its OWN run after `orchestra promote`
const KEY = 'a1'.repeat(32);

interface Cli { code: number; stdout: string; stderr: string }
interface Rig { home: string; worktree: string; marker: string }

function freshRig(t: { after: (fn: () => void) => void }): Rig {
  const home = mkdtempSync(path.join(os.tmpdir(), 'orch-379-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const storeDir = path.join(home, 'userData', 'orchestra');
  mkdirSync(storeDir, { recursive: true });
  writeFileSync(
    path.join(storeDir, 'store.json'),
    JSON.stringify({ workspaces: [{ id: OPS, name: 'ops', canOrchestrate: true, parentId: LEAD }, { id: LEAD, name: 'lead', canOrchestrate: true }] }),
  );
  const worktree = path.join(home, 'wt');
  mkdirSync(path.join(worktree, '.orchestra'), { recursive: true });
  return { home, worktree, marker: path.join(worktree, '.orchestra', 'bus-run-stale') };
}

function withDb<T>(home: string, fn: (db: bus.BusDb) => T): T {
  const db = bus.openBus(path.join(home, 'bus.sqlite'), {});
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Both runs have rows (the #155 unknown-run gate must not be what refuses); OPS coordinates NEW_RUN. */
function seedRuns(home: string, opts: { generation?: number; fencingOn?: boolean } = {}): void {
  withDb(home, (db) => {
    startRun(db, { id: LEAD, kind: 'mission', coordinator: LEAD }, DEFAULT_BUS_SWITCHES);
    startRun(db, { id: OLD_RUN, kind: 'vague', coordinator: 'ops-old', parentRunId: LEAD }, DEFAULT_BUS_SWITCHES); // the PARENT OPS's wave, under the LEAD's run (#175: a send to the LEAD must be reachable)
    startRun(db, { id: NEW_RUN, kind: 'vague', coordinator: OPS, parentRunId: LEAD }, { ...DEFAULT_BUS_SWITCHES, fencing: opts.fencingOn === true });
    for (let i = 0; i < (opts.generation ?? 0); i++) bus.bumpCoordinatorGeneration(db, NEW_RUN);
  });
}

const writeMarker = (rig: Rig, newRun: string): void =>
  writeFileSync(rig.marker, `stale run: this workspace was re-parented but its live session still holds the OLD run id, so bus sends are refused until it restarts.\nnew run: ${newRun}\nfix: orchestra restart\n`);

/** A fake host on a real unix socket. `answer(route, body)` returns the JSON reply; `null` = never reply (a hung host). */
async function startHost(
  t: { after: (fn: () => void) => void },
  answer: (route: string, body: Record<string, unknown>) => unknown,
): Promise<{ sock: string; calls: Array<{ route: string; body: Record<string, unknown> }> }> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-379-h-'));
  const sock = path.join(dir, 'h.sock');
  const calls: Array<{ route: string; body: Record<string, unknown> }> = [];
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(raw) as Record<string, unknown>; } catch { /* keep {} */ }
      calls.push({ route: req.url ?? '', body });
      const reply = answer(req.url ?? '', body);
      if (reply === null) return; // hung
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(reply));
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  t.after(() => {
    for (const s of sockets) s.destroy();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { sock, calls };
}

const hostSaying = (reply: Record<string, unknown>) => (route: string): unknown => (route === '/identity' ? reply : {});
const identityCalls = (h: { calls: Array<{ route: string }> }): number => h.calls.filter((c) => c.route === '/identity').length;

function orchestra(rig: Rig, args: string[], o: { sock?: string; key?: string | null; generation?: number; pathVar?: 'WORKSPACE_PATH' | 'WORKTREE' | 'none'; cwd?: string; runId?: string; ws?: string } = {}): Promise<Cli> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: rig.home,
    ORCHESTRA_HOME: rig.home,
    ORCHESTRA_WS_ID: o.ws ?? OPS,
    ORCHESTRA_RUN_ID: o.runId ?? OLD_RUN, // baked at spawn: the parent's run — stale after the promotion
    ORCHESTRA_SOCK: o.sock ?? path.join(rig.home, 'no-such.sock'),
  };
  // an agent session carries ORCHESTRA_WORKTREE; setup/run scripts carry ORCHESTRA_WORKSPACE_PATH (the default here, as before)
  if ((o.pathVar ?? 'WORKSPACE_PATH') === 'WORKSPACE_PATH') env.ORCHESTRA_WORKSPACE_PATH = rig.worktree;
  else if (o.pathVar === 'WORKTREE') env.ORCHESTRA_WORKTREE = rig.worktree;
  if (o.key !== null) env.ORCHESTRA_SESSION_KEY = o.key ?? KEY;
  if (o.generation !== undefined) env.ORCHESTRA_COORDINATOR_GENERATION = String(o.generation);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, cwd: o.cwd ?? rig.home, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => p.kill('SIGKILL'), 30_000);
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const send = (rig: Rig, body: string, o?: Parameters<typeof orchestra>[2]): Promise<Cli> =>
  orchestra(rig, ['send', '--type', 'status', '--to', LEAD, body], o);
const rowRun = (home: string, body: string): string | null =>
  withDb(home, (db) => (db.prepare('SELECT run_id FROM messages WHERE body=?').get(body) as { run_id: string } | undefined)?.run_id ?? null);
const noKeyLeak = (r: Cli): void => {
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY), 'the session key never reaches the CLI output');
};

// ── HOST-RUN: spawn → promote → send in the same turn ──────────────────────────
// The env still names the PARENT's run (baked at spawn); the host says the promoted agent is now its OWN run.
test('HOST-RUN: a promoted session\'s next send lands in its NEW run, same turn, no restart (master: lands in the OLD run)', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  const host = await startHost(t, hostSaying({ ok: true, runId: NEW_RUN, generation: null }));
  const r = await send(rig, 'after-promote-379', { sock: host.sock });
  assert.equal(r.code, 0, `send must succeed: ${r.stderr}`);
  assert.equal(rowRun(rig.home, 'after-promote-379'), NEW_RUN, 'the row is in the NEW run, not the env\'s OLD one');
  assert.deepEqual(host.calls.find((c) => c.route === '/identity')?.body, { id: OPS, key: KEY }, 'the CLI sends its workspace id + session key');
  noKeyLeak(r);
});

test('HOST-RUN: check and ack read the live run too (a lot sent to the NEW run is delivered to the promoted session)', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  withDb(rig.home, (db) => bus.send(db, { runId: NEW_RUN, sender: LEAD, kind: 'status', body: 'for-the-new-run', recipient: OPS }));
  const host = await startHost(t, hostSaying({ ok: true, runId: NEW_RUN, generation: null }));
  const c = await orchestra(rig, ['check', '--json'], { sock: host.sock });
  assert.equal(c.code, 0, c.stderr);
  assert.match(c.stdout, /for-the-new-run/, 'master reads the OLD run and sees nothing');
  noKeyLeak(c);
});

// ── HOST-GENERATION: the coordinator generation is host-resolved with the run ───
test('HOST-GENERATION: the host\'s generation replaces the baked one (a stale env generation is not fenced against)', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home, { generation: 2, fencingOn: true });
  const host = await startHost(t, hostSaying({ ok: true, runId: NEW_RUN, generation: 2 }));
  const r = await send(rig, 'gen-379', { sock: host.sock, generation: 1 }); // env says 1: on master the live coordinator is fenced out
  assert.equal(r.code, 0, `master: rc 1 "stale coordinator generation": ${r.stderr}`);
  assert.equal(rowRun(rig.home, 'gen-379'), NEW_RUN);
});

// ── SUPERSEDED: a replaced session may not use the bus (#128) ───────────────────
test('SUPERSEDED: a replaced session\'s send is refused — nothing lands, the key stays out of the output', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  const host = await startHost(t, hostSaying({ ok: false, code: 'superseded', error: `this session of workspace ${OPS} was superseded` }));
  const r = await send(rig, 'zombie-379', { sock: host.sock });
  assert.equal(r.code, 1, `a superseded session must be refused (master: rc 0, the send lands): ${r.stdout}`);
  assert.match(r.stderr, /superseded/);
  assert.equal(rowRun(rig.home, 'zombie-379'), null, 'no row landed');
  noKeyLeak(r);
});

test('SUPERSEDED: check (with its own ack) and ack are refused too — a zombie must not eat the live session\'s mail', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  withDb(rig.home, (db) => bus.send(db, { runId: OLD_RUN, sender: LEAD, kind: 'status', body: 'mail', recipient: OPS }));
  const host = await startHost(t, hostSaying({ ok: false, code: 'superseded', error: 'superseded' }));
  for (const args of [['check', '--json'], ['check', '--ack-previous'], ['ack', '1'], ['token']]) {
    const r = await orchestra(rig, args, { sock: host.sock });
    assert.equal(r.code, 1, `${args.join(' ')} must be refused (master: rc 0): ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /superseded/);
  }
  assert.equal(withDb(rig.home, (db) => (db.prepare('SELECT COUNT(*) AS n FROM deliveries').get() as { n: number }).n), 0, 'no lot was even taken');
});

// ── FALLBACK (transitional, removed with #136): the host cannot answer ──────────
test('FALLBACK app closed + marker: send is REFUSED (never into the stale run); check and ack still work', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  writeMarker(rig, NEW_RUN);
  withDb(rig.home, (db) => bus.send(db, { runId: OLD_RUN, sender: LEAD, kind: 'status', body: 'old-mail', recipient: OPS }));
  const s = await send(rig, 'blocked-379'); // no host at all
  assert.equal(s.code, 1, `the marker must refuse the send: ${s.stdout}`);
  assert.match(s.stderr, /stale run/);
  assert.equal(rowRun(rig.home, 'blocked-379'), null);
  const c = await orchestra(rig, ['check', '--json']);
  assert.equal(c.code, 0, `check is always allowed: ${c.stderr}`);
  assert.match(c.stdout, /old-mail/);
  const a = await orchestra(rig, ['ack', '1']);
  assert.equal(a.code, 0, `ack is always allowed: ${a.stderr}`);
});

test('FALLBACK app closed, no marker: the send goes through on the env values (today\'s behaviour)', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  const r = await send(rig, 'offline-379');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(rowRun(rig.home, 'offline-379'), OLD_RUN);
});

test('FALLBACK an app older than #379 answers `{}` on /identity: env values + the marker guard, exactly as before', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  const host = await startHost(t, () => ({}));
  const ok = await send(rig, 'old-app-379', { sock: host.sock });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(rowRun(rig.home, 'old-app-379'), OLD_RUN);
  writeMarker(rig, NEW_RUN);
  const blocked = await send(rig, 'old-app-blocked-379', { sock: host.sock });
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /stale run/);
});

test('FALLBACK a host that cannot vouch (no key registered) → env + marker guard', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  writeMarker(rig, NEW_RUN);
  const host = await startHost(t, hostSaying({ ok: false, code: 'unregistered', error: 'no key' }));
  const r = await send(rig, 'unvouched-379', { sock: host.sock });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /stale run/);
});

test('FALLBACK a HUNG host: the CLI gives up after its timeout and falls back — the marker still refuses the send', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  writeMarker(rig, NEW_RUN);
  const host = await startHost(t, () => null);
  const t0 = Date.now();
  const r = await send(rig, 'hung-379', { sock: host.sock });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /stale run/);
  assert.ok(Date.now() - t0 >= 2500 && Date.now() - t0 < 15_000, `bounded wait (${Date.now() - t0} ms)`);
});

test('the host\'s answer SUPERSEDES the marker: while the host answers, a leftover marker never blocks a send', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  writeMarker(rig, NEW_RUN);
  const host = await startHost(t, hostSaying({ ok: true, runId: NEW_RUN, generation: null }));
  const r = await send(rig, 'marker-ignored-379', { sock: host.sock });
  assert.equal(r.code, 0, `master: refused by the marker: ${r.stderr}`);
  assert.equal(rowRun(rig.home, 'marker-ignored-379'), NEW_RUN);
});

test('a keyless session (pre-#379 keeper, plain shell) never asks the host and keeps today\'s behaviour', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  const host = await startHost(t, hostSaying({ ok: true, runId: NEW_RUN, generation: null }));
  const r = await send(rig, 'keyless-379', { sock: host.sock, key: null });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(identityCalls(host), 0, 'no /identity call without a key');
  assert.equal(rowRun(rig.home, 'keyless-379'), OLD_RUN);
});

test('a marker naming the run the env ALREADY carries does not block (bash mode: a freshly built env)', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  writeMarker(rig, OLD_RUN); // the env's run IS the marker's `new run`
  const r = await send(rig, 'fresh-env-379', { key: null });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(rowRun(rig.home, 'fresh-env-379'), OLD_RUN);
});

test('verbs that never read the run do not ask the host (peers, whoami, status keep their cost)', needsBuild, async (t) => {
  const rig = freshRig(t);
  const host = await startHost(t, hostSaying({ ok: true, runId: NEW_RUN, generation: null }));
  await orchestra(rig, ['peers'], { sock: host.sock });
  assert.equal(identityCalls(host), 0);
});

// ── MAJOR-2: the fallback's guard must hold from ANY directory of the worktree ──
test('MAJOR-2 app closed + marker: a session that cd\'d into a SUBDIRECTORY is still refused (master: cwd-only lookup lets it send into the old run)', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  writeMarker(rig, NEW_RUN);
  const deep = path.join(rig.worktree, 'src', 'deep');
  mkdirSync(deep, { recursive: true });
  // a real session: ORCHESTRA_WORKTREE in the env (no ORCHESTRA_WORKSPACE_PATH), the Bash tool's cwd is a subdirectory
  const viaEnv = await send(rig, 'subdir-env-379', { pathVar: 'WORKTREE', cwd: deep });
  assert.equal(viaEnv.code, 1, `refused from <worktree>/src/deep via ORCHESTRA_WORKTREE: ${viaEnv.stdout}`);
  assert.match(viaEnv.stderr, /stale run/);
  assert.equal(rowRun(rig.home, 'subdir-env-379'), null);
  // a keeper-surviving CLI whose env predates ORCHESTRA_WORKTREE: the ancestor walk finds the marker
  const viaWalk = await send(rig, 'subdir-walk-379', { pathVar: 'none', cwd: deep });
  assert.equal(viaWalk.code, 1, `refused by the ancestor walk: ${viaWalk.stdout}`);
  assert.equal(rowRun(rig.home, 'subdir-walk-379'), null);
});

test('MINOR-3 a keyed session whose host is down is told to retry, not to run `orchestra restart`', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home);
  writeMarker(rig, NEW_RUN);
  const r = await send(rig, 'retry-advice-379');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /host did not answer/);
  assert.doesNotMatch(r.stderr, /orchestra restart/);
  const keyless = await send(rig, 'keyless-advice-379', { key: null });
  assert.match(keyless.stderr, /orchestra restart/, 'a keyless session keeps today\'s advice');
});

// ── MAJOR-1 (CLI side): when the host cannot vouch (the key was revoked at the coordinator bump) the baked generation is what the DB fence sees ──
test('MAJOR-1 an unvouched COORDINATOR with a stale env generation is REJECTED by the DB fence (as on master), never given the new generation', needsBuild, async (t) => {
  const rig = freshRig(t);
  seedRuns(rig.home, { generation: 2, fencingOn: true });
  const host = await startHost(t, hostSaying({ ok: false, code: 'unregistered', error: 'no key' }));
  const r = await send(rig, 'zombie-gen-379', { sock: host.sock, generation: 1, runId: NEW_RUN });
  assert.equal(r.code, 1, `fenced: ${r.stdout}`);
  assert.match(r.stderr, /stale coordinator generation/);
  assert.equal(rowRun(rig.home, 'zombie-gen-379'), null);
});
