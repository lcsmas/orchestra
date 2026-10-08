// #320 (pre-review MAJOR 2) — which Plafond-mémoire kills this APP has already delivered, per scope unit, PERSISTED so an app restart does not replay the keeper's last 20 records
// (helloAck.memKills) as new: #322 sends a bus message per delivery. Electron-free. A unit name carries its launch generation, so cursors never collide between keepers.
// Delivery is AT-LEAST-ONCE: the cursor is written after the handlers ran, so only a crash between the two replays one record — never a silent loss.

import fs from 'node:fs';
import path from 'node:path';

export interface MemKillCursor {
  /** Highest `seq` already delivered for this scope unit (0 = none). */
  seen(unit: string): number;
  /** Record that everything up to `seq` is delivered; persisted before returning (a failed write is reported to `warn`, the in-memory cursor still holds). */
  mark(unit: string, seq: number): void;
}

const MAX_UNITS = 200;

export function createMemKillCursor(file: string, warn: (msg: string) => void = () => {}): MemKillCursor {
  const map = new Map<string, number>();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [unit, seq] of Object.entries(raw)) if (typeof seq === 'number' && Number.isFinite(seq) && seq > 0) map.set(unit, seq);
  } catch {
    /* absent / corrupt = nothing delivered yet: the worst case is one replay, never a loss */
  }
  return {
    seen: (unit) => map.get(unit) ?? 0,
    mark(unit, seq) {
      if (seq <= (map.get(unit) ?? 0)) return;
      map.delete(unit); // re-insert last = newest
      map.set(unit, seq);
      while (map.size > MAX_UNITS) map.delete(map.keys().next().value as string); // oldest unit out
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(map)));
        fs.renameSync(tmp, file); // atomic: a reader never sees a torn file
      } catch (e) {
        warn(`memory-cap: could not persist the kill cursor (${(e as Error).message}) — an app restart may replay kills already delivered`);
      }
    },
  };
}
