import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
// @ts-expect-error — a plain .mjs helper shared with the mutant harnesses
import { descendantsOf, settleBackups } from '../../scripts/mutant-survivors.mjs';

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
