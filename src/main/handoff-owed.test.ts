// #466 follow-up (m1) — the owed-opening marker: durable, atomic, listed, cleared. Each arm can fail (a marker that is not read back, a clear that leaves it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clearOwed, listOwed, readOwed, writeOwed } from './handoff-owed.ts';

const root = (): string => fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'owed-'));
const REC = { opening: '[Orchestra handoff] …summary…', file: '/h/handoff/w1/x.md', at: 1_700_000_000_000 };

test('a written marker reads back identically and is listed; no .tmp file is left', () => {
  const r = root();
  writeOwed(r, 'w1', REC);
  assert.deepEqual(readOwed(r, 'w1'), REC);
  assert.deepEqual(listOwed(r), [{ wsId: 'w1', rec: REC }]);
  assert.deepEqual(fs.readdirSync(path.join(r, 'w1')), ['owed.json']);
  assert.equal(fs.statSync(path.join(r, 'w1', 'owed.json')).mode & 0o777, 0o600);
});

test('must-FAIL: clearing removes it (read null, not listed); clearing twice / an unknown ws is harmless', () => {
  const r = root();
  writeOwed(r, 'w1', REC);
  clearOwed(r, 'w1');
  assert.equal(readOwed(r, 'w1'), null);
  assert.deepEqual(listOwed(r), []);
  clearOwed(r, 'w1');
  clearOwed(r, 'never');
});

test('a corrupt / half-shaped marker reads as ABSENT (never throws, never delivers garbage); other workspaces are unaffected', () => {
  const r = root();
  writeOwed(r, 'good', REC);
  for (const [ws, body] of [['bad1', '{not json'], ['bad2', JSON.stringify({ opening: '', file: 'f', at: 1 })], ['bad3', JSON.stringify({ opening: 'x' })]] as const) {
    fs.mkdirSync(path.join(r, ws), { recursive: true });
    fs.writeFileSync(path.join(r, ws, 'owed.json'), body);
    assert.equal(readOwed(r, ws), null, ws);
  }
  assert.deepEqual(listOwed(r).map((x) => x.wsId), ['good']);
  assert.deepEqual(listOwed(path.join(r, 'missing-dir')), []);
});

test('a second write replaces the first (the newest handoff is the one owed)', () => {
  const r = root();
  writeOwed(r, 'w1', REC);
  writeOwed(r, 'w1', { ...REC, opening: 'newer', at: REC.at + 1 });
  assert.equal(readOwed(r, 'w1')?.opening, 'newer');
});
