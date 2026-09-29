import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRestartMode,
  routeRestart,
  resolveRestart,
  type RestartEffects,
  type RestartWorkspace,
} from './restart-mode.ts';

// ISSUE #111 gap #3 — the CLI restart must route the STRUCTURED surface to its
// own restart path, never silently through the PTY branch (the UI Restart
// button's bug: it gates on `isRunning(id)` = PTY-only). These pins are the
// pure decision the effectful handler acts on. The whole restart glue — every
// guard, the routing, the error wrap — lives here in `resolveRestart` (pure,
// runtime-tested below); src/main/restart-workspace.ts is a thin Electron
// adapter over it that only injects the store record, the live probes, and the
// real side effects (issue #111 F1: the glue must have a runtime arm, not just
// type-checking).

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

test('stopped legacy terminal-only (hasInput, no sdkSessionId) → wake, NEVER pty (#228)', () => {
  // The #228 case: it must resolve to the SDK wake mode (which adopts the terminal
  // transcript so the conversation resumes in the Agent view). The OLD classifier
  // returned 'pty' here, so this fails on it.
  const mode = classifyRestartMode({ hasInput: true, sdkSessionId: undefined }, { ptyLive: false, sdkLive: false });
  assert.equal(mode, 'wake');
  assert.notEqual(mode, 'pty', 'a stopped legacy workspace must not be routed to a PTY restart');
});

test('#228 write path twice: once the wake adopts an id, the SAME workspace classifies structured (not wake again)', () => {
  const live = { ptyLive: false, sdkLive: false };
  const legacy = { hasInput: true, sdkSessionId: undefined };
  assert.equal(classifyRestartMode(legacy, live), 'wake');
  // sdkWakeRestart's adoption persists the transcript's session id; the next restart of that
  // workspace must take the ordinary structured resume, never re-adopt.
  assert.equal(classifyRestartMode({ ...legacy, sdkSessionId: 'adopted-session' }, live), 'structured');
});

