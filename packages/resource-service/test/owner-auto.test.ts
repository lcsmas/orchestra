// A6 acceptance 1 + 3 at the unit and CLI seams: `--owner auto` = the NEAREST `claude` ancestor of the calling command; none → refused (exit 3).
// The real-session proof (a real `claude` CLI vs a fake API) is scripts/e2e-claude-owner.mjs; here the "session" is `node` run under the name `claude`.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { findClaudeAncestor, isClaude, type ProcView } from '../src/owner.ts';
import { BIN, identityOf, isAlive, Rig, waitFor } from './lib/rig.ts';
import { sleep } from '../src/proc.ts';

/** A fabricated process table: pid → [ppid, comm, exe basename]. */
function table(rows: Record<number, [number, string, string | null]>): ProcView {
  return {
    stat: (pid) => (rows[pid] ? { ppid: rows[pid][0], startTime: pid * 10 } : null),
    comm: (pid) => rows[pid]?.[1] ?? null,
    exeName: (pid) => rows[pid]?.[2] ?? null,
  };
}

describe('findClaudeAncestor (fabricated process table)', () => {
  it('returns the NEAREST claude, not the outermost one, with its starttime', () => {
    const v = table({ 50: [40, 'node', 'node'], 40: [30, 'sh', 'dash'], 30: [20, 'claude', '2.1.325'], 20: [10, 'node', 'node'], 10: [5, 'claude', '2.1.300'], 5: [1, 'systemd', 'systemd'] });
    const w = findClaudeAncestor(40, v);
    assert.deepEqual(w.found, { pid: 30, startTime: 300 });
    assert.deepEqual(w.chain, ['sh(40)', 'claude(30)']);
  });

  it('skips the node wrapper above claude (keeper shape) and the shell below it', () => {
    const v = table({ 3: [2, 'zsh', 'zsh'], 2: [1, 'claude', '2.1.325'] });
    assert.equal(findClaudeAncestor(3, v).found?.pid, 2);
  });

  it('matches on comm OR on the exe basename — a native install has comm claude and exe `<version>`, a symlinked one may be the other way round', () => {
    assert.ok(isClaude('claude', '2.1.325'), 'comm only');
    assert.ok(isClaude('node', 'claude'), 'exe only');
    assert.ok(!isClaude('node', '2.1.325'));
    assert.ok(!isClaude('claudette', 'claude-helper'), 'exact names only');
    assert.ok(!isClaude(null, null));
    assert.equal(findClaudeAncestor(7, table({ 7: [1, 'node', 'claude'] })).found?.pid, 7, 'exe-only ancestor found');
    assert.equal(findClaudeAncestor(7, table({ 7: [1, 'claude', '2.1.325'] })).found?.pid, 7, 'comm-only ancestor found');
  });

  it('no claude above → null, with the chain it walked; stops at pid 1, at a vanished process and on a ppid cycle', () => {
    const none = findClaudeAncestor(9, table({ 9: [8, 'node', 'node'], 8: [1, 'bash', 'bash'] }));
    assert.equal(none.found, null);
    assert.deepEqual(none.chain, ['node(9)', 'bash(8)']);
    assert.equal(findClaudeAncestor(9, table({ 9: [8, 'node', 'node'] })).found, null, 'parent vanished');
    assert.equal(findClaudeAncestor(9, table({ 9: [8, 'node', 'node'], 8: [9, 'node', 'node'] })).found, null, 'cycle');
  });
});

