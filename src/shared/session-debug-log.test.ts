// Pure retention-policy tests for the per-session debug-log black box (#177).
// Every cap (age / count / bytes) has a must-DELETE arm and a must-KEEP arm so
// a mutant that no-ops any single rule reddens. `keepName` is proven to survive
// even when a cap would otherwise evict it.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SESSION_DEBUG_RETENTION,
  planSessionDebugLogSweep,
  sessionDebugLogName,
  type SessionDebugLogFile,
} from './session-debug-log.ts';

const MB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const NOW = 1_000 * HOUR; // arbitrary fixed clock

function f(name: string, ageHours: number, sizeMb: number): SessionDebugLogFile {
  return { name, mtimeMs: NOW - ageHours * HOUR, size: sizeMb * MB };
}

// ── name minting ────────────────────────────────────────────────────────────
test('sessionDebugLogName: filename-safe, wsId + timestamp, .log ext', () => {
  const n = sessionDebugLogName('ws-abc', Date.parse('2026-09-28T09:52:19.123Z'));
  assert.match(n, /^ws-abc__2026-09-28T09-52-19-123Z\.log$/);
  assert.doesNotMatch(n, /[:.](?!log$)/, 'no raw : or . that would break a filename');
});

test('sessionDebugLogName: path separators in wsId cannot escape the dir', () => {
  const n = sessionDebugLogName('../../etc/passwd', NOW);
  assert.doesNotMatch(n, /\//, 'slashes stripped');
  assert.match(n, /passwd/); // the id text survives, just neutered
});

test('sessionDebugLogName: two spawns of one ws get distinct files', () => {
  const a = sessionDebugLogName('ws1', NOW);
  const b = sessionDebugLogName('ws1', NOW + 1000);
  assert.notEqual(a, b, 'per-boot granularity — a resume gets its own file');
});

// ── AGE cap ───────────────────────────────────────────────────────────────
test('AGE: deletes files older than maxAgeMs, keeps younger', () => {
  const ret = { maxAgeMs: 10 * HOUR, maxTotalBytes: 10_000 * MB, maxFiles: 10_000 };
  const files = [f('old.log', 20, 1), f('young.log', 1, 1), f('edge-young.log', 9, 1)];
  const del = planSessionDebugLogSweep(files, ret, NOW);
  assert.deepEqual(del.sort(), ['old.log']);
});

test('AGE: control — nothing deleted when all within window', () => {
  const ret = { maxAgeMs: 100 * HOUR, maxTotalBytes: 10_000 * MB, maxFiles: 10_000 };
  const files = [f('a.log', 1, 1), f('b.log', 50, 1)];
  assert.deepEqual(planSessionDebugLogSweep(files, ret, NOW), []);
});

// ── COUNT cap ───────────────────────────────────────────────────────────────
test('COUNT: deletes the OLDEST beyond maxFiles', () => {
  const ret = { maxAgeMs: 10_000 * HOUR, maxTotalBytes: 10_000 * MB, maxFiles: 2 };
  const files = [f('newest.log', 1, 1), f('mid.log', 2, 1), f('oldest.log', 3, 1)];
  const del = planSessionDebugLogSweep(files, ret, NOW);
  assert.deepEqual(del, ['oldest.log'], 'exactly one over → the oldest goes');
});

test('COUNT: control — at the cap, nothing deleted', () => {
  const ret = { maxAgeMs: 10_000 * HOUR, maxTotalBytes: 10_000 * MB, maxFiles: 3 };
  const files = [f('a.log', 1, 1), f('b.log', 2, 1), f('c.log', 3, 1)];
  assert.deepEqual(planSessionDebugLogSweep(files, ret, NOW), []);
});

// ── BYTES cap ─────────────────────────────────────────────────────────────
test('BYTES: evicts oldest until under the byte budget', () => {
  const ret = { maxAgeMs: 10_000 * HOUR, maxTotalBytes: 10 * MB, maxFiles: 10_000 };
  // 6+5+4 = 15MB > 10MB budget; evict oldest (4MB@age3 then 5MB@age2) → 6MB left.
  const files = [f('new6.log', 1, 6), f('mid5.log', 2, 5), f('old4.log', 3, 4)];
  const del = planSessionDebugLogSweep(files, ret, NOW).sort();
  assert.deepEqual(del, ['mid5.log', 'old4.log']);
});

test('BYTES: control — under budget deletes nothing', () => {
  const ret = { maxAgeMs: 10_000 * HOUR, maxTotalBytes: 100 * MB, maxFiles: 10_000 };
  const files = [f('a.log', 1, 6), f('b.log', 2, 5)];
  assert.deepEqual(planSessionDebugLogSweep(files, ret, NOW), []);
});

// ── keepName ────────────────────────────────────────────────────────────────
test('keepName: the file being written is never deleted, even when a cap evicts it', () => {
  // maxFiles=1 → count-eviction targets the two OLDEST survivors. Make `fresh`
  // the oldest so the cap would evict it — keepName must win and the sweep must
  // still evict a genuine over-budget file (b, the next-oldest) to honor the cap.
  const ret = { maxAgeMs: 10_000 * HOUR, maxTotalBytes: 10_000 * MB, maxFiles: 1 };
  const files = [f('fresh.log', 5, 0), f('a.log', 1, 1), f('b.log', 2, 1)];
  const del = planSessionDebugLogSweep(files, ret, NOW, 'fresh.log');
  assert.ok(!del.includes('fresh.log'), 'the file about to be written survives');
  assert.ok(del.includes('b.log'), 'a genuine over-budget file is still evicted');
  // Sanity: without the keep guard, fresh WOULD have been evicted (proves the guard fired).
  const withoutKeep = planSessionDebugLogSweep(files, ret, NOW);
  assert.ok(withoutKeep.includes('fresh.log'), 'control: fresh is evicted when NOT protected');
});

test('keepName: with NON-ZERO bytes, its size stays in the budget and the OTHER file is evicted (review-t1-177 F1)', () => {
  // The latent bug: restoring keepName only at the END let the BYTES loop
  // "free" keepName's bytes to reach budget, then un-delete it — leaving the
  // dir OVER budget. Here keepName (fresh, 10MB, OLDEST) + other (5MB) = 15MB
  // over a 12MB budget. The correct sweep deletes `other` (keepName's 10MB is
  // fixed overhead and must remain counted), landing the dir at 10MB ≤ 12MB.
  const ret = { maxAgeMs: 10_000 * HOUR, maxTotalBytes: 12 * MB, maxFiles: 10_000 };
  const files = [f('fresh.log', 5, 10), f('other.log', 1, 5)];
  const del = planSessionDebugLogSweep(files, ret, NOW, 'fresh.log');
  assert.ok(!del.includes('fresh.log'), 'keepName never deleted');
  assert.deepEqual(del, ['other.log'], 'the other file is evicted so the on-disk total (keepName kept) is under budget');
  // Explicit disproof of the pre-fix behaviour: a sweep that returned [] here
  // (keepName "freed" then restored) would leave the dir at 15MB > 12MB. This
  // arm reddens on the pre-fix pure fn and greens with the up-front exclusion.
  assert.notDeepEqual(del, [], 'must delete SOMETHING — an empty result is the pre-fix bug (dir left over budget)');
});

test('keepName: also survives the AGE cap', () => {
  const ret = { maxAgeMs: 1 * HOUR, maxTotalBytes: 10_000 * MB, maxFiles: 10_000 };
  const files = [f('fresh.log', 100, 0), f('other.log', 100, 1)];
  const del = planSessionDebugLogSweep(files, ret, NOW, 'fresh.log');
  assert.deepEqual(del, ['other.log'], 'keepName excluded from age eviction; the rest still go');
});

// ── defaults sanity ──────────────────────────────────────────────────────────
test('DEFAULT retention is a bounded black box (not unlimited)', () => {
  const r = DEFAULT_SESSION_DEBUG_RETENTION;
  assert.ok(r.maxAgeMs > 0 && Number.isFinite(r.maxAgeMs));
  assert.ok(r.maxTotalBytes > 0 && Number.isFinite(r.maxTotalBytes));
  assert.ok(r.maxFiles > 0 && Number.isFinite(r.maxFiles));
});
