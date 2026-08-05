import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// REGRESSION (shipped in v0.5.209, found by running the real verb): every
// socket-level refusal exited 0 on the PACKAGED build and printed a
// contradictory success line under its own error:
//
//     $ orchestra set-repo <id> /not/a/repo
//     unknown repoPath: /not/a/repo
//     Cleared repo grouping for undefined     <-- unreachable in intent
//     RC=0                                    <-- a refusal reported as success
//
// Cause: the packaged binary doubles as the CLI (`Orchestra.AppImage cli …`),
// so `fail()` runs inside an HTTP response callback in the Electron main
// process — and `process.exit()` there does NOT terminate synchronously.
// Execution continued past it into the success branch, then hit `runCli`'s
// `process.exit(0)`. It affected `promote`/`attach`/`set-base`/`set-repo`
// alike, i.e. every verb whose guard is `if (!res.ok) fail(...)`.
//
// Why the original testing missed it: the socket returns `{ok:false,error}`
// correctly (asserted, passed) and the CLI does print the error (asserted,
// passed). Only the EXIT CODE on the refusal path discriminates — so that is
// what this file asserts, rather than stderr text.
//
// These run the CLI as a real child process because an exit code is the thing
// under test; importing and calling `fail()` in-process would kill the runner.
//
// ⚠️ WHAT THIS FILE DOES *NOT* GATE — read before trusting it. These run under
// PLAIN NODE, where `process.exit()` terminates synchronously, so the pre-fix
// code PASSES every assertion here (verified by mutation: reverting `fail()` to
// the bare `process.exit(1)` and rebuilding still gave 12/12 green). The defect
// only manifests inside the ELECTRON main process. So this file pins the
// CONTRACT (a refusal exits non-zero, prints no success line, interpolates no
// `undefined`) and would catch a regression that breaks it under node — but the
// only thing that catches THIS bug returning is driving the packaged binary:
//
//     $ Orchestra.AppImage cli set-repo <id> /not/a/repo ; echo "RC=$?"
//
// which is a build-artifact check, not a unit test. Do not read a green run
// here as proof the Electron path is sound.

// Drive the BUILT CJS bundle, not src/index.ts. The auto-run block at the
// bottom of index.ts is guarded on `typeof require !== 'undefined'` so the
// module stays importable under the strip-types runner — which means running
// the SOURCE as raw ESM leaves `main()` uncalled and every command exits 0
// without doing anything. (That bit me writing this file: 7 assertions failed
// against a CLI that was never invoked, including one I had already proven
// works by hand.) dist-electron/cli.js is also the artifact that actually
// ships, so this tests the real thing.
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');
const BUILT = existsSync(CLI);

/** Run the CLI in a child and return its exit code + streams. `ORCHESTRA_SOCK`
 *  points at a path that cannot exist, so any command reaching the socket fails
 *  at connect — deterministic, and it touches no real Orchestra state. */
function runCli(args: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ORCHESTRA_SOCK: '/nonexistent/orchestra-test.sock' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? -1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

/** Guard so a clean checkout (no build yet) SKIPS rather than fails — but say
 *  so loudly, since a silently-skipped regression test is worse than none. */
const needsBuild = { skip: BUILT ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

test('a usage error exits 1 (fail() reached BEFORE any socket call)', needsBuild, () => {
  const r = runCli(['set-repo']);
  assert.equal(r.code, 1, 'missing id must exit 1');
  assert.match(r.stderr, /usage: orchestra set-repo/);
});

test('an unknown command exits 1', needsBuild, () => {
  const r = runCli(['zzz-not-a-command']);
  assert.equal(r.code, 1);
});

// THE REGRESSION ITSELF. A command that reaches the socket and cannot complete
// must exit NON-ZERO. Before the fix this exited 0 on the packaged build.
test('set-repo: a refusal reached THROUGH the socket path exits non-zero', needsBuild, () => {
  const r = runCli(['set-repo', 'some-id', '/not/a/registered/repo']);
  assert.notEqual(r.code, 0, 'a refusal must never exit 0 — scripts gate on $?');
  assert.equal(r.code, 1);
});

// The contradictory success line: on the broken build the error was followed by
// "Cleared repo grouping for undefined". stdout must carry NO success sentence
// when the command failed.
test('set-repo: a failed call prints no success line and no "undefined"', needsBuild, () => {
  const r = runCli(['set-repo', 'some-id', '/not/a/registered/repo']);
  assert.doesNotMatch(r.stdout, /Grouped|Cleared repo grouping/,
    'a failed call must not print a success sentence');
  assert.doesNotMatch(r.stdout + r.stderr, /undefined/,
    'no field may be interpolated as "undefined"');
});

// Same guard shape across the sibling verbs — this was never specific to
// set-repo, so pinning only that one would let the class survive being fixed.
for (const args of [
  ['promote', 'some-id'],
  ['attach', 'some-id', 'some-parent'],
  ['set-base', 'some-id', 'some-branch'],
  ['detach', 'some-id'],
]) {
  test(`${args[0]}: a refusal through the socket path exits non-zero`, needsBuild, () => {
    const r = runCli(args);
    assert.notEqual(r.code, 0, `${args[0]} must not exit 0 on failure`);
  });

  test(`${args[0]}: a failed call prints no "undefined"`, needsBuild, () => {
    const r = runCli(args);
    assert.doesNotMatch(r.stdout, /undefined/,
      `${args[0]} must not interpolate undefined into a success line`);
  });
}
