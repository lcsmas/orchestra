import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_NOTICE_LINES, appendMemNotice, parseMemNotice, readMemNotices } from './mem-notice-file.ts';
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
