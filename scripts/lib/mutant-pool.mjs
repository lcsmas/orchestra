// #623 — run the mutants of a mutant rig in parallel: the parent re-launches ITSELF once per mutant (env MUT_CHILD=<id>, own scratch dir / own temp copy, so nothing is shared)
// through a bounded pool and prints each child's output in mutant order. A child exits 0 = KILLED, 3 = SURVIVED, anything else = the rig itself broke (counted, never a silent pass).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

export const MUT_JOBS = Math.max(1, Number(process.env.MUTANT_JOBS) || Math.min(4, os.availableParallelism()));
export const EXIT_KILLED = 0, EXIT_SURVIVED = 3;

/** Run `fn(item)` over `items` with at most `jobs` in flight; results keep the order of `items`. */
export async function pool(items, fn, jobs = MUT_JOBS) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => { for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i], i); }));
  return out;
}

/** Re-run this very script (same argv) with extra env; resolves {code, out} (stdout+stderr), never rejects. */
export function selfChild(env, timeoutMs = 25 * 60_000) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('close', (code, sig) => { clearTimeout(t); resolve({ code: code ?? (sig ? 128 : 1), out }); });
  });
}

/** Parent side: run every id as a child, print outputs in order, return {survived, broken, codes}. */
export async function runMutantChildren(ids, envName = 'MUT_CHILD', okCodes = []) {
  const res = await pool(ids, (id) => selfChild({ [envName]: String(id) }));
  let survived = 0, broken = 0;
  for (const r of res) {
    writeAllSync(r.out.endsWith('\n') ? r.out : r.out + '\n');
    if (r.code === EXIT_SURVIVED) survived++; else if (r.code !== EXIT_KILLED && !(okCodes ?? []).includes(r.code)) { broken++; writeAllSync(`   → BROKEN (the mutant run exited ${r.code}: the rig itself failed, not a verdict)\n`); }
  }
  return { survived, broken, codes: res.map((r) => r.code) };
}

/** Blocking write of ALL of `text` to fd 1 (a pipe/socket the runner reads): a burst through process.stdout.write + process.exit() lost the last mutants' lines on CI (#623: harness-amend 26 of 38, acceptance-forced 11 of 34). */
export function writeAllSync(text) {
  const buf = Buffer.from(text); let off = 0;
  while (off < buf.length) {
    try { off += fs.writeSync(1, buf, off); }
    catch (e) { if (e.code !== 'EAGAIN') throw e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); }
  }
}

/** Exit once what console.log queued is flushed too (stdout.writableLength counts bytes libuv has not completed). */
export async function exitAfterFlush(code) {
  process.exitCode = code;
  for (let i = 0; i < 500 && process.stdout.writableLength > 0; i++) await new Promise((r) => setTimeout(r, 10));
  process.exit(code);
}
