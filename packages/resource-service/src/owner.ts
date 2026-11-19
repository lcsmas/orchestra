// Who is the coordinator of a run. A numeric pid → its identity (pid + starttime). `auto` (A6) → the nearest ancestor of THIS command that is a Claude Code session.
import fs from 'node:fs';
import path from 'node:path';
import { refused, usageError } from './errors.ts';
import { identityOf, readStat, type Identity } from './proc.ts';

/** What the ancestor walk reads of a process; injectable so the walk is testable on a fabricated tree. */
export type ProcView = {
  stat(pid: number): { ppid: number; startTime: number } | null;
  comm(pid: number): string | null;
  /** Basename of `/proc/<pid>/exe`, or null. */
  exeName(pid: number): string | null;
};

export const realProc: ProcView = {
  stat: (pid) => readStat(pid),
  comm: (pid) => {
    try {
      return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').replace(/\n$/, '');
    } catch {
      return null;
    }
  },
  exeName: (pid) => {
    try {
      return path.basename(fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''));
    } catch {
      return null;
    }
  },
};

/** A Claude Code process: its `comm` is `claude`; a native install's exe basename is the VERSION (`.../versions/2.1.325`), a symlinked one may be `claude`. */
export const isClaude = (comm: string | null, exe: string | null): boolean => comm === 'claude' || exe === 'claude';

const MAX_HOPS = 64;

export type AncestorWalk = { found: Identity | null; chain: string[] };

/** Walk the ppid chain up from `from` (itself the first candidate) and return the NEAREST `claude`, plus the chain seen. */
export function findClaudeAncestor(from: number, view: ProcView = realProc): AncestorWalk {
  const chain: string[] = [];
  const seen = new Set<number>();
  for (let pid = from, hop = 0; pid > 1 && !seen.has(pid) && hop < MAX_HOPS; hop++) {
    seen.add(pid);
    const st = view.stat(pid);
    if (!st) break;
    const comm = view.comm(pid);
    const exe = view.exeName(pid);
    chain.push(`${comm ?? '?'}(${pid})`);
    if (isClaude(comm, exe)) return { found: { pid, startTime: st.startTime }, chain };
    pid = st.ppid;
  }
  return { found: null, chain };
}

export async function resolveOwner(spec: string | undefined): Promise<Identity> {
  if (spec === undefined) throw usageError('--owner <pid|auto> is required');
  if (spec === 'auto') {
    const { found, chain } = findClaudeAncestor(readStat(process.pid)?.ppid ?? process.ppid);
    if (!found) throw refused(`--owner auto: no Claude Code session above this command (walked ${chain.join(' < ') || 'nothing'}; looking for a process named "claude"). Run it from an agent's shell, or pass --owner <pid>`);
    const id = identityOf(found.pid);
    if (!id || id.startTime !== found.startTime) throw refused(`--owner auto: the Claude Code session (pid ${found.pid}) is gone`);
    return id;
  }
  if (!/^\d+$/.test(spec)) throw usageError(`--owner expects a pid or "auto", got ${JSON.stringify(spec)}`);
  const pid = Number(spec);
  if (pid <= 1) throw usageError(`--owner ${pid}: refusing pid <= 1 (it would never die)`);
  const id = identityOf(pid);
  if (!id) throw refused(`--owner ${pid}: no such running process`);
  return id;
}
