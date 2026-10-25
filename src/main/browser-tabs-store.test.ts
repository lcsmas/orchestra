// #393 — the on-disk store behind "tabs come back after a restart": coalesced atomic writes, tolerant reads, forget-on-delete.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBrowserTabsStore } from './browser-tabs-store.ts';

const TMP: string[] = [];
function mkFile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bts-'));
  TMP.push(d);
  return path.join(d, 'orchestra', 'browser-tabs.json');
}
after(() => {
  for (const d of TMP) fs.rmSync(d, { recursive: true, force: true });
});

const T3 = { tabs: [{ url: 'https://a/', openedBy: 'human' as const }, { url: 'https://b/', openedBy: 'human' as const }, { url: '', openedBy: 'agent' as const }], activeIndex: 1 };

test('save + flush writes the file (creating the directory); a NEW store instance reads the same 3 tabs and active index back', () => {
  const file = mkFile();
  const a = createBrowserTabsStore({ file });
  a.save('w1', T3);
  assert.equal(fs.existsSync(file), false, 'coalesced: nothing on disk before the debounce / flush');
  a.flush();
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(createBrowserTabsStore({ file }).load('w1'), T3);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['browser-tabs.json'], 'no tmp file left behind');
});

test('save(null) forgets a workspace (delete / archive) and the forgetting reaches disk; other workspaces survive', () => {
  const file = mkFile();
  const a = createBrowserTabsStore({ file });
  a.save('w1', T3);
  a.save('w2', T3);
  a.flush();
  a.save('w1', null);
  a.flush();
  const b = createBrowserTabsStore({ file });
  assert.equal(b.load('w1'), null);
  assert.deepEqual(b.load('w2'), T3);
});

test('an unchanged save does not dirty the store (no write on a no-op navigation event)', () => {
  const file = mkFile();
  const a = createBrowserTabsStore({ file });
  a.save('w1', T3);
  a.flush();
  const mtime = fs.statSync(file).mtimeMs;
  fs.utimesSync(file, new Date(0), new Date(0));
  a.save('w1', JSON.parse(JSON.stringify(T3)));
  a.flush();
  assert.equal(fs.statSync(file).mtimeMs, 0, `file rewritten although nothing changed (was ${mtime})`);
});

test('a corrupt file is a fresh start with a warning at most — never a throw — and the next save repairs it', () => {
  const file = mkFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ not json');
  const a = createBrowserTabsStore({ file, warn: () => {} });
  assert.equal(a.load('w1'), null);
  a.save('w1', T3);
  a.flush();
  assert.deepEqual(createBrowserTabsStore({ file }).load('w1'), T3);
});

test('a failed write keeps the change pending: the next flush retries instead of losing it', () => {
  const file = mkFile();
  const dir = path.dirname(file);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, 'i am a file, not a directory'); // makes mkdirSync(dir) fail
  const warns: string[] = [];
  const a = createBrowserTabsStore({ file, warn: (m) => warns.push(m) });
  a.save('w1', T3);
  a.flush();
  assert.equal(warns.length, 1);
  fs.rmSync(dir);
  a.flush();
  assert.deepEqual(createBrowserTabsStore({ file }).load('w1'), T3);
});

test('an UNREADABLE (not missing, not corrupt) file is never overwritten: no write until a re-read works, then this session merges over what was on disk', () => {
  const file = mkFile();
  fs.mkdirSync(file, { recursive: true }); // the "file" is a directory -> readFileSync throws EISDIR (an I/O failure, not ENOENT)
  const warns: string[] = [];
  const a = createBrowserTabsStore({ file, warn: (m) => warns.push(m) });
  a.save('mine', T3);
  a.flush();
  assert.ok(fs.statSync(file).isDirectory(), 'the unreadable path was replaced');
  assert.ok(warns.some((w) => /cannot read/.test(w)), `no read warning: ${warns.join(' | ')}`);
  // the path becomes readable, holding another workspace's tabs and a workspace this session forgot
  fs.rmSync(file, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, workspaces: { other: T3, gone: T3 } }));
  a.save('gone', null);
  a.flush();
  const back = createBrowserTabsStore({ file });
  assert.deepEqual(back.load('other'), T3, "another workspace's saved tabs were lost");
  assert.deepEqual(back.load('mine'), T3);
  assert.equal(back.load('gone'), null, 'a forgotten workspace was resurrected by the merge');
});
