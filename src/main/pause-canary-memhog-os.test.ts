// Pause canary 1b (#324): the process selection of the memory-hog harness (memhog-os.mjs) — reviewer findings 1 and 2: teardown must signal ONLY the rig's own processes (exact `ORCHESTRA_HOME=<home>` marker),
// never a wrapper whose argv merely names the scratch path, never a sibling rig whose directory name has ours as a prefix, never an ancestor, never a recycled pid; and the `leak` control must hold a pid that IS the leftover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { rigProcesses, killByIdentity, ancestorsOf, ticks, alive, standinCliEnv } from '../../scripts/pause-canary/memhog-os.mjs';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mhos-'));
const home = path.join(base, 'rig', 'home');
const kids: ChildProcess[] = [];
const sleeper = (env: Record<string, string>, argv: string[] = []): ChildProcess => {
  const c = spawn('sleep', ['300', ...argv], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'ignore', detached: true });
  kids.push(c);
  return c;
};
/** A live process that carries `argv` in its command line (GNU `sleep` rejects a path operand and exits at once — review 2, finding 5). */
const argvHolder = (env: Record<string, string>, argv: string[]): ChildProcess => {
  const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '--', ...argv], { env: { PATH: process.env.PATH ?? '', ...env }, stdio: 'ignore', detached: true });
  kids.push(c);
  return c;
};
const gone = async (pid: number): Promise<boolean> => { for (let i = 0; i < 100; i++) { if (!alive(pid)) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
test.after(() => {
  for (const k of kids) { try { process.kill(k.pid as number, 'SIGKILL'); } catch { /* gone */ } }
  killByIdentity(rigProcesses(home), home);   // whatever else carries this test's marker (stand-in CLI tools): the helper under test, on its own scratch home
  fs.rmSync(base, { recursive: true, force: true });
});

test('rigProcesses: only processes carrying EXACTLY ORCHESTRA_HOME=<home>; a decoy naming the path in argv, a sibling rig whose dir has ours as a prefix and an unrelated process are left alone', async () => {
  const mine = sleeper({ ORCHESTRA_HOME: home });
  const decoyArgv = argvHolder({ ORCHESTRA_HOME: '/elsewhere' }, [home]);                // `timeout … --base <path>`-like: the path is in its ARGV only
  const sibling = sleeper({ ORCHESTRA_HOME: `${home}-sibling` });                            // a sibling rig whose directory starts with ours
  const siblingDir = sleeper({ ORCHESTRA_HOME: path.join(base, 'rig-sibling', 'home') });
  const stranger = sleeper({});
  await new Promise((r) => setTimeout(r, 400));
  for (const [n, c] of Object.entries({ mine, decoyArgv, sibling, siblingDir, stranger })) assert.equal(alive(c.pid), true, `${n} is alive: a decoy that exited proves nothing`);
  assert.ok(fs.readFileSync(`/proc/${decoyArgv.pid}/cmdline`, 'utf8').includes(home), 'the argv decoy really carries the path in its command line');
  const found = rigProcesses(home).map((p: { pid: number }) => p.pid);
  assert.deepEqual(found, [mine.pid], `found ${found} (mine ${mine.pid}; decoys ${[decoyArgv, sibling, siblingDir, stranger].map((c) => c.pid)})`);
});

/** parent (marker) → child (marker) → rigProcesses(home) called IN the child. Printed: the child's pid, its ppid, what it found. */
const PROBE = `
import { spawn } from 'node:child_process';
const [, , mode, osUrl, home, exceptPid] = process.argv;
if (mode === 'parent') {
  const c = spawn(process.execPath, [process.argv[1], 'child', osUrl, home, exceptPid], { stdio: ['ignore', 'inherit', 'inherit'] });
  c.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { rigProcesses } = await import(osUrl);
  const found = rigProcesses(home, exceptPid ? new Set([Number(exceptPid)]) : undefined).map((p) => p.pid);
  console.log(JSON.stringify({ pid: process.pid, ppid: process.ppid, found }));
}
`;
const probeTree = (exceptPid?: number) => {
  const script = path.join(base, 'probe-tree.mjs');
  fs.writeFileSync(script, PROBE);
  const osUrl = new URL('../../scripts/pause-canary/memhog-os.mjs', import.meta.url).href;
  const out = execFileSync(process.execPath, [script, 'parent', osUrl, home, ...(exceptPid ? [String(exceptPid)] : [])], { env: { PATH: process.env.PATH ?? '', ORCHESTRA_HOME: home }, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop() as string) as { pid: number; ppid: number; found: number[] };
};

test('rigProcesses never returns the calling process or an ancestor even though they carry the marker (a REAL parent→child tree, the marker in their ENVIRON); siblings are found; `except` is honoured', async () => {
  const keep = sleeper({ ORCHESTRA_HOME: home });
  const other = sleeper({ ORCHESTRA_HOME: home });
  await new Promise((r) => setTimeout(r, 300));
  const r = probeTree();
  assert.ok(r.ppid > 1);
  assert.ok(!r.found.includes(r.pid), 'the caller itself carries the marker and is left out');
  assert.ok(!r.found.includes(r.ppid), 'its parent carries the marker and is an ancestor: left out');
  assert.ok(r.found.includes(keep.pid as number) && r.found.includes(other.pid as number), 'the marked siblings are found (the tree is not empty: the exclusion is the only reason the two are missing)');
  const e = probeTree(keep.pid);
  assert.ok(!e.found.includes(keep.pid as number) && e.found.includes(other.pid as number), '`except` removes exactly the listed pid');
  assert.ok(ancestorsOf().has(process.pid) && ancestorsOf().has(process.ppid));
});

test('the stand-in CLI is spawned with the rig marker: a REAL stand-in CLI and the tool it runs are both found by rigProcesses (they were invisible to teardown and the survivors count without ORCHESTRA_HOME in their env)', async () => {
  const standin = fileURLToPath(new URL('../../scripts/memory-cap/standin-cli.cjs', import.meta.url));
  const cli = spawn(process.execPath, [standin], { env: standinCliEnv(home, 0), stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  kids.push(cli);
  assert.equal(standinCliEnv(home, 0).ORCHESTRA_HOME, home);
  let out = '';
  cli.stdout!.on('data', (d) => { out += d.toString(); });
  for (let i = 0; i < 100 && !out.includes('"init"'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(out.includes('"init"'), 'the stand-in CLI came up');
  cli.stdin!.write(`${JSON.stringify({ tool: 'sleep 300', id: 't1' })}\n`);
  let tool = 0;
  for (let i = 0; i < 100 && !tool; i++) {
    await new Promise((r) => setTimeout(r, 50));
    tool = rigProcesses(home).map((p: { pid: number }) => p.pid).find((pid: number) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('sleep'); } catch { return false; } }) ?? 0;
  }
  const found = rigProcesses(home).map((p: { pid: number }) => p.pid);
  assert.ok(found.includes(cli.pid as number), 'the CLI carries the marker');
  assert.ok(tool > 0 && found.includes(tool), 'its tool (a child of the CLI) carries the marker');
  // control: the OLD env (no ORCHESTRA_HOME) is invisible — the instrument can say « not found »
  const { ORCHESTRA_HOME: _drop, ...legacy } = standinCliEnv(home, 0);
  const hidden = spawn(process.execPath, [standin], { env: legacy, stdio: ['pipe', 'ignore', 'ignore'], detached: true });
  kids.push(hidden);
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(!rigProcesses(home).some((p: { pid: number }) => p.pid === hidden.pid), 'a CLI spawned without the marker is NOT found: that was the defect');
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
