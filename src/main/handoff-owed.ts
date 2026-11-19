// #466 follow-up (m1) — the OWED OPENING marker: `<handoff dir>/<ws>/owed.json`, written BEFORE the context is ended and removed once the opening turn was
// delivered. A failed or held delivery (Pause between clear and start, spawn error, an app quit while held) leaves it on disk, and an app-start / retry sweep
// re-delivers it — the summary is never only in memory. Platform-free (a directory is passed in) so it is unit-tested without Electron.

import fs from 'node:fs';
import path from 'node:path';

export interface OwedOpening {
  /** The full opening turn (frame + summary) to deliver. */
  opening: string;
  /** The saved summary file (for the report). */
  file: string;
  /** When the handoff was accepted (ms). */
  at: number;
}

const FILE = 'owed.json';

export function writeOwed(root: string, wsId: string, rec: OwedOpening): void {
  const dir = path.join(root, wsId);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${FILE}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  fs.renameSync(tmp, path.join(dir, FILE)); // atomic: a crash leaves the old marker or the new one, never half
}

export function readOwed(root: string, wsId: string): OwedOpening | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, wsId, FILE), 'utf8')) as Partial<OwedOpening>;
    return typeof v.opening === 'string' && v.opening && typeof v.file === 'string' && typeof v.at === 'number' ? { opening: v.opening, file: v.file, at: v.at } : null;
  } catch {
    return null;
  }
}

export function clearOwed(root: string, wsId: string): void {
  try {
    fs.rmSync(path.join(root, wsId, FILE), { force: true });
  } catch {
    /* an unremovable marker is re-delivered at most once more — the opening is idempotent text */
  }
}

/** Every workspace id with a readable marker. */
export function listOwed(root: string): Array<{ wsId: string; rec: OwedOpening }> {
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: Array<{ wsId: string; rec: OwedOpening }> = [];
  for (const wsId of names) {
    const rec = readOwed(root, wsId);
    if (rec) out.push({ wsId, rec });
  }
  return out;
}