/** The CLI run by `script` inside a process that real /proc knows as `claude` (node under a symlink of that name). */
function fakeClaude(rig: Rig, name: string, script: string, env: NodeJS.ProcessEnv = {}): ChildProcess {
  const dir = path.join(rig.dir, `bin-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'claude');
  fs.symlinkSync(process.execPath, exe);
  const child = spawn(exe, ['-e', script], { stdio: 'ignore', env: { ...rig.env, ...env, BIN } });
  (rig as unknown as { kids: ChildProcess[] }).kids.push(child);
  return child;
}

const OUT = (rig: Rig, name: string): string => path.join(rig.dir, `${name}.out`);
const readJson = (p: string): { status: number | null; stdout: string; stderr: string } => JSON.parse(fs.readFileSync(p, 'utf8'));
/** Script: run `resctl run start --id <id> --owner auto` from a `sh -c` child (so the CLI's parent is a shell, not claude: `exit $?` keeps sh from exec-ing it), save the result, then live. */
const startScript = (outFile: string, id: string, extra = ''): string => `
const { spawnSync } = require('node:child_process'), fs = require('node:fs');
const r = spawnSync('sh', ['-c', '"$0" "$@"; exit $?', process.execPath, process.env.BIN, 'run', 'start', '--id', '${id}', '--owner', 'auto'${extra}], { encoding: 'utf8' });
fs.writeFileSync('${outFile}.tmp', JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr })); fs.renameSync('${outFile}.tmp', '${outFile}');
setInterval(() => {}, 1e6);`;

describe('--owner auto at the CLI seam (real /proc)', () => {
  let rig: Rig;
  before(() => {
    rig = new Rig({ grace: '3s' });
  });
  after(async () => {
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
  });

  it('a command run from a claude session records THAT process (pid + starttime) as owner, not its shell or the CLI', async () => {
    const c = fakeClaude(rig, 'a', startScript(OUT(rig, 'a'), 'auto1'));
    const res = readJson(await waitFor('the start result', () => fs.existsSync(OUT(rig, 'a')) && OUT(rig, 'a')));
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout.trim(), 'auto1');
    const run = rig.run('auto1')!;
    assert.equal(run.owner.pid, c.pid, 'the owner is the claude process');
    assert.equal(run.owner.startTime, identityOf(c.pid!)!.startTime);
    assert.equal(fs.readFileSync(`/proc/${c.pid}/comm`, 'utf8').trim(), 'claude', 'instrument check: the stand-in really is called claude to /proc');
  });

  it('with two claude ancestors the NEAREST is the owner', async () => {
    const dir = path.join(rig.dir, 'inner');
    fs.mkdirSync(dir);
    fs.symlinkSync(process.execPath, path.join(dir, 'claude'));
    const inner = `
      const { spawn } = require('node:child_process');
      const c = spawn(${JSON.stringify(path.join(dir, 'claude'))}, ['-e', ${JSON.stringify(startScript(OUT(rig, 'b'), 'auto2'))}], { stdio: 'ignore', env: process.env });
      require('node:fs').writeFileSync(${JSON.stringify(path.join(rig.dir, 'inner.pid'))}, String(c.pid));
      setInterval(() => {}, 1e6);`;
    const outer = fakeClaude(rig, 'b', inner);
    await waitFor('the start result', () => fs.existsSync(OUT(rig, 'b')));
    const innerPid = Number(fs.readFileSync(path.join(rig.dir, 'inner.pid'), 'utf8'));
    assert.notEqual(innerPid, outer.pid);
    const owner = rig.run('auto2')!.owner.pid;
    process.kill(innerPid, 'SIGKILL'); // the outer claude does not own it: no process of this test outlives it
    assert.equal(owner, innerPid, 'the inner (nearest) claude, not the outer one');
  });

  it('the run is governed by that session: killing it starts the grace, and the lane dies when it ends', async () => {
    rig.startDaemon();
    const c = fakeClaude(rig, 'c', startScript(OUT(rig, 'c'), 'auto3'));
    await waitFor('the start result', () => fs.existsSync(OUT(rig, 'c')));
    assert.equal(rig.run('auto3')!.owner.pid, c.pid);
    const lane = rig.lane('auto3', 'sleep');
    const laneId = identityOf(await lane.pid())!;
    await sleep(500);
    assert.equal(rig.run('auto3')!.state, 'alive', 'owner alive → no grace');
    assert.ok(isAlive(laneId));

    c.kill('SIGKILL');
    const ends = await waitFor('the grace starts', () => rig.run('auto3')?.state === 'grace' && rig.run('auto3')!.graceEndsAt);
    assert.ok(isAlive(laneId), 'the lane is alive inside the grace');
    await waitFor('the lane to be killed after the grace', () => !isAlive(laneId), 15_000);
    assert.ok(Date.now() >= ends, 'killed before the grace ended');
  });

  it('no claude ancestor → refused (exit 3) with a message naming what was looked for, and NOTHING is recorded', async () => {
    // The test runner may itself run under a claude session: build a chain with no claude by orphaning the CLI (reparented to pid 1).
    const out = OUT(rig, 'orphan');
    const mid = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', ${JSON.stringify(`
        const { spawnSync } = require('node:child_process'), fs = require('node:fs');
        const r = spawnSync(process.execPath, [process.env.BIN, 'run', 'start', '--id', 'noclaude', '--owner', 'auto'], { encoding: 'utf8' });
        fs.writeFileSync('${out}.tmp', JSON.stringify({ status: r.status, stdout: r.stdout, stderr: r.stderr })); fs.renameSync('${out}.tmp', '${out}');`)}], { detached: true, stdio: 'ignore', env: process.env }).unref();`;
    const m = spawn(process.execPath, ['-e', mid], { stdio: 'ignore', env: { ...rig.env, BIN } });
    await new Promise((r) => m.once('exit', r));
    const res = readJson(await waitFor('the orphan result', () => fs.existsSync(out) && out));
    assert.equal(res.status, 3, `exit code (stderr: ${res.stderr})`);
    assert.match(res.stderr, /--owner auto: no Claude Code session above this command/);
    assert.match(res.stderr, /"claude"/);
    assert.equal(res.stdout, '', 'no run id printed');
    assert.equal(rig.run('noclaude'), undefined, 'a refused start records nothing');
  });
});
