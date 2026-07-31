import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The sweeper must only ever act on state it OWNS — live process/session
// handles (stopPty / the SDK stop seam) and store fields. It must never
// create, remove or mutate worktrees or scratch dirs on disk.
//
// Why this is a hard constraint and not a style preference: ORCHESTRA_HOME
// relocates userData, logs and the events spool, but NOT worktrees or scratch
// dirs — those stay under the real ~/.orchestra, where ~18 sibling agents live.
// So a sweeper with any fs write in its path is unsafe to even VERIFY on this
// machine: an isolated-home test instance would still be pointed at the real
// worktree tree, and a bug in the sweep would reap a live agent's work.
//
// This is a SOURCE-level guard rather than a runtime one deliberately — the
// dangerous call is the one nobody runs in a test, so asserting "the fs import
// isn't there" catches it where "the fs call didn't fire" cannot.

const here = path.dirname(fileURLToPath(import.meta.url));
const sweepSource = readFileSync(path.join(here, 'hibernation.ts'), 'utf8');
const activitySource = readFileSync(path.join(here, 'hibernation-activity.ts'), 'utf8');

test('the sweep module imports no filesystem/process-spawning module', () => {
  // Positive control FIRST: prove the file was actually read and this
  // assertion can see its contents, so a zero-match result below means
  // "absent", not "I read an empty/wrong file".
  assert.match(sweepSource, /stopPty/, 'control: sweep source should mention stopPty');
  assert.ok(sweepSource.length > 2000, 'control: sweep source should be substantial');

  for (const forbidden of [
    "from 'node:fs'",
    'from "node:fs"',
    "from 'node:fs/promises'",
    "from 'fs'",
    "from 'node:child_process'",
    "from 'child_process'",
  ]) {
    assert.equal(
      sweepSource.includes(forbidden),
      false,
      `hibernation.ts must not import ${forbidden} — the sweep may not touch disk`,
    );
  }
});

test('the sweep module calls no worktree/dir mutation helper', () => {
  assert.match(sweepSource, /sweepHibernation/, 'control: sweep function should be present');

  // Bare-word scan for the mutating fs surface. Matches a call like `rm(` or
  // `.mkdir(` but not the word inside prose (the comments discuss "removed").
  for (const call of [
    'rmSync',
    'mkdirSync',
    'writeFileSync',
    'unlinkSync',
    'rename(',
    'rmdir',
    'execFile',
    'spawnSync',
  ]) {
    assert.equal(
      sweepSource.includes(call),
      false,
      `hibernation.ts must not call ${call} — the sweep may not touch disk`,
    );
  }
});

test('the last-activity leaf stays dependency-free', () => {
  // It is imported by activity.ts, which pty.ts imports — any dependency here
  // risks re-closing the import cycle the module exists to break.
  assert.match(activitySource, /noteActivity/, 'control: leaf should export noteActivity');
  assert.equal(
    /^\s*import\s/m.test(activitySource),
    false,
    'hibernation-activity.ts must import nothing (it breaks the activity↔pty cycle)',
  );
});
