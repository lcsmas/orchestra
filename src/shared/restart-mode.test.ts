import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRestartMode, routeRestart, type RestartEffects } from './restart-mode.ts';

// ISSUE #111 gap #3 — the CLI restart must route the STRUCTURED surface to its
// own restart path, never silently through the PTY branch (the UI Restart
// button's bug: it gates on `isRunning(id)` = PTY-only). These pins are the
// pure decision the effectful handler acts on; the T111.4 must-FAIL control
// (mode-dispatch forced to always take the PTY branch) is asserted against the
// built handler in src/main/restart-workspace.test.ts.

test('live PTY → pty (the running terminal agent)', () => {
  assert.equal(
    classifyRestartMode({ hasInput: true }, { ptyLive: true, sdkLive: false }),
    'pty',
  );
});

test('live structured session → structured (NOT pty — this is gap #3)', () => {
  // The defining case: a live structured session must NOT be classified 'pty'.
  // If classifyRestartMode's `live.sdkLive` clause is deleted, this falls through
  // to the persisted-state checks; with sdkSessionId set it still lands
  // 'structured', so the discriminating fixture leaves sdkSessionId UNDEFINED
  // (a session that started but has not yet persisted its id) to force the
  // clause to be the ONLY thing that keeps it off 'pty'.
  assert.equal(
    classifyRestartMode({ hasInput: true, sdkSessionId: undefined }, { ptyLive: false, sdkLive: true }),
    'structured',
  );
});

test('stopped structured (persisted sdkSessionId) → structured', () => {
  assert.equal(
    classifyRestartMode({ sdkSessionId: 'sess-abc' }, { ptyLive: false, sdkLive: false }),
    'structured',
  );
});

test("stopped structured, cleared marker sdkSessionId='' → structured (not pty)", () => {
  // sdkClear sets '' — the surface is still structured even though the
  // conversation was cleared. Must not fall through to the hasInput=pty branch.
  assert.equal(
    classifyRestartMode({ hasInput: true, sdkSessionId: '' }, { ptyLive: false, sdkLive: false }),
    'structured',
  );
});

test('stopped terminal-only (hasInput, no sdkSessionId) → pty', () => {
  assert.equal(
    classifyRestartMode({ hasInput: true, sdkSessionId: undefined }, { ptyLive: false, sdkLive: false }),
    'pty',
  );
});

test('nothing ever ran (no hasInput, no sdkSessionId) → unknown', () => {
  assert.equal(
    classifyRestartMode({}, { ptyLive: false, sdkLive: false }),
    'unknown',
  );
});

test('PTY live wins over a stray structured-live flag (deterministic)', () => {
  assert.equal(
    classifyRestartMode({ sdkSessionId: 'x' }, { ptyLive: true, sdkLive: true }),
    'pty',
  );
});

// --- routeRestart: the effect actually fired, and the fresh flag threaded ---

/** Records which effect fired and with what `fresh`. Exactly one should fire. */
function recordingEffects(): RestartEffects & { calls: Array<{ kind: 'structured' | 'pty'; fresh: boolean }> } {
  const calls: Array<{ kind: 'structured' | 'pty'; fresh: boolean }> = [];
  return {
    calls,
    restartStructured: async (fresh) => { calls.push({ kind: 'structured', fresh }); },
    restartPty: async (fresh) => { calls.push({ kind: 'pty', fresh }); },
  };
}

test('T111.2 — structured mode default routes to restartStructured(fresh=false)', async () => {
  const fx = recordingEffects();
  const fired = await routeRestart('structured', false, fx);
  assert.equal(fired, 'structured');
  assert.deepEqual(fx.calls, [{ kind: 'structured', fresh: false }]);
});

test('T111.2 — structured mode --fresh routes to restartStructured(fresh=true)', async () => {
  const fx = recordingEffects();
  const fired = await routeRestart('structured', true, fx);
  assert.equal(fired, 'structured');
  // The observed DIFFERENCE: same mode, but the fresh flag flips — this is what
  // makes "default preserves conversation, --fresh clears it" reach the effect
  // (sdkRestart branches on it: ensureSession-resume vs sdkClear).
  assert.deepEqual(fx.calls, [{ kind: 'structured', fresh: true }]);
});

test('T111.2 — PTY mode default routes to restartPty(fresh=false)', async () => {
  const fx = recordingEffects();
  const fired = await routeRestart('pty', false, fx);
  assert.equal(fired, 'pty');
  assert.deepEqual(fx.calls, [{ kind: 'pty', fresh: false }]);
});

test('unknown mode throws (no effect fires) — the caller refuses diagnosably', async () => {
  const fx = recordingEffects();
  await assert.rejects(() => routeRestart('unknown', false, fx), /no agent to restart/);
  assert.deepEqual(fx.calls, [], 'no restart effect may fire for an unknown surface');
});

// --- T111.4 must-FAIL control: mode-dispatch forced to always-PTY ---
//
// The gate: a STRUCTURED workspace must route to restartStructured, NEVER
// silently through the PTY branch (the UI Restart button's gap #3). The
// must-FAIL sibling reproduces the broken dispatch — a router that ignores the
// mode and always calls restartPty — and asserts it MISHANDLES a structured
// workspace (fires the PTY effect, an observable wrong path). If the real
// routeRestart ever regressed to this, the T111.2 structured tests above go RED.
async function alwaysPtyRestart(
  _mode: string,
  fresh: boolean,
  effects: RestartEffects,
): Promise<string> {
  // BROKEN ON PURPOSE: the `structured` branch deleted, so every mode → PTY.
  await effects.restartPty(fresh);
  return 'pty';
}

test('T111.4 must-FAIL control: always-PTY dispatch mishandles a structured ws', async () => {
  const fx = recordingEffects();
  const fired = await alwaysPtyRestart('structured', false, fx);
  // The broken dispatch fires the PTY effect for a structured workspace — the
  // observable wrong path the gate exists to catch.
  assert.equal(fired, 'pty');
  assert.deepEqual(fx.calls, [{ kind: 'pty', fresh: false }]);
  assert.notEqual(fx.calls[0].kind, 'structured', 'broken dispatch never reaches the structured effect');
});

test('T111.4 positive: the REAL routeRestart does NOT mishandle a structured ws', async () => {
  const fx = recordingEffects();
  await routeRestart('structured', false, fx);
  assert.equal(fx.calls[0].kind, 'structured', 'a structured ws must take the structured branch');
});
