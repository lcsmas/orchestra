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
import { enrollMember, listRoster } from '../main/pause-douce.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';

// #254 `orchestra run pause` (douce) / `run confirm pause` / `run status` — the BUILT CLI in an isolated ORCHESTRA_HOME + HOME under the real
// home (btrfs; never the live bus), socket dead on purpose (store-less verbs must work while the app is DOWN).
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };
const ROOT = path.join(os.homedir(), '.cache', `pause-douce-cli-${process.pid}`);
const ON: BusSwitches = { ...DEFAULT_BUS_SWITCHES, pause: true };
let n = 0;

function cli(home: string, args: string[], wsId: string | null = 'ops-ws', extraEnv: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_SOCK: path.join(home, 'no.sock'), ...extraEnv };
  if (wsId !== null) env.ORCHESTRA_WS_ID = wsId;
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }), stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function home(t: { after: (fn: () => void) => void }): string {
  const h = path.join(ROOT, `h${n++}`);
  mkdirSync(h, { recursive: true });
  const db = bus.openBus(path.join(h, 'bus.sqlite'));
  try {
    busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'lead-ws' }, ON);
    busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'ops-ws', parentRunId: 'L' }, ON);
  } finally {
    db.close();
  }
  t.after(() => rmSync(h, { recursive: true, force: true }));
  return h;
}

function withDb<T>(h: string, fn: (db: bus.BusDb) => T): T {
  const db = bus.openBus(path.join(h, 'bus.sqlite'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('`run pause --hard` over a douce that is still waiting ESCALATES it (rc 0, "escalated to PAUSE DURE"); over a hard pause it is "already paused"', needsBuild, (t) => {
  const h = home(t);
  assert.equal(cli(h, ['run', 'pause', '--run', 'O']).code, 0);
  const e = cli(h, ['run', 'pause', '--hard', '--run', 'O']);
  assert.equal(e.code, 0, e.stderr);
  assert.match(e.stdout, /escalated to PAUSE DURE now/);
  const p = withDb(h, (db) => getRunPause(db, 'O'))!;
  assert.equal(p.mode, 'hard');
  assert.notEqual(p.escalatedAt, null);
  assert.match(cli(h, ['run', 'pause', '--hard', '--run', 'O']).stdout, /was already paused/);
});

test('`run confirm pause`: the member (no readable store, no env run) is found through the host-written roster; first accusé wins; N/M is printed; works while the app is DOWN', needsBuild, (t) => {
  const h = home(t);
  assert.equal(cli(h, ['run', 'pause', '--run', 'O']).code, 0);
  const p = withDb(h, (db) => getRunPause(db, 'O'))!;
  withDb(h, (db) => {
    enrollMember(db, 'O', p.pausedAt, { wsId: 'w1', memberRun: 'O' });
    enrollMember(db, 'O', p.pausedAt, { wsId: 'w2', memberRun: 'O' });
  });
  const a = cli(h, ['run', 'confirm', 'pause'], 'w1');
  assert.equal(a.code, 0, a.stderr);
  assert.match(a.stdout, /Pause accusée for w1 on run O\. 1\/2 en pause — manquent : w2\./);
  const b = cli(h, ['run', 'confirm', 'pause'], 'w1');
  assert.match(b.stdout, /Pause already confirmed for w1/);
  const roster = withDb(h, (db) => listRoster(db, 'O', p.pausedAt));
  assert.deepEqual(roster.map((r) => [r.wsId, r.pauseConfirmVia]), [['w1', 'member'], ['w2', null]]);
  assert.equal(withDb(h, (db) => getRunPause(db, 'O'))!.escalatedAt, null, 'the CLI never escalates — only the host does');
});

test('`run confirm pause`: no pause ⇒ says so (rc 0, writes nothing); no identity ⇒ refused; anything but `pause` ⇒ usage; a help flag prints help and confirms nothing', needsBuild, (t) => {
  const h = home(t);
  const none = cli(h, ['run', 'confirm', 'pause'], 'w1');
  assert.equal(none.code, 0);
  assert.match(none.stdout, /No active pause covers w1/);
  assert.equal(withDb(h, (db) => db.prepare('SELECT COUNT(*) AS c FROM pause_members').get())?.c, 0);
  cli(h, ['run', 'pause', '--run', 'O']);
  const anon = cli(h, ['run', 'confirm', 'pause'], null);
  assert.notEqual(anon.code, 0);
  assert.match(anon.stderr, /no identity/);
  const bad = cli(h, ['run', 'confirm', 'nonsense'], 'w1'); // (was `reprise` before #255 shipped it as a real verb)
  assert.notEqual(bad.code, 0);
  assert.match(bad.stderr, /usage: orchestra run confirm pause/);
  const help = cli(h, ['run', 'confirm', 'pause', '--help'], 'w1');
  assert.equal(help.code, 0);
  assert.match(help.stdout, /usage: orchestra run refreeze/);
  assert.equal(withDb(h, (db) => db.prepare('SELECT COUNT(*) AS c FROM pause_members').get())?.c, 0, 'the help request confirmed nothing');
});

test('`run status` names the phase and the roster of a Pause douce ("N/M en pause — manquent") and says the trap is NOT OWED YET', needsBuild, (t) => {
  const h = home(t);
  cli(h, ['run', 'pause', '--run', 'O']);
  const p = withDb(h, (db) => getRunPause(db, 'O'))!;
  withDb(h, (db) => {
    enrollMember(db, 'O', p.pausedAt, { wsId: 'w1', memberRun: 'O' });
    enrollMember(db, 'O', p.pausedAt, { wsId: 'w2', memberRun: 'O' });
  });
  cli(h, ['run', 'confirm', 'pause'], 'w1');
  const st = cli(h, ['run', 'status', '--run', 'O']);
  assert.equal(st.code, 0, st.stderr);
  assert.match(st.stdout, /Pause: Pause douce en cours — 1\/2 en pause — manquent : w2 — Pause dure à /);
  assert.match(st.stdout, /w1 \[worker\] — en pause \(member\)/);
  assert.match(st.stdout, /w2 \[worker\] — pas encore confirmé/);
  assert.match(st.stdout, /Host trap: NOT OWED YET — Pause douce still waiting/);
  const js = JSON.parse(cli(h, ['run', 'status', '--run', 'O', '--json']).stdout);
  assert.equal(js.roster.summary.done, 1);
  assert.equal(js.roster.phase, 'pausing');
});

test('`run confirm pause` with a READABLE store walks the live tree from the caller\'s own workspace (no roster, no env run) and records its OWN run (nearest orchestrator); it drops the member\'s undelivered order file', needsBuild, (t) => {
  const h = home(t);
  const dir = path.join(h, 'userData', 'orchestra');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [], accounts: [], workspaces: [{ id: 'L', kind: 'orchestrator' }, { id: 'O', kind: 'orchestrator', parentId: 'L' }, { id: 'w1', parentId: 'O' }] }));
  assert.equal(cli(h, ['run', 'pause', '--run', 'O']).code, 0);
  const p = withDb(h, (db) => getRunPause(db, 'O'))!;
  const orders = path.join(h, 'pause-orders');
  mkdirSync(orders, { recursive: true });
  writeFileSync(path.join(orders, 'w1.json'), JSON.stringify('an undelivered order'));
  const r = cli(h, ['run', 'confirm', 'pause'], 'w1', { ORCHESTRA_EVENTS_DIR: path.join(h, 'events') });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Pause accusée for w1 on run O\. 1\/1 en pause\./);
  assert.deepEqual(withDb(h, (db) => listRoster(db, 'O', p.pausedAt)).map((x) => [x.wsId, x.role, x.memberRun, x.pauseConfirmVia]), [['w1', 'worker', 'O', 'member']]);
  assert.equal(existsSync(path.join(orders, 'w1.json')), false, 'its own undelivered order is dropped (it would be stale)');
});

