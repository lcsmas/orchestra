import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bus from '../main/bus.ts';
import * as busRuns from '../main/bus-runs.ts';
import { getRunPause } from '../main/bus-pause.ts';
import { DEFAULT_BUS_SWITCHES, type BusSwitches } from '../shared/bus-switches.ts';
import { commandHelp, wantsCommandHelp } from './help.ts';

// #252 `orchestra run pause --hard` / `run resume` — the BUILT CLI in an isolated ORCHESTRA_HOME + HOME under the
// real home (btrfs; never the live ~/.orchestra/bus.sqlite), socket dead on purpose (the verb is store-less: it must
// land while the app is DOWN). State is read back through a FRESH connection. Expectations are literals.
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };
const ROOT = path.join(os.homedir(), '.cache', `pause-d1a-cli-${process.pid}`);
const ON: BusSwitches = { ...DEFAULT_BUS_SWITCHES, pause: true };
let n = 0;

interface Cli {
  code: number;
  stdout: string;
  stderr: string;
}

function cli(home: string, args: string[], wsId: string | null = 'ops-ws', runEnv: string | null = null): Cli {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    ORCHESTRA_HOME: home,
    ORCHESTRA_SOCK: path.join(home, 'no.sock'),
  };
  if (wsId !== null) env.ORCHESTRA_WS_ID = wsId;
  if (runEnv !== null) env.ORCHESTRA_RUN_ID = runEnv;
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

function home(t: { after: (fn: () => void) => void }, sw: BusSwitches = ON): string {
  const h = path.join(ROOT, `h${n++}`);
  mkdirSync(h, { recursive: true });
  const db = bus.openBus(path.join(h, 'bus.sqlite'));
  try {
    busRuns.startRun(db, { id: 'L', kind: 'mission', coordinator: 'lead-ws' }, sw);
    busRuns.startRun(db, { id: 'O', kind: 'vague', coordinator: 'ops-ws', parentRunId: 'L' }, sw);
    busRuns.startRun(db, { id: 'S', kind: 'vague', coordinator: 'sub-ws', parentRunId: 'O' }, sw);
  } finally {
    db.close();
  }
  t.after(() => rmSync(h, { recursive: true, force: true }));
  return h;
}

