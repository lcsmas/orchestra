import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_NOTICE_LINES, MAX_SOFT_NOTICE_LINES, appendMemNotice, createNoticeBudget, fullyDelivered, mayPrune, parseMemNotice, pruneVerdict, readMemNotices, readMemNoticesChecked } from './mem-notice-file.ts';
import type { MemKillRecord, MemSoftRecord } from './memory-scope.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memnotice-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const kill: MemKillRecord = { kind: 'kill', source: 'kernel', seq: 1, at: 10, level: 'hard', command: 'cargo build', pid: 5, rssBytes: 99, candidates: ['x'], unit: 'u.scope', hardBytes: 1 << 30 };
const soft: MemSoftRecord = { kind: 'soft', seq: 2, at: 20, unit: 'u.scope', bytes: 5, softBytes: 4, hardBytes: null };

test('#322 m1: records appended by the keeper are read back by the host, in order, field for field', () => {
  const f = path.join(dir, 'a.jsonl');
  assert.deepEqual(readMemNotices(f), [], 'absent file ⇒ []');
  assert.equal(appendMemNotice(f, kill), true);
  assert.equal(appendMemNotice(f, soft), true);
  assert.deepEqual(readMemNotices(f), [kill, soft]);
  assert.equal(fs.statSync(f).mode & 0o077, 0, 'owner-only');
});

test('#322 m1: a torn last line (crash mid-write), garbage and foreign shapes are skipped — the good records survive', () => {
  const f = path.join(dir, 'b.jsonl');
  appendMemNotice(f, kill);
  fs.appendFileSync(f, 'not json\n{"unit":"u","seq":"x"}\n{"kind":"soft","unit":"u.scope","seq":3,"at":1}\n{"kind":"kill","unit":"u.scope","seq":4,"at":1,"level":"weird"}\n{"unit":"u.scope","seq":5,"at":1,"level":"hard","comma');
  assert.deepEqual(readMemNotices(f).map((r) => r.seq), [1]);
});

test('#322 m1: an unwritable path returns false and never throws (the live frame still goes out)', () => {
  assert.equal(appendMemNotice(path.join(dir, 'no', 'such', 'dir', 'x.jsonl'), kill), false);
});

test('#322 m1: parseMemNotice normalises a kill written before #322 (no kind/source) and clips the candidate list', () => {
  const old = parseMemNotice({ seq: 3, at: 1, level: 'external', command: null, pid: null, rssBytes: null, candidates: ['a', 'b', 'c', 'd', 'e', 'f', 7], unit: 'u.scope', hardBytes: null });
  assert.equal(old?.kind, 'kill');
  assert.equal((old as MemKillRecord).source, undefined, 'unknown provenance stays unknown');
  assert.deepEqual((old as MemKillRecord).candidates, ['a', 'b', 'c', 'd', 'e']);
  assert.equal(parseMemNotice(null), null);
  assert.equal(parseMemNotice({ ...kill, unit: '' }), null);
});

test('a keeper stops at MAX_NOTICE_LINES (exported so the keeper and the tests agree)', () => {
  assert.ok(MAX_NOTICE_LINES >= 100 && MAX_NOTICE_LINES <= 5000);
});

test('#322 m1: a file may be pruned only when EVERY record in it is at or below the per-unit cursor — an undelivered record is the only copy a gone keeper leaves', () => {
  const seen = (m: Record<string, number>) => (u: string) => m[u] ?? 0;
  assert.equal(fullyDelivered([], seen({})), true);
  assert.equal(fullyDelivered([kill, soft], seen({ 'u.scope': 2 })), true);
  assert.equal(fullyDelivered([kill, soft], seen({ 'u.scope': 1 })), false, 'seq 2 not yet delivered');
  assert.equal(fullyDelivered([kill, { ...soft, unit: 'other.scope' }], seen({ 'u.scope': 9 })), false, 'a record of ANOTHER unit is judged by its own cursor');
});

test('review F3: an UNREADABLE notice file is unknown, never «delivered» — readMemNoticesChecked says so and mayPrune refuses (the only copy of a gone keeper\'s kills)', () => {
  const seenAll = () => 1_000_000;
  const asDir = path.join(dir, 'actually-a-directory.jsonl');
  fs.mkdirSync(asDir);
  const bad = readMemNoticesChecked(asDir);
  assert.equal(bad.ok, false, 'EISDIR (like EACCES / EMFILE / EIO) is a read ERROR');
  assert.equal(mayPrune(bad, seenAll), false);
  assert.deepEqual(readMemNotices(asDir), [], 'the lenient reader still returns [] (use the checked one when it matters)');
  const absent = readMemNoticesChecked(path.join(dir, 'never-existed.jsonl'));
  assert.deepEqual(absent, { ok: true, recs: [], unparsed: 0 }, 'ENOENT is a clean «nothing»');
  assert.equal(mayPrune(absent, seenAll), true);
});