test('#228 unchanged neighbours: an sdkSessionId, no input, and a LIVE PTY resolve exactly as before', () => {
  const liveNone = { ptyLive: false, sdkLive: false };
  // (a) any sdkSessionId (real id or the '' cleared marker) wins over hasInput → structured.
  assert.equal(classifyRestartMode({ hasInput: true, sdkSessionId: 'sess-1' }, liveNone), 'structured');
  assert.equal(classifyRestartMode({ hasInput: true, sdkSessionId: '' }, liveNone), 'structured');
  // (b) no input at all → unknown (nothing to restart), even with hasInput explicitly false.
  assert.equal(classifyRestartMode({ hasInput: false, sdkSessionId: undefined }, liveNone), 'unknown');
  // (c) a LIVE PTY still resolves 'pty' — the live-PTY case leaves with #232, not here — even for the
  //     legacy shape that would otherwise wake.
  assert.equal(classifyRestartMode({ hasInput: true, sdkSessionId: undefined }, { ptyLive: true, sdkLive: false }), 'pty');
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
function recordingEffects(): RestartEffects & { calls: Array<{ kind: 'structured' | 'pty' | 'wake'; fresh: boolean }> } {
  const calls: Array<{ kind: 'structured' | 'pty' | 'wake'; fresh: boolean }> = [];
  return {
    calls,
    restartStructured: async (fresh) => { calls.push({ kind: 'structured', fresh }); },
    restartPty: async (fresh) => { calls.push({ kind: 'pty', fresh }); },
    restartWake: async (fresh) => { calls.push({ kind: 'wake', fresh }); },
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

test('#228 — wake mode routes to restartWake and NEVER to restartPty (fresh threaded)', async () => {
  for (const fresh of [false, true]) {
    const fx = recordingEffects();
    const fired = await routeRestart('wake', fresh, fx);
    assert.equal(fired, 'wake');
    assert.deepEqual(fx.calls, [{ kind: 'wake', fresh }], 'exactly the wake effect fires — no PTY launch');
  }
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

// --- resolveRestart: the full glue (guards + routing + error wrap) ----------
//
// This is the runtime arm for the effectful handler's logic (issue #111 F1):
// dispatchRestartRequest is a thin adapter over resolveRestart, so exercising
// resolveRestart directly covers every guard and the effect wiring WITHOUT
// Electron. Each guard test asserts NO effect fired (a guard that leaked into a
// restart would be a stray-agent spawn).

const liveNone = { ptyLive: false, sdkLive: false };

test('resolveRestart: missing id → {ok:false} before any effect', async () => {
  const fx = recordingEffects();
  const r = await resolveRestart({ id: undefined, ws: null, live: liveNone, fresh: false, effects: fx });
  assert.deepEqual(r, { ok: false, error: 'missing id' });
  assert.deepEqual(fx.calls, []);
});

test('resolveRestart: unknown workspace (ws=null) → diagnosable, no effect', async () => {
  const fx = recordingEffects();
  const r = await resolveRestart({ id: 'ghost', ws: null, live: liveNone, fresh: false, effects: fx });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /unknown workspace: ghost/);
  assert.deepEqual(fx.calls, []);
});

test('resolveRestart: archived workspace → refused, no effect', async () => {
  const fx = recordingEffects();
  const ws: RestartWorkspace = { archived: true, sdkSessionId: 'x' };
  const r = await resolveRestart({ id: 'ws-arch', ws, live: liveNone, fresh: false, effects: fx });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /archived/);
  assert.deepEqual(fx.calls, [], 'an archived ws must not restart');
});

test('resolveRestart: nothing-ever-ran (mode unknown) → refused, no effect', async () => {
  const fx = recordingEffects();
  const r = await resolveRestart({ id: 'ws-new', ws: {}, live: liveNone, fresh: false, effects: fx });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /no agent to restart yet/);
  assert.deepEqual(fx.calls, []);
});

test('resolveRestart: structured ws → structured effect fires, {ok, mode, fresh}', async () => {
  const fx = recordingEffects();
  const ws: RestartWorkspace = { sdkSessionId: 'sess-1' };
  const r = await resolveRestart({ id: 'ws-s', ws, live: liveNone, fresh: true, effects: fx });
  assert.deepEqual(r, { ok: true, mode: 'structured', fresh: true });
  assert.deepEqual(fx.calls, [{ kind: 'structured', fresh: true }]);
});

test('resolveRestart: stopped legacy terminal-only ws → WAKE effect fires, no PTY (#228)', async () => {
  const fx = recordingEffects();
  const ws: RestartWorkspace = { hasInput: true };
  const r = await resolveRestart({ id: 'ws-p', ws, live: liveNone, fresh: false, effects: fx });
  assert.deepEqual(r, { ok: true, mode: 'wake', fresh: false });
  assert.deepEqual(fx.calls, [{ kind: 'wake', fresh: false }]);
});

test('resolveRestart: a LIVE PTY still takes the pty effect (unchanged until #232)', async () => {
  const fx = recordingEffects();
  const ws: RestartWorkspace = { hasInput: true };
  const r = await resolveRestart({ id: 'ws-p', ws, live: { ptyLive: true, sdkLive: false }, fresh: false, effects: fx });
  assert.deepEqual(r, { ok: true, mode: 'pty', fresh: false });
  assert.deepEqual(fx.calls, [{ kind: 'pty', fresh: false }]);
});

test('resolveRestart: a THROWN effect is wrapped as {ok:false} + onError called', async () => {
  let logged: { mode: string; message: string } | null = null;
  const ws: RestartWorkspace = { sdkSessionId: 'sess-1' };
  const r = await resolveRestart({
    id: 'ws-s',
    ws,
    live: liveNone,
    fresh: false,
    effects: {
      restartStructured: async () => { throw new Error('boom'); },
      restartPty: async () => {},
      restartWake: async () => {},
    },
    onError: (mode, message) => { logged = { mode, message }; },
  });
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /restart failed: boom/);
  // Diagnosable, not a raw throw escaping to the socket.
  assert.doesNotMatch(r.error ?? '', /\n\s+at\s/);
  assert.deepEqual(logged, { mode: 'structured', message: 'boom' });
});

// C3 for the guards: delete the archived guard and its arm goes RED — proving
// the arm reaches that clause. (Documented here; the live mutation is run in
// the nomination's C3 pass, same as the classifier/router arms.)
