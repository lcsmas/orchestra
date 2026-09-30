import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldMuteAudio } from './audio-mute.ts';

test('packaged default (no ORCHESTRA_HOME) keeps audio', () => {
  assert.equal(shouldMuteAudio({}), false);
});

test('isolated instance (ORCHESTRA_HOME set) is muted', () => {
  assert.equal(shouldMuteAudio({ ORCHESTRA_HOME: '/tmp/rig/oh' }), true);
});

test('ORCHESTRA_AUDIO=1 opts an isolated instance back in', () => {
  assert.equal(shouldMuteAudio({ ORCHESTRA_HOME: '/tmp/rig/oh', ORCHESTRA_AUDIO: '1' }), false);
  assert.equal(shouldMuteAudio({ ORCHESTRA_HOME: '/tmp/rig/oh', ORCHESTRA_AUDIO: '0' }), true);
});

test('empty ORCHESTRA_HOME is the default home', () => {
  assert.equal(shouldMuteAudio({ ORCHESTRA_HOME: '' }), false);
});