function state(h: string, runId: string): ReturnType<typeof getRunPause> {
  const db = bus.openBus(path.join(h, 'bus.sqlite'));
  try {
    return getRunPause(db, runId);
  } finally {
    db.close();
  }
}

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('pause --hard by the coordinator (app DOWN): rc 0, durable row, states the human-prompt policy', needsBuild, (t) => {
  const h = home(t);
  const r = cli(h, ['run', 'pause', '--hard', '--run', 'O']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /Run O is now PAUSED \(hard\)/);
  assert.match(r.stdout, /run en pause/);
  assert.match(r.stdout, /A prompt a HUMAN types in a member's composer is still allowed and does NOT lift the pause/);
  assert.match(r.stdout, /orchestra run resume --run O/);
  const s = state(h, 'O')!;
  assert.equal(s.pausedBy, 'ops-ws');
  assert.equal(s.mode, 'hard');
  assert.equal(s.trapAt, null);
  assert.equal(state(h, 'S'), null, 'descendant run carries no pause column of its own');
});

test('pause without --hard is refused with a usage line (no soft pause exists yet)', needsBuild, (t) => {
  const h = home(t);
  const r = cli(h, ['run', 'pause', '--run', 'O']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /only the HARD pause \(pause dure\) exists so far/);
  assert.equal(state(h, 'O'), null);
});

test('authority = the hold rule: a worker / descendant coordinator / no identity is REFUSED and writes nothing; an ancestor coordinator and `--as <coordinator>` (the human path) may pause', needsBuild, (t) => {
  const h = home(t);
  for (const who of ['worker-ws', 'sub-ws']) {
    const r = cli(h, ['run', 'pause', '--hard', '--run', 'O'], who);
    assert.notEqual(r.code, 0, who);
    assert.match(r.stderr, /refused — run "O" can only be paused by its coordinator \(ops-ws\) or by a coordinator of an ancestor run \(lead-ws\)/);
  }
  const anon = cli(h, ['run', 'pause', '--hard', '--run', 'O'], null);
  assert.notEqual(anon.code, 0);
  assert.match(anon.stderr, /pass --as <handle>/);
  assert.equal(state(h, 'O'), null, 'nothing written by any refusal');
  assert.equal(cli(h, ['run', 'pause', '--hard', '--run', 'O'], 'lead-ws').code, 0, 'ancestor coordinator');
  assert.equal(state(h, 'O')?.pausedBy, 'lead-ws');
  const h2 = home(t);
  assert.equal(cli(h2, ['run', 'pause', '--hard', '--run', 'O', '--as', 'ops-ws'], null).code, 0, 'human: --as the coordinator');
});

test('pause is REFUSED while the run\'s frozen `pause` switch is OFF — never accepted-and-inert', needsBuild, (t) => {
  const h = home(t, DEFAULT_BUS_SWITCHES);
  const r = cli(h, ['run', 'pause', '--hard', '--run', 'O']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /the 'pause' switch is OFF for run "O" \(frozen at its wave start\) — nothing paused/);
  assert.equal(state(h, 'O'), null);
});

test('pause on an unknown run is refused (no-run), $ORCHESTRA_RUN_ID is the default target, a repeat keeps the original', needsBuild, (t) => {
  const h = home(t);
  const nope = cli(h, ['run', 'pause', '--hard', '--run', 'ghost']);
  assert.notEqual(nope.code, 0);
  assert.match(nope.stderr, /run "ghost" has no row/);
  assert.equal(cli(h, ['run', 'pause', '--hard'], 'ops-ws', 'O').code, 0, 'env run id');
  const first = state(h, 'O')!;
  const again = cli(h, ['run', 'pause', '--hard', '--run', 'O'], 'lead-ws');
  assert.equal(again.code, 0);
  assert.match(again.stdout, /was already paused \(since .* by ops-ws\) — unchanged/);
  assert.deepEqual(state(h, 'O'), first);
});

test('resume LIFTS the pause (all four columns) — a worker cannot; a descendant run points at the carrier', needsBuild, (t) => {
  const h = home(t);
  cli(h, ['run', 'pause', '--hard', '--run', 'O']);
  const w = cli(h, ['run', 'resume', '--run', 'O'], 'worker-ws');
  assert.notEqual(w.code, 0);
  assert.notEqual(state(h, 'O'), null, 'still paused after a refused lift');
  const desc = cli(h, ['run', 'resume', '--run', 'S'], 'sub-ws');
  assert.equal(desc.code, 0);
  assert.match(desc.stdout, /Run S was not held — unchanged\.\nIt is still PAUSED by run O — lift that one: orchestra run resume --run O\n/);
  const r = cli(h, ['run', 'resume', '--run', 'O']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Run O pause LIFTED — réveils, turns and spawns are allowed again\./);
  assert.equal(state(h, 'O'), null);
});

test('resume on a run that was NEVER paused prints exactly what it always printed (switch-OFF byte-identity of the verb)', needsBuild, (t) => {
  const h = home(t, DEFAULT_BUS_SWITCHES);
  assert.equal(cli(h, ['run', 'resume', '--run', 'O']).stdout, 'Run O was not held — unchanged.\n');
  assert.equal(cli(h, ['run', 'hold', '--run', 'O']).stdout,
    'Run O is now HELD — liveness will not escalate any member of it (undo with: orchestra run resume --run O)\n');
  assert.equal(cli(h, ['run', 'resume', '--run', 'O']).stdout,
    'Run O resumed — liveness escalation is re-enabled for its members.\n');
});

test('pause and hold are independent flags: resume lifts both and says so', needsBuild, (t) => {
  const h = home(t);
  cli(h, ['run', 'hold', '--run', 'O']);
  cli(h, ['run', 'pause', '--hard', '--run', 'O']);
  const r = cli(h, ['run', 'resume', '--run', 'O']);
  assert.match(r.stdout, /pause LIFTED/);
  assert.match(r.stdout, /Its liveness hold was lifted too\./);
  assert.equal(state(h, 'O'), null);
  assert.equal(cli(h, ['run', 'resume', '--run', 'O']).stdout, 'Run O was not held — unchanged.\n', 'hold is gone too');
});

test('--hard only applies to `run pause`', needsBuild, (t) => {
  const h = home(t);
  const r = cli(h, ['run', 'hold', '--hard', '--run', 'O']);
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /--hard only applies to `run pause`/);
});

