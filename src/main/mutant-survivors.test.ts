import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
// @ts-expect-error — a plain .mjs helper shared with the mutant harnesses
import { SWEEP_MARK_ENV, descendantsOf, finishRunDir, makeRunDir, markedProcesses, settleBackups, strayProcesses } from '../../scripts/mutant-survivors.mjs';

// The survivors line of a mutant harness must be MEASURED. Positive control: a real child (and grandchild) IS counted while alive and is NOT once it is gone; the instrument can say FAIL.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('descendantsOf: counts a live child AND its grandchild, forgets them once killed', async () => {
  const child = spawn('sh', ['-c', 'sleep 30 & wait'], { stdio: 'ignore', detached: true }); // its own process group: one kill takes the grandchild too
  await sleep(300);
  try {
    const live = descendantsOf(process.pid) as number[];
    assert.ok(live.includes(child.pid!), 'the child is a descendant');
    assert.ok(live.length >= 2, `the grandchild (sleep) too: ${live.join(',')}`);
    assert.ok(!live.includes(process.pid), 'never itself');
    assert.ok(!live.includes(1), 'init is not a descendant');
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ }
  }
  await sleep(300);
  assert.deepEqual(descendantsOf(process.pid) as number[], [], 'nothing of ours is left alive (the instrument says CLEAN only when it is)');
});

