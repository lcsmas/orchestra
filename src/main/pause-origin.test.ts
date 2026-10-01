// #252 D1b (review F5) — the pausing call's process chain. Pure reader over an injected /proc, plus the real /proc for this very process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readProcessChain } from './pause-origin.ts';

const stat = (pid: number, ppid: number, start: number, comm = 'x'): string =>
  `${pid} (${comm}) S ${ppid} ${pid} ${pid} 0 -1 4194560 0 0 0 0 1 1 0 0 20 0 1 0 ${start} 1000 100 18446744073709551615`;

test('the chain runs from the caller UP to (excluding) init, with pid + ppid + start-time + comm', () => {
  const table: Record<number, string> = { 300: stat(300, 250, 3000, 'orchestra'), 250: stat(250, 200, 2500, 'bash'), 200: stat(200, 100, 2000, 'zsh'), 100: stat(100, 90, 1000, 'claude'), 90: stat(90, 1, 900, 'node') };
  const chain = readProcessChain(300, (pid) => table[pid] ?? null);
  assert.deepEqual(chain.map((c) => [c.pid, c.ppid, c.startTicks, c.comm]), [[300, 250, 3000, 'orchestra'], [250, 200, 2500, 'bash'], [200, 100, 2000, 'zsh'], [100, 90, 1000, 'claude'], [90, 1, 900, 'node']]);
});

test('an unreadable ancestor ends the chain (no throw); a cycle and the depth cap terminate', () => {
  assert.deepEqual(readProcessChain(5, (pid) => (pid === 5 ? stat(5, 4, 50) : null)).map((c) => c.pid), [5]);
  const cyc: Record<number, string> = { 5: stat(5, 6, 50), 6: stat(6, 5, 60) };
  assert.deepEqual(readProcessChain(5, (pid) => cyc[pid] ?? null).map((c) => c.pid), [5, 6]);
  const deep = (pid: number): string => stat(pid, pid + 1, pid);
  assert.equal(readProcessChain(10, deep, 7).length, 7);
});

test('the real /proc: this process is the first link, with its own real start-time, and the chain ends below init', () => {
  if (process.platform !== 'linux') return;
  const chain = readProcessChain();
  assert.equal(chain[0].pid, process.pid);
  assert.ok(chain[0].startTicks > 0);
  assert.ok(chain.every((c) => c.pid > 1));
  assert.ok(chain.length >= 2, 'has at least a parent');
});
