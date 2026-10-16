import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelfWorkspaceId } from './index.ts';

// Regression: a keeper born before #233 kept a frozen env whose ORCHESTRA_WS_ID was withheld
// (an agent PTY owned the spool) — its `orchestra rename "$ORCHESTRA_WS_ID" ...` would collapse
// to one arg and print `usage:`. buildSdkEnv still sets ORCHESTRA_WS_ID_IDENTITY for that fallback (#378).

test('prefers ORCHESTRA_WS_ID when set (every session born since #233)', () => {
  assert.equal(
    resolveSelfWorkspaceId({ ORCHESTRA_WS_ID: 'ws-primary', ORCHESTRA_WS_ID_IDENTITY: 'ws-fallback' }),
    'ws-primary',
  );
});

test('falls back to ORCHESTRA_WS_ID_IDENTITY when WS_ID is absent (a keeper born before #233)', () => {
  assert.equal(
    resolveSelfWorkspaceId({ ORCHESTRA_WS_ID: undefined, ORCHESTRA_WS_ID_IDENTITY: 'ws-fallback' }),
    'ws-fallback',
  );
});

test('empty (not just unset) WS_ID falls through to the identity var', () => {
  // The screenshot symptom: $ORCHESTRA_WS_ID expanded to '' — treat it as absent.
  assert.equal(
    resolveSelfWorkspaceId({ ORCHESTRA_WS_ID: '', ORCHESTRA_WS_ID_IDENTITY: 'ws-fallback' }),
    'ws-fallback',
  );
});

test('trims surrounding whitespace', () => {
  assert.equal(
    resolveSelfWorkspaceId({ ORCHESTRA_WS_ID: '  ws-primary  ' }),
    'ws-primary',
  );
});

test('returns undefined outside any Orchestra workspace (plain human shell)', () => {
  assert.equal(resolveSelfWorkspaceId({}), undefined);
  assert.equal(
    resolveSelfWorkspaceId({ ORCHESTRA_WS_ID: '   ', ORCHESTRA_WS_ID_IDENTITY: '' }),
    undefined,
  );
});
