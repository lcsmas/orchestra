import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// #330 review m1: the watchers mutant harness validated nothing — `--only NOPE` printed « MUTANTS: 0/0 killed » rc 0, `--only` alone was a TypeError, an unknown option was ignored, `--check` did not exist and fell into the REAL
// mutating sweep; the rig's `RIG_ARMS=catchup_bus_wake` (underscore for hyphen) was « RED (0/0 arms) » with rc 0. Contract pinned here: `--check` / `--check-anchors` = anchors only (no git / pnpm / systemd-run / docker /
// electron call, no scratch directory); an unknown option, a bare argument, `--only` with no list or an unknown id = exit 2 and NOTHING run; the rig refuses an unknown arm (exit 2). The instrument is a set of PATH shims
// that log every call and exit 97; the control arms (a valid id; a valid arm) must reach the first guarded call / run, else an empty log proves nothing.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HARNESS = 'scripts/resilient-watchers-mutants.mjs';
const RIG = 'scripts/e2e-resilient-watchers.mjs';
const SHIMMED = ['git', 'pnpm', 'npm', 'npx', 'systemd-run', 'systemctl', 'docker', 'electron', 'bash', 'sway', 'swaymsg'];

function withHome<T>(fn: (home: string, bin: string, log: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'wd-dry-330-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  const log = path.join(root, 'shim.log');
  for (const name of SHIMMED) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\necho "$0 $*" >> "$SHIM_LOG"\nexit 97\n', { mode: 0o755 });
  try {
    return fn(home, bin, log);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const callsOf = (log: string): string[] => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []);

function runHarness(args: string[]) {
  return withHome((home, bin, log) => {
    const r = spawnSync(process.execPath, [path.join(REPO, HARNESS), ...args], { cwd: REPO, encoding: 'utf8', timeout: 90_000, env: { PATH: `${bin}:${path.dirname(process.execPath)}`, HOME: home, SHIM_LOG: log } });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', calls: callsOf(log), scratch: fs.existsSync(path.join(home, '.cache')) };
  });
}
function runRig(armsEnv: string | undefined, argv: string[] = []) {
  return withHome((home, bin, log) => {
    const env: Record<string, string> = { PATH: `${bin}:${path.dirname(process.execPath)}`, HOME: home, SHIM_LOG: log };
    if (armsEnv !== undefined) env.RIG_ARMS = armsEnv;
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(REPO, 'scripts', '.r2-register.mjs')).href, path.join(REPO, RIG), ...argv], { cwd: REPO, encoding: 'utf8', timeout: 120_000, env });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', calls: callsOf(log), scratch: fs.existsSync(path.join(home, '.cache')) };
  });
}

for (const flag of ['--check', '--check-anchors']) {
  test(`${path.basename(HARNESS)} ${flag}: a DRY anchor check — every anchor resolves, no git/pnpm/keeper/scope/docker/electron call, no scratch directory`, () => {
    const r = runHarness([flag]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /ANCHORS: (\d+)\/\1 resolve exactly once/);
    assert.deepEqual(r.calls, [], 'nothing was launched');
    assert.equal(r.scratch, false, 'and no scratch/backup directory was created');
  });
}

test(`${path.basename(HARNESS)}: an unknown option, a bare argument, a bad --only fail closed — exit 2, a sentence, nothing launched, no scratch (it used to run the sweep, ignore the id or print « 0/0 killed » rc 0)`, () => {
  for (const args of [['--bogus'], ['--check', '--bogus'], ['-x'], ['R01'], ['--only', 'R01', 'R02'], ['--only', 'NOPE'], ['--only', 'R01,NOPE'], ['--only', 'R01_typo'], ['--only'], ['--only', '--check'], ['--check', '--only', 'NOPE'], ['--no-rig', '--only', 'NOPE']]) {
    const r = runHarness(args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /REFUSING: /, args.join(' '));
    assert.deepEqual(r.calls, [], args.join(' '));
    assert.equal(r.scratch, false, args.join(' '));
  }
});

test(`${path.basename(HARNESS)} (control): --only with a real id or its short code passes validation and reaches the first guarded call — so an empty call log above is evidence, not a blind instrument`, () => {
  for (const id of ['R01', 'R01_no_retry_scheduled']) {
    const r = runHarness(['--only', id, '--no-rig']);
    assert.ok(r.calls.length >= 1, `${id}: no shim call recorded; stderr=${r.stderr.slice(0, 200)}`);
    assert.doesNotMatch(r.stderr, /REFUSING: (--only|unknown|unexpected)/, id);
    assert.match(r.stderr, /uncommitted changes/, `${id}: reached the clean-tree guard`);
  }
});

test(`${path.basename(RIG)}: an unknown arm (RIG_ARMS typo, or a bad child arm) is REFUSED — exit 2, nothing run, no scratch (it was « RED (0/0 arms) » with exit 0)`, () => {
  for (const [armsEnv, argv] of [['catchup_bus_wake', []], ['control,nope', []], ['', ['bogus']]] as Array<[string | undefined, string[]]>) {
    const r = runRig(armsEnv === '' ? undefined : armsEnv, argv);
    assert.equal(r.status, 2, `${armsEnv} ${argv.join(' ')}`);
    assert.match(r.stderr, /REFUSING: /);
    assert.doesNotMatch(r.stdout, /^(PASS|FAIL) /m, 'no arm ran');
    assert.equal(r.scratch, false, 'and no scratch directory');
  }
});

test(`${path.basename(RIG)} (control): a valid arm runs and passes (rc 0) — the refusal above is about the NAME, not about every run`, () => {
  const r = runRig('control');
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^PASS control /m);
  assert.match(r.stdout, /ALL PASS \(1\/1 arms\)/);
});