test('help: `orchestra run --help` documents pause/resume + the human-prompt policy; `run pause --help` is a help request', () => {
  const help = commandHelp('run') ?? '';
  assert.match(help, /orchestra run pause --hard \[--run <id>\]/);
  assert.match(help, /run en pause/);
  assert.match(help, /A prompt a HUMAN types in a member's composer stays allowed and does NOT lift/);
  assert.match(help, /'pause' bus switch/);
  assert.equal(wantsCommandHelp(['pause', '--help'], 'run'), true);
  assert.equal(wantsCommandHelp(['pause', '--help'], 'status'), false, 'free text is never a help request');
});

test('pre-review MAJOR: `run pause --hard --help` (help flag at args[2]) prints help and pauses NOTHING — for every flag-only run verb', needsBuild, (t) => {
  const h = home(t);
  for (const args of [['run', 'pause', '--hard', '--help', '--run', 'O'], ['run', 'pause', '--run', 'O', '--hard', '-h'], ['run', 'hold', '--run', 'O', '--help'], ['run', 'resume', '--run', 'O', '-h']]) {
    const r = cli(h, args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stdout, /usage: orchestra run refreeze/, `${args.join(' ')} printed help`);
    assert.doesNotMatch(r.stdout, /PAUSED|HELD|LIFTED/, 'and acted on nothing');
  }
  assert.equal(state(h, 'O'), null, 'nothing was paused by any of them');
  assert.equal(cli(h, ['run', 'pause', '--hard', '--run', 'O']).code, 0, 'control: without the help flag the verb does pause');
  assert.notEqual(state(h, 'O'), null);
});

test('pre-review: wantsCommandHelp honours a help flag anywhere after a flag-only run verb — and still never for free text', () => {
  for (const a of [['pause', '--hard', '--help'], ['pause', '--run', 'O', '--hard', '-h'], ['hold', '--run', 'x', '--help'], ['resume', '--as', 'a', '-h'], ['refreeze', '--run', 'x', '--help']]) {
    assert.equal(wantsCommandHelp(a, 'run'), true, a.join(' '));
  }
  assert.equal(wantsCommandHelp(['pause', '--hard', '--help'], 'status'), false, 'free text of another verb is never a help request');
  assert.equal(wantsCommandHelp(['--run', 'O', 'pause', '--help'], 'run'), false, 'only the verb position counts');
});

test('pre-review: `resume` of a run whose ANCESTOR is still paused says so — never "allowed again" on the first call', needsBuild, (t) => {
  const h = home(t);
  assert.equal(cli(h, ['run', 'pause', '--hard', '--run', 'L'], 'lead-ws').code, 0);
  assert.equal(cli(h, ['run', 'pause', '--hard', '--run', 'O'], 'ops-ws').code, 0);
  const r = cli(h, ['run', 'resume', '--run', 'O'], 'ops-ws');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, "Run O's own pause is LIFTED, but it is still PAUSED by run L — lift that one: orchestra run resume --run L\n");
  assert.doesNotMatch(r.stdout, /allowed again/);
  assert.equal(state(h, 'O'), null, 'its own pause really is cleared');
  const l = cli(h, ['run', 'resume', '--run', 'L'], 'lead-ws');
  assert.match(l.stdout, /^Run L pause LIFTED — réveils, turns and spawns are allowed again\./, 'control: the ancestor lifts normally');
});