test('review F3: a file holding lines we could not parse is not pruned either (version skew / corruption must not eat records)', () => {
  const f = path.join(dir, 'skew.jsonl');
  appendMemNotice(f, kill);
  fs.appendFileSync(f, '{"kind":"kill","unit":"u.scope","seq":9,"at":1,"level":"hard","extra":"from a newer keeper"\n');
  const r = readMemNoticesChecked(f);
  assert.equal(r.ok && r.unparsed, 1);
  assert.equal(mayPrune(r, () => 1_000_000), false, 'fully delivered but one line is not understood ⇒ keep');
  const clean = path.join(dir, 'clean.jsonl');
  appendMemNotice(clean, kill);
  assert.equal(mayPrune(readMemNoticesChecked(clean), () => 1), true, 'control: understood + delivered ⇒ prunable');
  assert.equal(mayPrune(readMemNoticesChecked(clean), () => 0), false, 'control: undelivered ⇒ kept');
});

test('review F3: a SHORT write is looped to completion, and a torn tail is never glued to the next record', () => {
  const f = path.join(dir, 'short.jsonl');
  assert.equal(appendMemNotice(f, kill, (fd, buf, off) => fs.writeSync(fd, buf, off, Math.min(7, buf.length - off))), true);
  assert.deepEqual(readMemNotices(f), [kill], 'seven bytes at a time still lands the whole record');
  assert.equal(appendMemNotice(path.join(dir, 'zero.jsonl'), kill, () => 0), false, 'a write that makes no progress is a failure, not a hang');
  const torn = path.join(dir, 'torn.jsonl');
  fs.writeFileSync(torn, '{"kind":"kill","unit":"u.sco'); // a crash mid-write left a tail with no newline
  assert.equal(appendMemNotice(torn, soft), true);
  assert.deepEqual(readMemNotices(torn), [soft], 'the new record is on its OWN line: readable, not glued to the torn tail');
});

test('review F5: warnings have their own, smaller file budget — they can never use up the lines a later kill needs', () => {
  assert.ok(MAX_SOFT_NOTICE_LINES > 0 && MAX_SOFT_NOTICE_LINES < MAX_NOTICE_LINES);
});

test("round 2 M1: a kill's `role` (the agent process / keeper was the victim) and a warning's `suppressed` count survive the trip through the file - the coordinator must read «session ended», not «survived»", () => {
  const f = path.join(dir, 'role.jsonl');
  const killCli: MemKillRecord = { ...kill, seq: 7, role: 'cli' };
  const softSup: MemSoftRecord = { ...soft, seq: 8, suppressed: 3 };
  appendMemNotice(f, killCli);
  appendMemNotice(f, softSup);
  assert.deepEqual(readMemNotices(f), [killCli, softSup], 'field for field, role and suppressed included');
  assert.equal(parseMemNotice({ ...kill, role: 'martian' } as never) && (parseMemNotice({ ...kill, role: 'martian' } as never) as MemKillRecord).role, undefined, 'an unknown role is dropped, not trusted');
});

test('round 2 m2: a file whose understood records are all delivered but holds a crash-torn line is QUARANTINED (evidence kept, name freed) - never blocked for ever, never silently deleted', () => {
  const f = path.join(dir, 'torn2.jsonl');
  appendMemNotice(f, kill);
  fs.appendFileSync(f, '{"kind":"kill","unit":"u.sc\n');
  const r = readMemNoticesChecked(f);
  assert.equal(pruneVerdict(r, () => 1_000_000), 'quarantine');
  assert.equal(pruneVerdict(r, () => 0), 'keep', 'an undelivered record keeps the file');
  assert.equal(pruneVerdict({ ok: false, error: 'EACCES' }, () => 1_000_000), 'keep');
  assert.equal(pruneVerdict(readMemNoticesChecked(path.join(dir, 'clean.jsonl')), () => 1), 'prune');
  assert.equal(mayPrune(r, () => 1_000_000), false, 'mayPrune stays the strict «prune» verdict');
});

test('round 2 m4: the keeper\'s notice budget counts kills and warnings APART - a thousand warnings never use up a kill\'s line; a failed append gives its reservation back', () => {
  const b = createNoticeBudget(5, 3);
  const softs = Array.from({ length: 1000 }, () => b.take('soft'));
  assert.equal(softs.filter((s) => s.write).length, 3, 'warnings stop at THEIR budget');
  assert.equal(softs.filter((s) => s.justFull).length, 1, 'and say so once');
  for (let i = 0; i < 5; i++) assert.equal(b.take('kill').write, true, `kill ${i + 1} still has its line after 1000 warnings`);
  assert.equal(b.take('kill').write, false, 'kills stop at THEIR budget');
  const c = createNoticeBudget(1, 1);
  assert.equal(c.take('kill').write, true);
  c.release('kill');
  assert.equal(c.take('kill').write, true, 'a released reservation is reusable');
});