test('descendantsOf parses a comm with spaces and parentheses (the /proc/<pid>/stat trap) from a fake /proc', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeproc-'));
  const mk = (pid: number, comm: string, st: string, ppid: number) => { fs.mkdirSync(path.join(root, String(pid))); fs.writeFileSync(path.join(root, String(pid), 'stat'), `${pid} (${comm}) ${st} ${ppid} 0 0 0\n`); };
  mk(10, 'node', 'S', 1);
  mk(11, 'weird (name) x', 'S', 10);
  mk(12, 'child', 'R', 11);
  mk(13, 'zombie', 'Z', 10);
  mk(14, 'other', 'S', 99);
  try {
    assert.deepEqual((descendantsOf(10, root) as number[]).sort((a, b) => a - b), [11, 12], 'the nested pair, not the zombie, not the stranger');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('settleBackups: a backup identical to its source is cleaned (restore proven); one that differs is KEPT and counted (a restore that did not happen)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
  const bk = path.join(root, 'bk');
  fs.mkdirSync(bk);
  fs.writeFileSync(path.join(root, 'a.ts'), 'A');
  fs.writeFileSync(path.join(root, 'b.ts'), 'B-mutated');
  fs.writeFileSync(path.join(bk, 'a.orig'), 'A');
  fs.writeFileSync(path.join(bk, 'b.orig'), 'B');
  fs.writeFileSync(path.join(bk, 'stray.txt'), 'x');
  try {
    const left = settleBackups(bk, (id: string) => path.join(root, `${id[0]}.ts`));
    assert.equal(left, 2, 'b.orig differs from its source + stray.txt belongs to nobody');
    assert.deepEqual(fs.readdirSync(bk).sort(), ['b.orig', 'stray.txt']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── review m1 / m2 (#323): orphans selected by MARKER, scratch per RUN ──
const orphan = async (token: string | null): Promise<number> => {
  // the parent shell starts a detached sleep and EXITS: the sleep is re-parented (to init or a user manager / subreaper) — it is no longer our descendant
  const env = { ...process.env, ...(token === null ? {} : { [SWEEP_MARK_ENV]: token }) };
  const p = spawn('sh', ['-c', 'sleep 30 >/dev/null 2>&1 & echo $!'], { env, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  p.stdout!.on('data', (d) => (out += String(d)));
  await new Promise((r) => p.on('close', r));
  return Number(out.trim());
};
const killQuietly = (pid: number) => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } };

test('markedProcesses / strayProcesses: an ORPHAN carrying the run marker is found although descendantsOf cannot see it; an unmarked process and another run\'s marker are NOT selected', async () => {
  const mine = `t-${process.pid}-${Date.now()}`;
  const marked = await orphan(mine);
  const other = await orphan(`other-${mine}`);
  const bare = await orphan(null);
  await sleep(300);
  try {
    assert.ok(marked > 1 && other > 1 && bare > 1, 'three orphans started');
    assert.ok(!(descendantsOf(process.pid) as number[]).includes(marked), 'the ancestry walk is BLIND to an orphan (the m1 finding) — whoever adopted it');
    assert.ok((markedProcesses(mine) as number[]).includes(marked), 'the marker finds it');
    assert.ok(!(markedProcesses(mine) as number[]).includes(other), 'another run\'s marker is not mine');
    assert.ok(!(markedProcesses(mine) as number[]).includes(bare), 'an unmarked process is not mine');
    assert.ok((strayProcesses(process.pid, mine) as number[]).includes(marked), 'the harness verdict counts it');
  } finally {
    for (const p of [marked, other, bare]) killQuietly(p);
  }
  await sleep(300);
  assert.deepEqual(markedProcesses(mine), [], 'killed ⇒ the instrument says CLEAN (and only then)');
  assert.throws(() => markedProcesses(''), /needs a run token/, 'an empty token would select every process: refused');
});

test('markedProcesses over a fake /proc: environ NUL-split exact match (a token that is only a PREFIX of another does not match), zombies and self skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fakeproc2-'));
  const mk = (pid: number, env: string[], st: string) => { fs.mkdirSync(path.join(root, String(pid))); fs.writeFileSync(path.join(root, String(pid), 'environ'), env.join('\0') + '\0'); fs.writeFileSync(path.join(root, String(pid), 'stat'), `${pid} (x) ${st} 1 0 0 0\n`); };
  mk(20, ['A=1', `${SWEEP_MARK_ENV}=tok1`], 'S');
  mk(21, [`${SWEEP_MARK_ENV}=tok10`], 'S');
  mk(22, [`${SWEEP_MARK_ENV}=tok1`], 'Z');
  mk(23, [`X${SWEEP_MARK_ENV}=tok1`], 'S');
  mk(24, [`${SWEEP_MARK_ENV}=tok1`], 'S');
  try {
    assert.deepEqual(markedProcesses('tok1', root, 24), [20], 'exact token, alive, not self');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('per-run scratch: makeRunDir is unique per run; finishRunDir settles ONLY its own backups — another run\'s dir and files are never read, counted or deleted', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'runs-'));
  const src = path.join(base, 'a.ts');
  fs.writeFileSync(src, 'A');
  try {
    const mine = makeRunDir(path.join(base, 'bk'), 111, 1);
    const theirs = makeRunDir(path.join(base, 'bk'), 222, 1);
    assert.notEqual(mine, theirs);
    fs.writeFileSync(path.join(theirs, 'a.orig'), 'someone else\'s backup, different from the source');
    fs.writeFileSync(path.join(mine, 'a.orig'), 'A');
    assert.equal(finishRunDir(mine, () => src), 0, 'my identical backup is cleaned: 0 left — the OTHER run\'s differing backup is not mine to count');
    assert.equal(fs.existsSync(mine), false, 'my run dir is gone');
    assert.deepEqual(fs.readdirSync(theirs), ['a.orig'], 'the other run\'s backup survives untouched');
    fs.mkdirSync(mine, { recursive: true });
    fs.writeFileSync(path.join(mine, 'a.orig'), 'not restored');
    assert.equal(finishRunDir(mine, () => src), 1, 'my own unrestored backup IS counted (and kept for inspection)');
    assert.equal(fs.existsSync(mine), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('strayProcesses = marked ∪ descendants: a child that SCRUBS its environment (env -i) carries no marker but is still our descendant — the ancestry half of the union is pinned', async () => {
  const tok = `scrub-${process.pid}-${Date.now()}`;
  const child = spawn('env', ['-i', '/bin/sh', '-c', 'sleep 30 & wait'], { env: { ...process.env, [SWEEP_MARK_ENV]: tok }, stdio: 'ignore', detached: true });
  await sleep(400);
  try {
    const stray = strayProcesses(process.pid, tok) as number[];
    assert.ok(stray.includes(child.pid!), 'the env-scrubbed child is found by ancestry');
    assert.ok(!(markedProcesses(tok) as number[]).includes(child.pid!), 'precondition: the marker alone is blind to it (env -i dropped it)');
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ }
  }
  await sleep(300);
  assert.deepEqual(strayProcesses(process.pid, tok), []);
});

test('the sweep harness measures scratch MID-run with the settle-only helper and removes the run dir only at the END (the baseline used the end-of-run helper, deleted the dir, and the first mutant crashed with ENOENT)', async () => {
  const h = fs.readFileSync(path.join(process.cwd(), 'scripts/memcap-settings-mutants.mjs'), 'utf8');
  assert.match(h, /const scratchLeft = \(\) => settleBackups\(BACKUP, sourceOfBackup\);/);
  assert.match(h, /const scratchFinish = \(\) => finishRunDir\(BACKUP, sourceOfBackup\);/);
  assert.match(h, /const sv = strays\(\); const sc = scratchFinish\(\);/, 'the FINAL verdict is the only finish');
  assert.equal((h.match(/scratchFinish\(\)/g) ?? []).length, 1, 'called exactly once (the final verdict)');
  // behavioural half: settling an EMPTY run dir leaves it in place (the next mutant writes its backup there)
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'basel-'));
  try {
    const dir = makeRunDir(base, 1, 1);
    assert.equal(settleBackups(dir, () => '/nonexistent'), 0);
    await new Promise((r) => setImmediate(r)); // a settle that schedules a clean-up would act after this tick
    assert.equal(fs.existsSync(dir), true, 'the run dir survives a mid-run measurement');
    assert.equal(finishRunDir(dir, () => '/nonexistent'), 0);
    assert.equal(fs.existsSync(dir), false, 'and goes at the end');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
