import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_DEFAULT_MODEL,
  INITIAL_DEFAULT_MODEL,
  isValidModelArg,
  modelForNewWorkspace,
  normalizeModelDefaults,
  resolveLaunchModel,
} from './model-defaults.ts';

const D = { workspace: 'claude-sonnet-5', spawned: 'claude-haiku-4-5' };

test('initial default is the full wire id, unchanged from the old hardcoded one', () => {
  // `opus-4-8` is rejected by the runtime with `unrecognized_model` (2026-09-10).
  assert.equal(INITIAL_DEFAULT_MODEL, 'claude-opus-4-8');
});

test('normalize: absent/invalid store values fall back to the initial default', () => {
  assert.deepEqual(normalizeModelDefaults(undefined), {
    workspace: 'claude-opus-4-8',
    spawned: 'claude-opus-4-8',
  });
  assert.deepEqual(normalizeModelDefaults({ workspace: 'bad model!', spawned: ' opus[1m] ' }), {
    workspace: 'claude-opus-4-8',
    spawned: 'opus[1m]',
  });
  assert.equal(normalizeModelDefaults({ spawned: ACCOUNT_DEFAULT_MODEL }).spawned, 'default');
});

test('a new workspace takes the default of ITS kind; an explicit pick wins', () => {
  assert.equal(modelForNewWorkspace(undefined, D, 'workspace'), 'claude-sonnet-5');
  assert.equal(modelForNewWorkspace(undefined, D, 'spawned'), 'claude-haiku-4-5');
  assert.equal(modelForNewWorkspace('  ', D, 'spawned'), 'claude-haiku-4-5');
  assert.equal(modelForNewWorkspace('claude-opus-5', D, 'spawned'), 'claude-opus-5');
});

test('account-default choice is frozen as an explicit marker, not left absent', () => {
  // Absent ws.model means "legacy: follow the workspace default"; a spawned
  // agent set to the account default must NOT inherit the workspace default.
  const ws = modelForNewWorkspace(undefined, { ...D, spawned: ACCOUNT_DEFAULT_MODEL }, 'spawned');
  assert.equal(ws, ACCOUNT_DEFAULT_MODEL);
  assert.equal(resolveLaunchModel(ws, D), undefined);
});

test('launch model: ws.model wins, legacy absent follows the workspace default live', () => {
  assert.equal(resolveLaunchModel('claude-opus-5', D), 'claude-opus-5');
  assert.equal(resolveLaunchModel(undefined, D), 'claude-sonnet-5');
  assert.equal(resolveLaunchModel('', D), 'claude-sonnet-5');
  assert.equal(
    resolveLaunchModel(undefined, { ...D, workspace: ACCOUNT_DEFAULT_MODEL }),
    undefined,
  );
});

test('charset guard accepts wire ids and [1m] aliases, rejects shell junk', () => {
  for (const ok of ['claude-opus-4-8', 'opus[1m]', 'haiku', 'claude-opus-5[1m]']) {
    assert.ok(isValidModelArg(ok), ok);
  }
  for (const bad of ['bad model!', '', 'x;rm -rf', 'a'.repeat(65)]) {
    assert.ok(!isValidModelArg(bad), bad);
  }
});
