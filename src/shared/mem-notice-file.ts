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

/** The prune verdict: the file may go only if it was READ, holds nothing we could not parse, and every record in it is delivered. An unreadable or half-understood file is never «delivered» (review F3). */
export function mayPrune(read: NoticeRead, seen: (unit: string) => number): boolean {
  return read.ok && read.unparsed === 0 && fullyDelivered(read.recs, seen);
}

export { isSoftRecord };
