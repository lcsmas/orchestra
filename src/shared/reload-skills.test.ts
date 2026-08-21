import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseReloadSkillsArgs,
  isPluginReloadFailure,
  summarizeReload,
  reloadExitCode,
  type ReloadResult,
} from './reload-skills.ts';

// ---------- flag parsing ----------

test('bare verb targets the calling workspace (no id, no --all)', () => {
  const a = parseReloadSkillsArgs([]);
  assert.equal(a.error, undefined);
  assert.equal(a.id, undefined);
  assert.equal(a.all, false);
  assert.equal(a.plugins, false);
});

test('an explicit id is captured', () => {
  const a = parseReloadSkillsArgs(['ws-123']);
  assert.equal(a.error, undefined);
  assert.equal(a.id, 'ws-123');
  assert.equal(a.all, false);
});

test('--all selects the fan-out', () => {
  const a = parseReloadSkillsArgs(['--all']);
  assert.equal(a.error, undefined);
  assert.equal(a.all, true);
  assert.equal(a.id, undefined);
});

test('--plugins composes with both selectors', () => {
  assert.equal(parseReloadSkillsArgs(['--plugins']).plugins, true);
  assert.equal(parseReloadSkillsArgs(['--all', '--plugins']).plugins, true);
  assert.equal(parseReloadSkillsArgs(['ws-1', '--plugins']).plugins, true);
});

test('flag order does not matter', () => {
  const a = parseReloadSkillsArgs(['--plugins', '--all']);
  assert.equal(a.error, undefined);
  assert.equal(a.all, true);
  assert.equal(a.plugins, true);
});

test('id + --all is rejected rather than silently picking one', () => {
  const a = parseReloadSkillsArgs(['ws-1', '--all']);
  assert.match(a.error ?? '', /not both/);
});

test('an unknown flag is an error, never an ignored token', () => {
  // The whole point: a typo'd `--plugin` must NOT parse as "skip plugins" and
  // then report a clean success for a reload that never touched plugins.
  const a = parseReloadSkillsArgs(['--plugin']);
  assert.match(a.error ?? '', /unknown flag: --plugin/);
  assert.equal(a.plugins, false);
});

test('a second positional argument is an error', () => {
  const a = parseReloadSkillsArgs(['ws-1', 'ws-2']);
  assert.match(a.error ?? '', /unexpected argument: ws-2/);
});

// ---------- empty-plugins-is-not-a-failure ----------

test('an EMPTY plugins array is not a failure (the ~2s settings cache)', () => {
  assert.equal(isPluginReloadFailure({ plugins: [] }), false);
});

test('a populated plugins array is likewise not a failure', () => {
  assert.equal(isPluginReloadFailure({ plugins: [{ name: 'x' }] }), false);
});

test('an absent plugins key is not a failure either', () => {
  assert.equal(isPluginReloadFailure({}), false);
});

// ---------- fan-out summary + exit code ----------

const r = (id: string, outcome: ReloadResult['outcome']): ReloadResult => ({
  id,
  label: id,
  outcome,
});

test('summary counts reloaded sessions', () => {
  assert.equal(summarizeReload([r('a', 'reloaded'), r('b', 'reloaded')]), '2 reloaded');
});

test('summary distinguishes "reloaded nothing" from "reloaded everything"', () => {
  // The failure this guards: a summary mentioning only successes prints the
  // same reassuring thing whether 22 sessions picked the skill up or none did.
  const none = summarizeReload([r('a', 'skipped'), r('b', 'skipped')]);
  const all = summarizeReload([r('a', 'reloaded'), r('b', 'reloaded')]);
  assert.notEqual(none, all);
  assert.match(none, /0 reloaded/);
  assert.match(none, /2 without a live session/);
});

test('summary reports failures alongside successes', () => {
  const s = summarizeReload([r('a', 'reloaded'), r('b', 'skipped'), r('c', 'failed')]);
  assert.match(s, /1 reloaded/);
  assert.match(s, /1 without a live session/);
  assert.match(s, /1 failed/);
});

test('exit code is 0 when nothing failed, even if nothing was reloaded', () => {
  assert.equal(reloadExitCode([]), 0);
  assert.equal(reloadExitCode([r('a', 'skipped'), r('b', 'skipped')]), 0);
  assert.equal(reloadExitCode([r('a', 'reloaded')]), 0);
});

test('exit code is 1 when any workspace failed', () => {
  assert.equal(reloadExitCode([r('a', 'reloaded'), r('b', 'failed')]), 1);
});
