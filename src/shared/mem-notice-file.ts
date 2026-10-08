// #322 m1: the keeper's DURABLE record of what the Plafond mémoire did (kills and warning-level crossings), one JSON line each, appended BEFORE anyone is told.
// The host reads it whenever it re-attaches or finds the keeper gone — a kill recorded while the app was closed must not die with the keeper's memory.

import fs from 'node:fs';
import { isSoftRecord, type MemKillRecord, type MemNoticeRecord, type MemSoftRecord } from './memory-scope.ts';

/** A keeper stops appending KILLS past this many lines (a runaway loop of kills must not fill the disk); the host sees the cap in the keeper log. */
export const MAX_NOTICE_LINES = 500;
/** Warning-level records have their OWN, smaller budget: a scope pulsing around its level must never use up the lines a later KILL needs (review F5). */
export const MAX_SOFT_NOTICE_LINES = 100;

/** Append one record (O_APPEND + fsync). Returns false — never throws — when the file cannot be written: persistence is best effort, the live frame still goes out.
 *  The record is written on its OWN line (a leading newline) and the write is looped to completion: a short write leaves a torn tail that must never be glued to the next record (review F3). */
export function appendMemNotice(file: string, rec: MemNoticeRecord, write: (fd: number, buf: Buffer, off: number) => number = (fd, buf, off) => fs.writeSync(fd, buf, off)): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'a', 0o600);
    const buf = Buffer.from('\n' + JSON.stringify(rec) + '\n');
    let off = 0;
    while (off < buf.length) {
      const n = write(fd, buf, off);
      if (n <= 0) throw new Error('short write');
      off += n;
    }
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
    return { kind: 'soft', seq: r.seq, at: r.at, unit: r.unit, bytes: r.bytes, softBytes: r.softBytes, hardBytes: isNum(r.hardBytes) ? r.hardBytes : null, ...(isNum(r.suppressed) && r.suppressed > 0 ? { suppressed: r.suppressed } : {}) } satisfies MemSoftRecord;
  }
  if (r.level !== 'hard' && r.level !== 'external') return null;
  return {
    kind: 'kill',
    ...(r.source === 'kernel' || r.source === 'inferred' ? { source: r.source } : {}),
    ...(r.role === 'cli' || r.role === 'keeper' ? { role: r.role } : {}), // the SESSION ended: it must survive the trip through the file (review round 2 M1)
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

/** What reading a notice file found. `ok:false` = the file exists but could not be READ (permissions, EMFILE, EIO…): that is UNKNOWN, never «nothing to deliver» (review F3). `unparsed` = non-empty lines that were not records. */
export type NoticeRead = { ok: true; recs: MemNoticeRecord[]; unparsed: number } | { ok: false; error: string };

export function readMemNoticesChecked(file: string): NoticeRead {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { ok: true, recs: [], unparsed: 0 } : { ok: false, error: String((e as Error).message ?? e) };
  }
  const recs: MemNoticeRecord[] = [];
  let unparsed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = parseMemNotice(JSON.parse(line));
      if (rec) recs.push(rec);
      else unparsed += 1;
    } catch {
      unparsed += 1;
    }
  }
  return { ok: true, recs, unparsed };
}

/** Every well-formed record of the file, in file order; [] when absent OR unreadable (use {@link readMemNoticesChecked} when the difference matters). */
export function readMemNotices(file: string): MemNoticeRecord[] {
  const r = readMemNoticesChecked(file);
  return r.ok ? r.recs : [];
}

/** May the host delete a notice file? Only when EVERY record in it is delivered (its seq is at or below the per-unit cursor) — an undelivered record is the only copy a gone keeper leaves. */
export function fullyDelivered(recs: readonly MemNoticeRecord[], seen: (unit: string) => number): boolean {
  return recs.every((r) => r.seq <= seen(r.unit));
}

/** What to do with a notice file after a drain: `prune` only if it was READ, every line was understood and every record is delivered; `quarantine` (rename aside, keep the evidence) if everything we understood is delivered but
 *  some line is not understood - a crash-torn tail must not block the file for ever (round 2 m2); `keep` otherwise - an unreadable or undelivered file is never «delivered» (review F3). */
export function pruneVerdict(read: NoticeRead, seen: (unit: string) => number): 'prune' | 'quarantine' | 'keep' {
  if (!read.ok || !fullyDelivered(read.recs, seen)) return 'keep';
  return read.unparsed === 0 ? 'prune' : 'quarantine';
}

export const mayPrune = (read: NoticeRead, seen: (unit: string) => number): boolean => pruneVerdict(read, seen) === 'prune';

/** The keeper's notice-file budget: kills and warnings are counted APART, so a scope pulsing around its level can never use up the lines a later KILL needs (review F5). */
export function createNoticeBudget(maxKills = MAX_NOTICE_LINES, maxSofts = MAX_SOFT_NOTICE_LINES) {
  let kills = 0;
  let softs = 0;
  return {
    /** Reserve a line for a record of `kind`; `write:false` once its own budget is spent (`justFull` is true on the first refusal, for ONE log line). */
    take(kind: 'kill' | 'soft'): { write: boolean; justFull: boolean } {
      const n = kind === 'soft' ? softs : kills;
      const max = kind === 'soft' ? maxSofts : maxKills;
      if (kind === 'soft') softs += 1;
      else kills += 1;
      return { write: n < max, justFull: n === max };
    },
    /** The append failed: give the reservation back. */
    release(kind: 'kill' | 'soft'): void {
      if (kind === 'soft') softs -= 1;
      else kills -= 1;
    },
  };
}

export { isSoftRecord };
