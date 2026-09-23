import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRuntimeStale, parseCliVersion, resolveIn, runtimeServesLikeCurrent } from './cli-runtime.ts';

test('parseCliVersion reads the real `claude --version` shape', () => {
  assert.equal(parseCliVersion('2.1.280 (Claude Code)\n'), '2.1.280');
  assert.equal(parseCliVersion(''), null);
  assert.equal(parseCliVersion('command not found'), null);
});

test('isRuntimeStale: only known-and-different is stale', () => {
  assert.equal(isRuntimeStale('2.1.278', '2.1.280'), true);
  assert.equal(isRuntimeStale('2.1.280', '2.1.280'), false);
  assert.equal(isRuntimeStale(undefined, '2.1.280'), false);
  assert.equal(isRuntimeStale('2.1.278', null), false);
});

// Real supportedModels() rows probed 2026-09-23 (value, resolvedModel).
const V278 = [
  { value: 'default', resolvedModel: 'claude-opus-5[1m]' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]' },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5' },
];
const V280 = [
  { value: 'default', resolvedModel: 'claude-opus-5-5[1m]' },
  { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5[1m]' },
  { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1' },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5' },
];

test('resolveIn maps alias and full id to the concrete base id', () => {
  assert.equal(resolveIn(V280, 'opus[1m]'), 'claude-opus-5-5');
  assert.equal(resolveIn(V278, 'opus[1m]'), 'claude-opus-5');
  assert.equal(resolveIn(V280, 'claude-opus-5-5'), 'claude-opus-5-5');
  assert.equal(resolveIn(V278, 'claude-opus-5-5[1m]'), null);
});

test('runtimeServesLikeCurrent: an old runtime must restart for Opus 5.5 by alias OR id', () => {
  assert.equal(runtimeServesLikeCurrent(V278, V280, 'opus[1m]'), false); // same value, older model
  assert.equal(runtimeServesLikeCurrent(V278, V280, 'default'), false);
  assert.equal(runtimeServesLikeCurrent(V278, V280, 'claude-opus-5-5[1m]'), false);
  assert.equal(runtimeServesLikeCurrent(V278, V280, 'sonnet'), true);
  assert.equal(runtimeServesLikeCurrent(V280, V280, 'opus[1m]'), true);
  // Unknown to the current runtime too (delisted Opus 4.8): restarting can't help.
  assert.equal(runtimeServesLikeCurrent(V278, V280, 'claude-opus-4-8'), true);
  assert.equal(runtimeServesLikeCurrent(V278, V280, ''), true);
});
