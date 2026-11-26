// #605 — `orchestra fanout run`: argv, the dummy gate, the exit codes (0 merged · 3 parked · 2 refusal · 1 could not run). The loop itself: src/shared/fanout-loop.test.ts; the built CLI: scripts/e2e-fanout-run.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFanoutRun, RUN_USAGE } from './fanout-run.ts';
import type { FanoutDeps } from './fanout-state.ts';

const scen = (n: string): string => path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'shared', 'fanout-loop-scenarios', `${n}.json`);
const made: string[] = [];
const mk = (): string => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-run-cli-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const deps = (env: Record<string, string> = {}): FanoutDeps => ({ env: { ORCHESTRA_HOME: mk(), ...env }, cwd: '/', runner: () => ({ code: 1, stdout: '', stderr: '' }), now: () => '2026-11-25T10:00:00.000Z', readStdin: () => '' });
const DUMMY = { ORCHESTRA_FANOUT_DUMMY: '1' };

test('help: the usage names the exit codes and the gate', async () => {
  const r = await runFanoutRun(['--help'], deps());
  assert.equal(r.code, 0);
  assert.equal(r.stdout, `${RUN_USAGE}\n`);
  for (const w of ['0 every ticket merged', '3 the run ended with at least one parked ticket', '4 paused', '2 refusal', '1 could not run', 'ORCHESTRA_FANOUT_DUMMY=1']) assert.ok(RUN_USAGE.includes(w), w);
});
test('MUST-FAIL --scenario without ORCHESTRA_FANOUT_DUMMY=1 is refused ([run-scenario-gated], exit 2): nothing ran', async () => {
  const d = deps();
  const r = await runFanoutRun(['--scenario', scen('rts7')], d);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^\[run-scenario-gated\]/);
  assert.equal(fs.existsSync(path.join(d.env.ORCHESTRA_HOME!, 'fanout')), false, 'no state was created');
  assert.equal((await runFanoutRun(['--scenario', scen('rts7')], deps({ ORCHESTRA_FANOUT_DUMMY: '0' }))).code, 2, 'only the value 1 opens the gate');
});
test('no scenario and no host route: the live loop cannot run — exit 1, named', async () => {
  const r = await runFanoutRun(['--tickets', 'A,B'], deps(DUMMY));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /\[run-live-ports\]/);
});
test('argv refusals: --tickets with --plan, a positional, a bad minor policy, an unknown flag, a bad scenario', async () => {
  assert.match((await runFanoutRun(['--tickets', 'A', '--plan', 'p.json'], deps(DUMMY))).stderr, /\[run-plan-ambiguous\]/);
  assert.equal((await runFanoutRun(['A'], deps(DUMMY))).code, 1);
  assert.match((await runFanoutRun(['--minor-policy', 'maybe', '--scenario', scen('rts7')], deps(DUMMY))).stderr, /\[run-minor-policy\]/);
  assert.equal((await runFanoutRun(['--bogus'], deps(DUMMY))).code, 1);
  const bad = path.join(mk(), 's.json');
  fs.writeFileSync(bad, '{"version":2}');
  const r = await runFanoutRun(['--scenario', bad], deps(DUMMY));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\[run-scenario-bad\]/);
});
test('exit 0: the 7-ticket scenario prints the closing report as JSON on stdout and the verdict on stderr', async () => {
  const r = await runFanoutRun(['--scenario', scen('rts7')], deps(DUMMY));
  assert.equal(r.code, 0, r.stderr.slice(-400));
  const j = JSON.parse(r.stdout);
  assert.equal(j.exit, 0);
  assert.deepEqual(j.report.merged, ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7']);
  assert.deepEqual(j.dummy.violations, []);
  assert.match(r.stderr, /JUDGE: clean/);
});
test('exit 3: a parked ticket ends the run with the report naming it', async () => {
  const r = await runFanoutRun(['--scenario', scen('nosafe'), '--run', 'ns'], deps(DUMMY));
  assert.equal(r.code, 3);
  assert.deepEqual(JSON.parse(r.stdout).report.parked.map((p: { ticket: string }) => p.ticket), ['T3', 'T5', 'T7']);
});
test('a run that already has a state is refused (the dummy world is rebuilt from the scenario)', async () => {
  const d = deps(DUMMY);
  assert.equal((await runFanoutRun(['--scenario', scen('held'), '--run', 'again'], d)).code, 0);
  const r = await runFanoutRun(['--scenario', scen('held'), '--run', 'again'], d);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\[run-dummy-state-exists\]/);
});

test('608 m3: the help says what lifts a pause — `state set --run <id> --resume-run` — not just "run again" (a re-run of a paused run exits 4 at once)', () => {
  assert.match(RUN_USAGE, /orchestra fanout state set --run <id> --resume-run/);
  assert.doesNotMatch(RUN_USAGE, /paused \(resumable: run again\)/);
});
