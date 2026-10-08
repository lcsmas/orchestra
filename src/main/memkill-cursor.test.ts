import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemKillCursor } from './memkill-cursor.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkc-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a cursor survives an app restart: a second instance on the same file knows what the first delivered', () => {
  const f = path.join(dir, 'a.json');
  const a = createMemKillCursor(f);
  assert.equal(a.seen('u1'), 0);
  a.mark('u1', 3);
  a.mark('u2', 1);
  const b = createMemKillCursor(f); // "the app restarted"
  assert.equal(b.seen('u1'), 3);
  assert.equal(b.seen('u2'), 1);
  assert.equal(b.seen('u3'), 0);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp')), [], 'no torn/tmp file left behind');
});

test('a cursor never moves backwards; a corrupt or hand-edited file means "nothing delivered", never a throw or a loss', () => {
  const f = path.join(dir, 'b.json');
  const a = createMemKillCursor(f);
  a.mark('u', 5);
  a.mark('u', 2);
  assert.equal(a.seen('u'), 5);
  fs.writeFileSync(f, '{not json');
  assert.equal(createMemKillCursor(f).seen('u'), 0);
  fs.writeFileSync(f, JSON.stringify({ u: 'x', v: -1, w: 4 }));
  const c = createMemKillCursor(f);
  assert.deepEqual([c.seen('u'), c.seen('v'), c.seen('w')], [0, 0, 4]);
});

test('bounded: only the newest 200 units are kept; an unwritable path warns and keeps the in-memory cursor', () => {
  const f = path.join(dir, 'c.json');
  const c = createMemKillCursor(f);
  for (let i = 0; i < 230; i++) c.mark(`unit-${i}`, 1);
  const again = createMemKillCursor(f);
  assert.equal(again.seen('unit-0'), 0, 'the oldest fell out');
  assert.equal(again.seen('unit-229'), 1);
  const warns: string[] = [];
  const bad = createMemKillCursor(path.join(dir, 'a.json', 'nope', 'x.json'), (m) => warns.push(m)); // a.json is a FILE: its "children" cannot be created
  bad.mark('u', 1);
  assert.equal(bad.seen('u'), 1);
  assert.match(warns[0] ?? '', /could not persist the kill cursor/);
});
