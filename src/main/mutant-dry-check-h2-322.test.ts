import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// OPS 2026-10-09: `--check` was an UNKNOWN flag of another mutant harness (#328) and fell through to the full sweep. The same contract is pinned for this branch's harness: `--check` / `--check-anchors` = anchors
// only — no git / pnpm / systemd-run / docker / electron call, no scratch directory; an unknown option = exit 2 and NOTHING run. The instrument is a set of PATH shims that log every call and exit 97; the control
// arm (no flag) must reach the first shim call, else an empty log proves nothing.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPTS = ['scripts/memory-cap-row-mutants.mjs'];
const SHIMMED = ['git', 'pnpm', 'npm', 'npx', 'systemd-run', 'systemctl', 'docker', 'electron', 'bash', 'sway', 'swaymsg'];

function run(script: string, args: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mutant-dry-'));
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  const log = path.join(root, 'shim.log');
  for (const name of SHIMMED) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\necho "$0 $*" >> "$SHIM_LOG"\nexit 97\n', { mode: 0o755 });
  }
  const r = spawnSync(process.execPath, [path.join(REPO, script), ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 90_000,
    env: { PATH: `${bin}:${path.dirname(process.execPath)}`, HOME: home, SHIM_LOG: log },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const scratch = fs.existsSync(path.join(home, '.cache'));
  fs.rmSync(root, { recursive: true, force: true });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', calls, scratch };
}

for (const script of SCRIPTS) {
  const name = path.basename(script);
  for (const flag of ['--check', '--check-anchors']) {
    test(`${name} ${flag}: a DRY anchor check — every anchor resolves, no git/pnpm/keeper/scope/docker/electron call, no scratch directory`, () => {
      const r = run(script, [flag]);
      assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, /ANCHORS: (\d+)\/\1 resolve exactly once/);
      assert.deepEqual(r.calls, [], 'nothing was launched');
      assert.equal(r.scratch, false, 'and no scratch/backup directory was created');
    });
  }
  test(`${name}: an UNKNOWN option fails closed — exit 2, a sentence, nothing launched, no scratch (it must never fall through to the sweep)`, () => {
    for (const args of [['--bogus'], ['--check', '--bogus'], ['-x']]) {
      const r = run(script, args);
      assert.equal(r.status, 2, args.join(' '));
      assert.match(r.stderr, /REFUSING: unknown option/);
      assert.deepEqual(r.calls, [], args.join(' '));
      assert.equal(r.scratch, false, args.join(' '));
    }
  });
  test(`${name} (control): with NO flag the script does reach its first shimmed call — so an empty call log above is evidence, not a blind instrument`, () => {
    const r = run(script, []);
    assert.ok(r.calls.length >= 1, `no shim call recorded; stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`);
    assert.equal(r.status, 2, 'the guard reads the shim failure as « dirty tree » and refuses — nothing heavy ran');
  });
}
