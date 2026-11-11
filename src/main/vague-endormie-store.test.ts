// #428 — the file the asleep-vague state survives a restart in: round trip, first run, torn / foreign content, atomic write (no tmp left).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createVagueFileStore } from './vague-endormie-store.ts';

const dir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'vague-store-'));

test('round trip: what was saved is what loads; no temp file is left behind', () => {
  const d = dir();
  const st = createVagueFileStore(() => path.join(d, 'sub', 'vague-endormie.json'));
  const data = { ops: { everSeen: true, episode: { since: 1, declaredAt: 2, nudgedAt: 3 } }, other: { everSeen: true } };
  st.save(data);
  assert.deepEqual(st.load(), data);
  assert.deepEqual(fs.readdirSync(path.join(d, 'sub')), ['vague-endormie.json']);
  fs.rmSync(d, { recursive: true, force: true });
});

test('first run (no file) loads as nothing; a torn or foreign file THROWS (the sweep then starts from nothing and says so)', () => {
  const d = dir();
  const f = path.join(d, 'v.json');
  const st = createVagueFileStore(() => f);
  assert.deepEqual(st.load(), {});
  fs.writeFileSync(f, '{"ops": {"everSe');
  assert.throws(() => st.load());
  fs.writeFileSync(f, '[1,2]');
  assert.throws(() => st.load(), /not an object/);
  fs.rmSync(d, { recursive: true, force: true });
});
