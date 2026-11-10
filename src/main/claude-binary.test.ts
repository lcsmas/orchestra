import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeBinaryVersion, resolveClaudeBinary } from './claude-binary.ts';

/** A machine with a `claude` link in bin/ pointing at versions/<v>, like the native install. */
function install(t: { after(fn: () => void): void }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-binary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'), versions = path.join(root, 'versions');
  fs.mkdirSync(bin);
  fs.mkdirSync(versions);
  const link = path.join(bin, 'claude');
  const point = (v: string) => {
    fs.writeFileSync(path.join(versions, v), `#!/bin/sh\necho "${v} (Claude Code)"\n`, { mode: 0o755 });
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.join(versions, v), link);
  };
  return { root, bin, link, point };
}

test('the `claude` a new session would start: the first EXECUTABLE one on PATH, or none', (t) => {
  const m = install(t);
  const empty = path.join(m.root, 'empty'), notExec = path.join(m.root, 'notexec');
  fs.mkdirSync(empty);
  fs.mkdirSync(notExec);
  fs.writeFileSync(path.join(notExec, 'claude'), 'not a program', { mode: 0o644 });
  m.point('2.1.310');
  assert.equal(resolveClaudeBinary({ PATH: [empty, notExec, m.bin].join(path.delimiter) }), m.link);
  assert.equal(resolveClaudeBinary({ PATH: [empty, notExec].join(path.delimiter) }), null);
  assert.equal(resolveClaudeBinary({}), null);
});

test('its version follows the link: an update that re-points `claude` is seen at the next read, without a restart', async (t) => {
  const m = install(t);
  m.point('2.1.310');
  assert.equal(await claudeBinaryVersion(m.link), '2.1.310');
  m.point('2.1.322');
  assert.equal(await claudeBinaryVersion(m.link), '2.1.322');
  fs.rmSync(m.link);
  assert.equal(await claudeBinaryVersion(m.link), null, 'a missing binary is unknown, not an error');
});

test('a wrapper script (an asdf / volta shim) never changes on disk: only a FRESH read sees what it now runs', async (t) => {
  const m = install(t);
  const state = path.join(m.root, 'current');
  fs.writeFileSync(state, '2.1.310');
  fs.writeFileSync(m.link, `#!/bin/sh\necho "$(cat ${state}) (Claude Code)"\n`, { mode: 0o755 });
  assert.equal(await claudeBinaryVersion(m.link), '2.1.310');
  fs.writeFileSync(state, '2.1.322');
  assert.equal(await claudeBinaryVersion(m.link), '2.1.310', 'the memo: same file, same mtime');
  assert.equal(await claudeBinaryVersion(m.link, { fresh: true }), '2.1.322');
  assert.equal(await claudeBinaryVersion(m.link), '2.1.322', 'and the fresh answer is the new memo');
});
