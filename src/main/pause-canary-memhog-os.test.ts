// Pause canary 1b (#324): the process selection of the memory-hog harness (memhog-os.mjs) — reviewer findings 1 and 2: teardown must signal ONLY the rig's own processes (exact `ORCHESTRA_HOME=<home>` marker),
// never a wrapper whose argv merely names the scratch path, never a sibling rig whose directory name has ours as a prefix, never an ancestor, never a recycled pid; and the `leak` control must hold a pid that IS the leftover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { rigProcesses, killByIdentity, ancestorsOf, ticks, alive } from '../../scripts/pause-canary/memhog-os.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mhos-'));
const home = path.join(base, 'rig', 'home');
const kids: ChildProcess[] = [];
const sleeper = (env: Record<string, string>, argv: string[] = []): ChildProcess => {
  const c = spawn('sleep', ['300', ...argv], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'ignore', detached: true });
  kids.push(c);
  return c;
};
const gone = async (pid: number): Promise<boolean> => { for (let i = 0; i < 100; i++) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
test.after(() => { for (const k of kids) { try { process.kill(k.pid as number, 'SIGKILL'); } catch { /* gone */ } } fs.rmSync(base, { recursive: true, force: true }); });

test('rigProcesses: only processes carrying EXACTLY ORCHESTRA_HOME=<home>; a decoy naming the path in argv, a sibling rig whose dir has ours as a prefix and an unrelated process are left alone', async () => {
  const mine = sleeper({ ORCHESTRA_HOME: home });
  const decoyArgv = sleeper({ ORCHESTRA_HOME: '/elsewhere' }, [home]);                       // `timeout … --base <path>`-like: the path is in its ARGV only
  const sibling = sleeper({ ORCHESTRA_HOME: `${home}-sibling` });                            // a sibling rig whose directory starts with ours
  const siblingDir = sleeper({ ORCHESTRA_HOME: path.join(base, 'rig-sibling', 'home') });
  const stranger = sleeper({});
  await new Promise((r) => setTimeout(r, 150));
  const found = rigProcesses(home).map((p: { pid: number }) => p.pid);
  assert.deepEqual(found, [mine.pid], `found ${found} (mine ${mine.pid}; decoys ${[decoyArgv, sibling, siblingDir, stranger].map((c) => c.pid)})`);
});

test('rigProcesses never returns our own pid or an ancestor, even when they carry the marker; `except` is honoured', async () => {
  const keep = sleeper({ ORCHESTRA_HOME: home });
  const other = sleeper({ ORCHESTRA_HOME: home });
  await new Promise((r) => setTimeout(r, 150));
  const saved = process.env.ORCHESTRA_HOME;
  process.env.ORCHESTRA_HOME = home;   // our own environ is fixed at exec: the marker below is the child's — this asserts the ancestor/self exclusion by construction
  try {
    const anc = ancestorsOf();
    assert.ok(anc.has(process.pid) && anc.has(process.ppid));
    const all = rigProcesses(home).map((p: { pid: number }) => p.pid);
    assert.ok(!all.includes(process.pid) && !all.includes(process.ppid));
    const except = rigProcesses(home, new Set([keep.pid])).map((p: { pid: number }) => p.pid);
    assert.ok(!except.includes(keep.pid as number) && except.includes(other.pid as number));
  } finally {
    if (saved === undefined) delete process.env.ORCHESTRA_HOME; else process.env.ORCHESTRA_HOME = saved;
  }
});

test('killByIdentity: kills the listed process; skips one whose start time changed (a recycled pid) or whose marker is gone; returns what it signalled', async () => {
  const a = sleeper({ ORCHESTRA_HOME: home });
  const b = sleeper({ ORCHESTRA_HOME: home });
  const c = sleeper({ ORCHESTRA_HOME: '/not/ours' });
  await new Promise((r) => setTimeout(r, 150));
  const list = [
    { pid: a.pid, ticks: ticks(a.pid) },
    { pid: b.pid, ticks: `${ticks(b.pid)}0` },   // wrong identity: must NOT be signalled
    { pid: c.pid, ticks: ticks(c.pid) },         // right identity, wrong marker: must NOT be signalled
  ];
  const done = killByIdentity(list, home);
  assert.deepEqual(done, [a.pid]);
  assert.equal(await gone(a.pid as number), true);
  assert.equal(alive(b.pid), true);
  assert.equal(alive(c.pid), true);
});

test('the `leak` control holds the pid of the leftover itself: a detached `sleep` (not a `setsid` wrapper that exits at once) — and teardown can leave exactly that identity alone', async () => {
  const leakChild = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env: { PATH: process.env.PATH ?? '', ORCHESTRA_HOME: home } });
  kids.push(leakChild);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(alive(leakChild.pid), true, 'the pid we hold is alive (a setsid wrapper would be gone)');
  const leak = { pid: leakChild.pid, ticks: ticks(leakChild.pid) };
  const left = rigProcesses(home).filter((p: { pid: number; ticks: string }) => !(p.pid === leak.pid && p.ticks === leak.ticks));
  killByIdentity(left, home);
  assert.equal(alive(leak.pid), true, 'teardown spared the planted leak');
  assert.ok(rigProcesses(home).some((p: { pid: number }) => p.pid === leak.pid), 'and the parent\'s survivors scan would see it');
});
