import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// #389 — scripts/lib/rig-procs.mjs: process identity by (pid, start time), the thing every rig teardown signals through.
type Procs = {
  procStat: (pid: number) => { state: string; start: string } | null;
  isAlive: (pid: number, start: string) => boolean;
  descendantsOf: (root: number) => number[];
  signalIfSame: (pid: number, start: string, sig: NodeJS.Signals) => boolean;
};
const { procStat, isAlive, descendantsOf, signalIfSame } = (await import(pathToFileURL(path.join(import.meta.dirname, '../../scripts/lib/rig-procs.mjs')).href)) as Procs;

const sleeper = (): { pid: number; kill: () => void } => {
  const c = spawn('sleep', ['30'], { stdio: 'ignore' });
  return { pid: c.pid as number, kill: () => { try { c.kill('SIGKILL'); } catch {} } };
};

test('isAlive is true only for the SAME process: a recycled pid (same number, different start time) is not it', () => {
  const s = sleeper();
  try {
    const st = procStat(s.pid);
    assert.ok(st && st.state !== 'Z' && /^\d+$/.test(st.start), JSON.stringify(st));
    assert.equal(isAlive(s.pid, st.start), true, 'control: the process it was recorded from');
    assert.equal(isAlive(s.pid, String(Number(st.start) + 1)), false, 'same pid, other start time = a different process (pid reuse)');
    assert.equal(isAlive(2 ** 22 + 12345, st.start), false, 'a pid that does not exist');
  } finally { s.kill(); }
});

test('signalIfSame signals the recorded process and NEVER a stand-in carrying the same pid', () => {
  const s = sleeper();
  try {
    const st = procStat(s.pid) as { start: string };
    assert.equal(signalIfSame(s.pid, String(Number(st.start) + 1), 'SIGKILL'), false, 'identity mismatch → no signal');
    assert.equal(isAlive(s.pid, st.start), true, 'and the process is untouched');
    assert.equal(signalIfSame(s.pid, st.start, 'SIGKILL'), true, 'identity match → signalled');
    for (let i = 0; i < 100 && isAlive(s.pid, st.start); i++) spawnSync('sleep', ['0.05']);
    assert.equal(isAlive(s.pid, st.start), false, 'it died');
    assert.equal(signalIfSame(s.pid, st.start, 'SIGKILL'), false, 'a dead process is not signalled again');
  } finally { s.kill(); }
});

test('isAlive is false for a zombie (a killed-but-unreaped child still has a /proc entry)', () => {
  const c = spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' });
  for (let i = 0; i < 100 && procStat(c.pid as number)?.state !== 'Z'; i++) spawnSync('sleep', ['0.02']); // parent (this test) has not reaped it: spawnSync does not yield to the event loop
  const st = procStat(c.pid as number);
  if (st) assert.equal(isAlive(c.pid as number, st.start), st.state !== 'Z', `state ${st.state}`);
  assert.ok(st === null || st.state === 'Z' || st.state === 'S' || st.state === 'R');
});

test('descendantsOf: the root and its descendants only — never an unrelated process', () => {
  const sh = spawn('sh', ['-c', 'sleep 30 & sleep 30 & wait'], { stdio: 'ignore' });
  const unrelated = sleeper();
  try {
    let d: number[] = [];
    for (let i = 0; i < 100 && d.length < 3; i++) { spawnSync('sleep', ['0.05']); d = descendantsOf(sh.pid as number); }
    assert.equal(d.length, 3, `sh + 2 sleeps: ${d}`);
    assert.ok(d.includes(sh.pid as number));
    assert.ok(!d.includes(unrelated.pid), 'a sibling is not a descendant');
    assert.ok(!d.includes(process.pid));
    assert.deepEqual(descendantsOf(2 ** 22 + 777), [2 ** 22 + 777], 'a missing root yields only itself (no throw)');
  } finally { try { process.kill(-(sh.pid as number), 'SIGKILL'); } catch {} sh.kill('SIGKILL'); unrelated.kill(); spawnSync('pkill', ['-P', String(sh.pid), '-KILL']); }
});
