// #322 m1: the keeper's DURABLE record of what the Plafond mémoire did (kills and warning-level crossings), one JSON line each, appended BEFORE anyone is told.
// The host reads it whenever it re-attaches or finds the keeper gone — a kill recorded while the app was closed must not die with the keeper's memory.

import fs from 'node:fs';
import { isSoftRecord, type MemKillRecord, type MemNoticeRecord, type MemSoftRecord } from './memory-scope.ts';

/** A keeper stops appending past this many lines (a runaway loop of kills must not fill the disk); the host sees the cap in the keeper log. */
export const MAX_NOTICE_LINES = 500;

/** Append one record (O_APPEND + fsync). Returns false — never throws — when the file cannot be written: persistence is best effort, the live frame still goes out. */
export function appendMemNotice(file: string, rec: MemNoticeRecord): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'a', 0o600);
    fs.writeSync(fd, JSON.stringify(rec) + '\n');
    fs.fsyncSync(fd);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* closed */
      }
    }
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate one parsed line; null for anything that is not a well-formed record (a torn last line after a crash, a foreign file). */
export function parseMemNotice(v: unknown): MemNoticeRecord | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.unit !== 'string' || !r.unit || !isNum(r.seq) || !isNum(r.at)) return null;
  if (r.kind === 'soft') {
    if (!isNum(r.bytes) || !isNum(r.softBytes)) return null;
    return { kind: 'soft', seq: r.seq, at: r.at, unit: r.unit, bytes: r.bytes, softBytes: r.softBytes, hardBytes: isNum(r.hardBytes) ? r.hardBytes : null } satisfies MemSoftRecord;
  }
  if (r.level !== 'hard' && r.level !== 'external') return null;
  return {
    kind: 'kill',
    ...(r.source === 'kernel' || r.source === 'inferred' ? { source: r.source } : {}),
    seq: r.seq,
    at: r.at,
    level: r.level,
    command: typeof r.command === 'string' ? r.command : null,
    pid: isNum(r.pid) ? r.pid : null,
    rssBytes: isNum(r.rssBytes) ? r.rssBytes : null,
    candidates: Array.isArray(r.candidates) ? r.candidates.filter((c): c is string => typeof c === 'string').slice(0, 5) : [],
    unit: r.unit,
    hardBytes: isNum(r.hardBytes) ? r.hardBytes : null,
  } satisfies MemKillRecord;
}

/** Every well-formed record of the file, in file order; [] when absent/unreadable. */
export function readMemNotices(file: string): MemNoticeRecord[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: MemNoticeRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = parseMemNotice(JSON.parse(line));
      if (rec) out.push(rec);
    } catch {
      /* a torn line */
    }
  }
  return out;
}

export { isSoftRecord };
