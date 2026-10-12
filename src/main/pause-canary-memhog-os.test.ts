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
import { rigProcesses, killByIdentity, ancestorsOf, ticks, alive, standinCliEnv, scopeDirOf, capCarrierOf, scopeFactsFromDir, oomKillFromDir, backstopCountersFromDir, keeperLogText, hogProcesses, killHogs, ownPlacementWhy, SCOPE_LEAVES, WORK_LEAF, KEEPER_LEAF } from '../../scripts/pause-canary/memhog-os.mjs';

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
import fs from 'node:fs';
const [, , depth, osUrl, home, exceptPid] = process.argv;
const ppidOf = (pid) => Number(fs.readFileSync('/proc/' + pid + '/stat', 'utf8').replace(/^.*\\) \\S /, '').split(' ')[0]);
if (Number(depth) > 0) {
  const c = spawn(process.execPath, [process.argv[1], String(Number(depth) - 1), osUrl, home, exceptPid], { stdio: ['ignore', 'inherit', 'inherit'] });
  c.on('exit', (code) => process.exit(code ?? 1));
} else {
  const { rigProcesses } = await import(osUrl);
  const found = rigProcesses(home, exceptPid ? new Set([Number(exceptPid)]) : undefined).map((p) => p.pid);
  console.log(JSON.stringify({ pid: process.pid, ppid: process.ppid, gpid: ppidOf(process.ppid), found }));
}
`;
const probeTree = (exceptPid?: number, depth = 1) => {
  const script = path.join(base, 'probe-tree.mjs');
  fs.writeFileSync(script, PROBE);
  const osUrl = new URL('../../scripts/pause-canary/memhog-os.mjs', import.meta.url).href;
  const out = execFileSync(process.execPath, [script, String(depth), osUrl, home, ...(exceptPid ? [String(exceptPid)] : [])], { env: { PATH: process.env.PATH ?? '', ORCHESTRA_HOME: home }, encoding: 'utf8' });
  return JSON.parse(out.trim().split('\n').pop() as string) as { pid: number; ppid: number; gpid: number; found: number[] };
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

test('rigProcesses excludes EVERY ancestor, not only the parent: a grandparent → parent → child tree, all three carrying the marker', async () => {
  const sib = sleeper({ ORCHESTRA_HOME: home });
  await new Promise((r) => setTimeout(r, 300));
  const r = probeTree(undefined, 2);
  assert.ok(r.gpid > 1 && r.gpid !== r.ppid, 'the tree really has three levels');
  assert.ok(!r.found.includes(r.pid) && !r.found.includes(r.ppid) && !r.found.includes(r.gpid), 'self, parent and grandparent are all left out');
  assert.ok(r.found.includes(sib.pid as number), 'a marked non-ancestor is still found');
});

test('the stand-in CLI is spawned with the rig marker: a REAL stand-in CLI and the tool it runs are both found by rigProcesses (they were invisible to teardown and the survivors count without ORCHESTRA_HOME in their env)', async () => {
  const standin = fileURLToPath(new URL('../../scripts/memory-cap/standin-cli.cjs', import.meta.url));
  const cli = spawn(process.execPath, [standin], { env: standinCliEnv(home, 0), stdio: ['pipe', 'pipe', 'ignore'], detached: true });
  kids.push(cli);
  assert.equal(standinCliEnv(home, 0).ORCHESTRA_HOME, home);
  assert.equal(standinCliEnv(home, 0).HOME, home, 'the CLI\'s HOME is the rig\'s, never the real one');
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

test('killByIdentity: a process whose marker merely STARTS WITH ours (`<home>-sibling`) is not signalled even with the right identity', async () => {
  const sibling = sleeper({ ORCHESTRA_HOME: `${home}-sibling` });
  await new Promise((r) => setTimeout(r, 200));
  const done = killByIdentity([{ pid: sibling.pid, ticks: ticks(sibling.pid) }], home);
  assert.deepEqual(done, []);
  assert.equal(alive(sibling.pid), true);
});

test('ticks() is the /proc start time (field 22): equal to an independent reading, stable, and different for a process started later', async () => {
  const a = sleeper({});
  await new Promise((r) => setTimeout(r, 120));
  const b = sleeper({});
  await new Promise((r) => setTimeout(r, 150));
  for (const c of [a, b]) {
    const ref = execFileSync('awk', ['{print $22}', `/proc/${c.pid}/stat`], { encoding: 'utf8' }).trim();
    assert.equal(ticks(c.pid), ref);
    assert.equal(ticks(c.pid), ticks(c.pid), 'stable');
  }
  assert.notEqual(ticks(a.pid), ticks(b.pid), 'two processes started 120 ms apart are two identities');
  assert.equal(ticks(99999999), null, 'no such pid');
});

test('rigProcesses → killByIdentity composed: every marked process is listed WITH its identity and killed; an unmarked one and a sibling-prefix one are not', async () => {
  const home2 = path.join(base, 'rig2', 'home');
  const m1 = sleeper({ ORCHESTRA_HOME: home2 });
  const m2 = sleeper({ ORCHESTRA_HOME: home2 });
  const other = sleeper({ ORCHESTRA_HOME: `${home2}-sibling` });
  const none = sleeper({});
  await new Promise((r) => setTimeout(r, 200));
  const list = rigProcesses(home2);
  assert.deepEqual(list.map((p: { pid: number }) => p.pid).sort(), [m1.pid, m2.pid].sort());
  for (const p of list) assert.equal(p.ticks, ticks(p.pid), 'each entry carries the identity killByIdentity re-reads');
  const done = killByIdentity(list, home2);
  assert.deepEqual(done.sort(), [m1.pid, m2.pid].sort());
  assert.equal(await gone(m1.pid as number), true);
  assert.equal(await gone(m2.pid as number), true);
  assert.equal(alive(other.pid), true);
  assert.equal(alive(none.pid), true);
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

// ── the scope LAYOUT (#332, Q9): flat scope or two leaves `k` (keeper + CLI) / `w` (tool commands, carries the hard level and the kill counter) — facts read from a FAKE cgroup tree of both shapes ──
const cgTree = (name: string, files: Record<string, string>) => {
  const root = path.join(base, 'cg', name);
  for (const [rel, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); }
  return root;
};
const UNIT = 'orchestra-rig-wh-h3-abcd1234-0000-4000-8000-000000000011-x.scope';
const CAP = 268435456;
const flat = () => cgTree('flat', { [`${UNIT}/memory.max`]: `${CAP}\n`, [`${UNIT}/memory.swap.max`]: '0\n', [`${UNIT}/memory.high`]: 'max\n', [`${UNIT}/memory.events`]: 'low 0\nhigh 0\nmax 3\noom 2\noom_kill 2\n' });
const leaves = () => cgTree('leaves', {
  [`${UNIT}/memory.max`]: 'max\n', [`${UNIT}/memory.swap.max`]: '0\n', [`${UNIT}/memory.high`]: 'max\n', [`${UNIT}/memory.events`]: 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n',
  [`${UNIT}/k/memory.max`]: 'max\n', [`${UNIT}/k/memory.events`]: 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n',
  [`${UNIT}/w/memory.max`]: `${CAP}\n`, [`${UNIT}/w/memory.events`]: 'low 0\nhigh 0\nmax 5\noom 4\noom_kill 4\n',
});
const noPolicy = { policyOf: () => 'continue' };

test('scopeDirOf / capCarrierOf: the keeper\'s cgroup is the scope or one of its two leaves; the cap sits on the work leaf when there is one, else on the scope', () => {
  const u = `/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/${UNIT}`;
  assert.equal(scopeDirOf(u), u, 'a flat scope');
  assert.equal(scopeDirOf(`${u}/k`), u, 'the keeper leaf → its scope');
  assert.equal(scopeDirOf(`${u}/w`), u, 'the work leaf → its scope');
  assert.equal(scopeDirOf('/sys/fs/cgroup/user.slice/app.slice/k'), '/sys/fs/cgroup/user.slice/app.slice/k', 'a directory merely NAMED k outside a scope is left alone');
  assert.equal(scopeDirOf(`${u}/other`), `${u}/other`);
  assert.equal(scopeDirOf(null), null);
  assert.equal(capCarrierOf(u, () => true), `${u}/w`);
  assert.equal(capCarrierOf(u, () => false), u);
  assert.equal(capCarrierOf(null), null);
});

test('scope facts from a FLAT scope and from a scope with LEAVES: memoryMax is the limit of the cgroup that carries the cap; swap / high / unit are the scope\'s; the layout is named', () => {
  const f = scopeFactsFromDir(path.join(flat(), UNIT), 'orchestra-rig-wh-h3-', noPolicy);
  assert.deepEqual({ inRig: f.inRig, unit: f.unit, memoryMax: f.memoryMax, swapMax: f.swapMax, high: f.high, layout: f.layout, policy: f.policy }, { inRig: true, unit: UNIT, memoryMax: CAP, swapMax: '0', high: 'max', layout: 'flat', policy: 'continue' });
  const l = scopeFactsFromDir(path.join(leaves(), UNIT), 'orchestra-rig-wh-h3-', noPolicy);
  assert.deepEqual({ inRig: l.inRig, unit: l.unit, memoryMax: l.memoryMax, swapMax: l.swapMax, high: l.high, layout: l.layout }, { inRig: true, unit: UNIT, memoryMax: CAP, swapMax: '0', high: 'max', layout: 'leaves' }, 'the scope\'s own memory.max is "max" (no backstop): the work leaf\'s limit is the one reported');
  assert.equal(scopeFactsFromDir(path.join(leaves(), UNIT), 'some-other-prefix-', noPolicy).inRig, false);
  const none = scopeFactsFromDir(null, 'orchestra-rig-wh-h3-', noPolicy);
  assert.deepEqual({ unit: none.unit, memoryMax: none.memoryMax, layout: none.layout, policy: none.policy }, { unit: null, memoryMax: null, layout: null, policy: null }, 'no scope: nothing is invented');
});

test('the kill counter is the one of the cgroup that carries the cap: the work leaf\'s (4), never the keeper leaf\'s or the idle scope\'s (0); a flat scope\'s own', () => {
  assert.equal(oomKillFromDir(path.join(leaves(), UNIT)), 4);
  assert.equal(oomKillFromDir(path.join(flat(), UNIT)), 2);
  assert.equal(oomKillFromDir(path.join(base, 'cg', 'does-not-exist')), null, 'unreadable counter is null, never 0');
  assert.equal(oomKillFromDir(null), null);
});

test('the leaf names are pinned to the product\'s: src/shared/memory-scope.ts exports them (#332) or has no leaves yet — either way the harness\' pair is exactly k / w', () => {
  assert.deepEqual([...SCOPE_LEAVES], ['k', 'w']);
  assert.equal(WORK_LEAF, 'w');
  const src = fs.readFileSync(fileURLToPath(new URL('../shared/memory-scope.ts', import.meta.url)), 'utf8');
  if (src.includes('SCOPE_LEAF_WORK')) {
    assert.match(src, /export const SCOPE_LEAF_KEEPER = 'k';/);
    assert.match(src, /export const SCOPE_LEAF_WORK = 'w';/);
  } else {
    assert.ok(!src.includes('SCOPE_LEAVES'), 'a product without the SCOPE_LEAF_* constants has no half-defined leaves either');
  }
});

test('#343 counters from fake cgroup trees: the keeper leaf\'s, the scope\'s (hierarchical) and the work leaf\'s oom_kill; a flat scope has no keeper leaf (0) and its own counter IS the work one; unreadable = null', () => {
  assert.equal(KEEPER_LEAF, 'k');
  // a scope that took 4 hog kills in w AND 1 backstop kill in k: its hierarchical counter is 5
  const l = cgTree('bs-leaves', {
    [`${UNIT}/memory.events`]: 'oom_kill 5\n', [`${UNIT}/k/memory.events`]: 'oom_kill 1\n', [`${UNIT}/w/memory.events`]: 'oom_kill 4\n',
  });
  assert.deepEqual(backstopCountersFromDir(path.join(l, UNIT)), { k: 1, scope: 5, work: 4, layout: 'leaves' });
  const f = flat();
  assert.deepEqual(backstopCountersFromDir(path.join(f, UNIT)), { k: 0, scope: 2, work: 2, layout: 'flat' });
  assert.equal(backstopCountersFromDir(null), null);
  const broken = cgTree('bs-broken', { [`${UNIT}/memory.events`]: 'oom_kill 0\n', [`${UNIT}/w/memory.events`]: 'oom_kill 0\n' });   // the k leaf is missing its file
  assert.equal(backstopCountersFromDir(path.join(broken, UNIT)), null, 'ONE unreadable counter makes the whole reading null (never 0, never a half reading that could replace a good one)');
});

test('keeperLogText: the rotated .log.old comes first, then the current .log; a missing file reads as empty, never a throw', () => {
  const h = cgTree('kl', { 'keepers/ws1.log.old': '[keeper t] old\n', 'keepers/ws1.log': '[keeper t] new\n', 'keepers/ws2.log': '[keeper t] only\n' });
  assert.equal(keeperLogText(h, 'ws1'), '[keeper t] old\n\n[keeper t] new\n');
  assert.equal(keeperLogText(h, 'ws2'), '\n[keeper t] only\n');
  assert.equal(keeperLogText(h, 'nope'), '\n');
});

test('the FLOOR guard\'s hog selection (review 4, M1): only processes running swarm.py with their working directory under THE rig dir are listed and killed (identity re-read); a swarm.py elsewhere, a non-hog in the rig and a sibling rig whose dir merely starts with ours are left alone', async () => {
  const rigDir = path.join(base, 'floorrig');
  fs.mkdirSync(path.join(rigDir, 'wt-w1'), { recursive: true });
  fs.mkdirSync(path.join(base, 'floorrig-sibling', 'wt-w1'), { recursive: true });
  fs.mkdirSync(path.join(base, 'elsewhere'), { recursive: true });
  const proc = (cwd: string, argv: string[]): ChildProcess => {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e9)', '--', ...argv], { cwd, stdio: 'ignore', detached: true });
    kids.push(c);
    return c;
  };
  const hog = proc(path.join(rigDir, 'wt-w1'), ['/repo/scripts/memory-cap/swarm.py', '1', '1174', '5', 'memhog-w1-c1']);
  const hogChild = proc(path.join(rigDir, 'wt-w1'), ['swarm.py', '1', '1174', '5', 'memhog-w1-c1']);
  const other = proc(path.join(rigDir, 'wt-w1'), ['not-a-hog.py']);
  const elsewhere = proc(path.join(base, 'elsewhere'), ['swarm.py']);
  const sibling = proc(path.join(base, 'floorrig-sibling', 'wt-w1'), ['swarm.py']);
  await new Promise((r) => setTimeout(r, 400));
  const listed = hogProcesses(rigDir).map((p: { pid: number }) => p.pid).sort();
  assert.deepEqual(listed, [hog.pid, hogChild.pid].sort(), 'exactly the two hogs');
  assert.ok(hogProcesses(rigDir).every((p: { ticks: string }) => typeof p.ticks === 'string'), 'each carries its identity');
  const done = killHogs(rigDir);
  assert.deepEqual(done.sort(), [hog.pid, hogChild.pid].sort());
  assert.equal(await gone(hog.pid as number), true);
  assert.equal(await gone(hogChild.pid as number), true);
  for (const c of [other, elsewhere, sibling]) assert.equal(alive(c.pid), true);
  assert.deepEqual(killHogs(rigDir), [], 'nothing left to stop');
  // identity: a recycled pid (another start time) is not signalled
  const hog2 = proc(path.join(rigDir, 'wt-w1'), ['swarm.py']);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(killHogs(rigDir, { readCmd: () => '', cwdOf: () => null }), [], 'the injected readers can say « no hog »: the selection is the readers\', not luck');
  assert.equal(alive(hog2.pid), true);
  // identity re-read at signal time: a pid whose start time changed between the listing and the kill (a recycled pid) is NOT signalled
  let n = 0;
  assert.deepEqual(killHogs(rigDir, { ticksOf: () => `t${n++}` }), [], 'listing saw t0, the kill saw t1: another process now');
  assert.equal(alive(hog2.pid), true);
  assert.deepEqual(killHogs(rigDir, { ticksOf: () => 'same' }), [hog2.pid], 'control: a stable identity is signalled');
  assert.equal(await gone(hog2.pid as number), true);
});

test('ownPlacementWhy (review 4, m6): a rig must not be started from inside a member\'s scope leaf or at oom_score_adj > 0', () => {
  const cg = (p: string) => `0::${p}\n`;
  assert.equal(ownPlacementWhy({ cgroupText: cg('/user.slice/app.slice/app-orchestra-1.scope'), adjText: '0\n' }), null);
  assert.equal(ownPlacementWhy({ cgroupText: cg('/user.slice/app.slice/u.scope'), adjText: '0' }), null, 'a flat scope is not a leaf');
  assert.match(String(ownPlacementWhy({ cgroupText: cg('/user.slice/app.slice/orchestra-member-x.scope/w'), adjText: '0' })), /runs inside .*scope\/w/);
  assert.match(String(ownPlacementWhy({ cgroupText: cg('/user.slice/app.slice/orchestra-member-x.scope/k'), adjText: '0' })), /runs inside/);
  assert.equal(ownPlacementWhy({ cgroupText: cg('/user.slice/app.slice/work/w'), adjText: '0' }), null, 'a directory merely named w outside a scope');
  assert.match(String(ownPlacementWhy({ cgroupText: cg('/x/u.scope'), adjText: '1000\n' })), /oom_score_adj is 1000/);
  assert.match(String(ownPlacementWhy({ cgroupText: cg('/x/u.scope'), adjText: '' })), /unreadable/);
  assert.match(String(ownPlacementWhy({ cgroupText: cg('/x/u.scope'), adjText: 'abc' })), /unreadable/);
});
