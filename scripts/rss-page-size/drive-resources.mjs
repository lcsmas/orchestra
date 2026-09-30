#!/usr/bin/env node
// Drives the REAL src/main/resources.ts `sampleResources()` (the Resources page's sampler; only pty/events/statfs/platform
// are stubbed) over the REAL /proc: a session tree = this process + a child holding ~200 MB, compared with Σ VmRSS read
// independently from /proc/<pid>/status. Prints `RESOURCES-PAGE-SAMPLER: PASS|FAIL ratio <r>`.
// Run: node --experimental-strip-types --import ./scripts/rss-page-size/register-resources-stubs.mjs scripts/rss-page-size/drive-resources.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = await import(path.join(ROOT, 'src/main/resources.ts'));
const vm = (pid) => Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]) * 1024;
const child = spawn(process.execPath, ['-e', "const b = Buffer.alloc(200 * 1024 * 1024, 1); process.stdout.write('ready\\n'); setInterval(() => b[0]++, 1000);"], { stdio: ['ignore', 'pipe', 'ignore'] });
try {
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('exit', () => reject(new Error('child exited early'))); setTimeout(() => reject(new Error('child not ready')), 20000); });
  globalThis.__PTY = [{ id: 'ws-r', pid: process.pid, remote: false }];
  const snap = await R.sampleResources();
  const s = snap.sessions.find((x) => x.ptyId === 'ws-r');
  const truth = vm(process.pid) + vm(child.pid);
  const got = s?.memBytes ?? 0;
  const ratio = got / truth;
  console.log(`Resources page sampler: tree memBytes = ${Math.round(got / 2 ** 20)} MB ; Σ VmRSS(tree) = ${Math.round(truth / 2 ** 20)} MB ; procs ${s?.processes?.length}`);
  console.log(`RESOURCES-PAGE-SAMPLER: ${s && Math.abs(ratio - 1) <= 0.15 ? 'PASS' : 'FAIL'} ratio ${ratio.toFixed(3)}`);
  process.exitCode = s && Math.abs(ratio - 1) <= 0.15 ? 0 : 1;
} finally { child.kill('SIGKILL'); }