test('`run confirm pause --run <x>` never overwrites what the host enrolled (a wrong --run is a carrier hint, not the member\'s run)', needsBuild, (t) => {
  const h = home(t);
  assert.equal(cli(h, ['run', 'pause', '--run', 'O']).code, 0);
  const p = withDb(h, (db) => getRunPause(db, 'O'))!;
  withDb(h, (db) => enrollMember(db, 'O', p.pausedAt, { wsId: 'ops-ws', memberRun: 'O' })); // the host knew: a coordinator of run O
  const r = cli(h, ['run', 'confirm', 'pause', '--run', 'L'], 'ops-ws');
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(withDb(h, (db) => listRoster(db, 'O', p.pausedAt)).map((x) => [x.wsId, x.role, x.memberRun, x.pauseConfirmVia]), [['ops-ws', 'coordinator', 'O', 'member']]);
});

test('`run confirm pause` from a NON-member (`--as ghost --run O`) is refused: rc 1, "not a member", nothing written (R1-1) — a real member still confirms', needsBuild, (t) => {
  const h = home(t);
  assert.equal(cli(h, ['run', 'pause', '--run', 'O']).code, 0);
  const p = withDb(h, (db) => getRunPause(db, 'O'))!;
  withDb(h, (db) => enrollMember(db, 'O', p.pausedAt, { wsId: 'w1', memberRun: 'O' }));
  const ghost = cli(h, ['run', 'confirm', 'pause', '--as', 'not-a-member', '--run', 'O'], 'w1');
  assert.notEqual(ghost.code, 0);
  assert.match(ghost.stderr, /"not-a-member" is not a member of run O's pause roster — nothing recorded/);
  assert.deepEqual(withDb(h, (db) => listRoster(db, 'O', p.pausedAt)).map((x) => [x.wsId, x.pauseConfirmVia]), [['w1', null]], 'no phantom row, nobody confirmed');
  assert.match(cli(h, ['run', 'confirm', 'pause', '--run', 'O'], 'w1').stdout, /Pause accusée for w1 on run O\. 1\/1 en pause\./);
});
