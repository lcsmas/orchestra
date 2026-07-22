import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSelfWorkspaceId } from './index.ts';

// Regression: a structured-view (SDK) session whose ORCHESTRA_WS_ID was withheld
// by the spool-ownership gate (a terminal PTY already owned the spool) still
// needs a resolvable identity, or `orchestra rename "$ORCHESTRA_WS_ID" ...`
// collapses to one arg and prints `usage:`. buildSdkEnv sets
// ORCHESTRA_WS_ID_IDENTITY unconditionally for exactly this fallback.

test('prefers ORCHESTRA_WS_ID when set (terminal PTY / non-gated SDK session)', () => {
  assert.equal(
    resolveSelfWorkspaceId({ ORCHESTRA_WS_ID: 'ws-primary', ORCHESTRA_WS_ID_IDENTITY: 'ws-fallback' }),
    'ws-primary',
  );
});

test('falls back to ORCHESTRA_WS_ID_IDENTITY when WS_ID is withheld by the spool gate', () => {
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
