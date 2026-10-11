// Test-only teardown BY IDENTITY (D2), shared by keeper.test.ts and keeper-memory-cap.test.ts: a pid is only ever signalled after its /proc start time is re-read and found equal to the one recorded
// when it was launched/seen (a recycled pid is a stranger). Not a test file (no `.test.ts`) — never shipped: nothing in src/main, src/renderer or src/cli imports it.

import fs from 'node:fs';

export interface Ident { pid: number; ticks: string }
export interface Carrier extends Ident { ppid: number; cmd: string }
export interface Stat { state: string; ppid: number; pgrp: number; ticks: string }

const readSafe = (p: string): string | null => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

/** state / ppid / pgrp / start time (clock ticks since boot) of `pid`, or null when it is gone. The comm field may hold spaces and parens — parse from the LAST ')'. */
export function statOf(pid: number): Stat | null {
  const t = readSafe(`/proc/${pid}/stat`);
  if (!t) return null;
  const f = t.slice(t.lastIndexOf(')') + 2).split(' ');
  return f[19] === undefined ? null : { state: f[0], ppid: Number(f[1]), pgrp: Number(f[2]), ticks: f[19] };
}

/** The identity of a LIVE (non-zombie) process, or null. */
export function identOf(pid: number): Ident | null {
  const s = statOf(pid);
  return s && s.state !== 'Z' ? { pid, ticks: s.ticks } : null;
}

/** SIGKILL `id` only if it is still the process that was recorded (start time re-read right before the signal). Returns whether a signal was sent. */
export function killIdent(id: Ident): boolean {
  if (statOf(id.pid)?.ticks !== id.ticks) return false;
  try { process.kill(id.pid, 'SIGKILL'); return true; } catch { return false; }
}

/** Live processes whose argv carries `dir` (every test process embeds its own scratch dir). `orEnv` also reads /proc/<pid>/environ (a CLI whose argv does not name the dir). The caller's own pid is excluded. */
export function carrying(dir: string, orEnv = false): Carrier[] {
  if (dir.length < 12) throw new Error(`refusing to sweep for a short/empty dir ${JSON.stringify(dir)} (it would match unrelated processes)`);
  const out: Carrier[] = [];
  for (const name of fs.readdirSync('/proc')) {
    const pid = Number(name);
    if (!/^\d+$/.test(name) || pid === process.pid) continue;
    const cmd = readSafe(`/proc/${name}/cmdline`);
    const hit = cmd?.includes(dir) || (orEnv && !!readSafe(`/proc/${name}/environ`)?.includes(dir));
    const s = hit ? statOf(pid) : null;
    if (s && s.state !== 'Z') out.push({ pid, ticks: s.ticks, ppid: s.ppid, cmd: (cmd ?? '').replace(/\0/g, ' ') });
  }
  return out;
}

/** The live members of `leader`'s process group — [] unless `leader` is STILL the process recorded (a dead leader's pgid number may have been recycled; its carriers are swept by dir instead). */
export function groupOf(leader: Ident): Ident[] {
  if (statOf(leader.pid)?.ticks !== leader.ticks) return [];
  const out: Ident[] = [];
  for (const name of fs.readdirSync('/proc')) {
    const s = /^\d+$/.test(name) ? statOf(Number(name)) : null;
    if (s && s.pgrp === leader.pid && s.state !== 'Z') out.push({ pid: Number(name), ticks: s.ticks });
  }
  return out;
}

/** Kill everything a suite started and return the survivors (must be []): each recorded leader's process group first, then anything still carrying one of `dirs` — every signal identity-checked. Idempotent. */
export async function reap(leaders: Ident[], dirs: string[], orEnv = false): Promise<Carrier[]> {
  for (const l of leaders) for (const m of groupOf(l)) killIdent(m);
  for (let round = 0; round < 20; round++) {
    const left = dirs.flatMap((d) => carrying(d, orEnv));
    if (left.length === 0) break;
    for (const s of left) killIdent(s);
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  return dirs.flatMap((d) => carrying(d, orEnv));
}
