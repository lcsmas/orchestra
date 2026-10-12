import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRestartMode,
  routeRestart,
  resolveRestart,
  type RestartEffects,
  type RestartWorkspace,
} from './restart-mode.ts';

// ISSUE #111 gap #3 — the CLI restart must route each surface to its own
// restart path. These pins are the pure decision the effectful handler acts on.
// The whole restart glue — every guard, the routing, the error wrap — lives
// here in `resolveRestart` (pure, runtime-tested below); src/main/restart-workspace.ts
// is a thin Electron adapter over it that only injects the store record, the
// live probe, and the real side effects (issue #111 F1: the glue must have a
// runtime arm, not just type-checking). #232: the PTY mode is gone — the three
// outcomes are structured / wake (legacy terminal-only) / unknown (no input).

test('live structured session → structured', () => {
  // If classifyRestartMode's `live.sdkLive` clause is deleted, this falls through
  // to the persisted-state checks; with sdkSessionId set it still lands
  // 'structured', so the discriminating fixture leaves sdkSessionId UNDEFINED
  // (a session that started but has not yet persisted its id) and hasInput true
  // to force the clause to be the ONLY thing that keeps it off 'wake'.
  assert.equal(
    classifyRestartMode({ hasInput: true, sdkSessionId: undefined }, { sdkLive: true }),
    'structured',
  );
});

test('stopped structured (persisted sdkSessionId) → structured', () => {
  assert.equal(
    classifyRestartMode({ sdkSessionId: 'sess-abc' }, { sdkLive: false }),
    'structured',
  );
});

test("stopped structured, cleared marker sdkSessionId='' → structured (not wake)", () => {
  // sdkClear sets '' — the surface is still structured even though the
  // conversation was cleared. Must not fall through to the hasInput=wake branch.
  assert.equal(
    classifyRestartMode({ hasInput: true, sdkSessionId: '' }, { sdkLive: false }),
    'structured',
  );
});

test('stopped legacy terminal-only (hasInput, no sdkSessionId) → wake (#228)', () => {
  // The #228 case: it must resolve to the SDK wake mode (which adopts the terminal
  // transcript so the conversation resumes in the Agent view).
  assert.equal(classifyRestartMode({ hasInput: true, sdkSessionId: undefined }, { sdkLive: false }), 'wake');
});

test('#228 write path twice: once the wake adopts an id, the SAME workspace classifies structured (not wake again)', () => {
  const live = { sdkLive: false };
  const legacy = { hasInput: true, sdkSessionId: undefined };
  assert.equal(classifyRestartMode(legacy, live), 'wake');
  // sdkWakeRestart's adoption persists the transcript's session id; the next restart of that
  // workspace must take the ordinary structured resume, never re-adopt.
  assert.equal(classifyRestartMode({ ...legacy, sdkSessionId: 'adopted-session' }, live), 'structured');
});

test('#228 unchanged neighbours: an sdkSessionId and no input resolve exactly as before', () => {
  const liveNone = { sdkLive: false };
  // (a) any sdkSessionId (real id or the '' cleared marker) wins over hasInput → structured.
  assert.equal(classifyRestartMode({ hasInput: true, sdkSessionId: 'sess-1' }, liveNone), 'structured');
  assert.equal(classifyRestartMode({ hasInput: true, sdkSessionId: '' }, liveNone), 'structured');
  // (b) no input at all → unknown (nothing to restart), even with hasInput explicitly false.
  assert.equal(classifyRestartMode({ hasInput: false, sdkSessionId: undefined }, liveNone), 'unknown');
});

test('nothing ever ran (no hasInput, no sdkSessionId) → unknown', () => {
  assert.equal(
    classifyRestartMode({}, { sdkLive: false }),
    'unknown',
  );
});

// --- routeRestart: the effect actually fired, and the fresh flag threaded ---

/** Records which effect fired and with what `fresh`. Exactly one should fire. */
function recordingEffects(): RestartEffects & { calls: Array<{ kind: 'structured' | 'wake'; fresh: boolean }> } {
  const calls: Array<{ kind: 'structured' | 'wake'; fresh: boolean }> = [];
  return {
    calls,
    restartStructured: async (fresh) => { calls.push({ kind: 'structured', fresh }); },
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

test('#228 — wake mode routes to restartWake and NEVER to restartStructured (fresh threaded)', async () => {
  for (const fresh of [false, true]) {
    const fx = recordingEffects();
    const fired = await routeRestart('wake', fresh, fx);
    assert.equal(fired, 'wake');
    assert.deepEqual(fx.calls, [{ kind: 'wake', fresh }], 'exactly the wake effect fires — no plain structured restart, no PTY');
  }
});

test('unknown mode throws (no effect fires) — the caller refuses diagnosably', async () => {
  const fx = recordingEffects();
  await assert.rejects(() => routeRestart('unknown', false, fx), /no agent to restart/);
  assert.deepEqual(fx.calls, [], 'no restart effect may fire for an unknown surface');
});

// --- T111.4 must-FAIL control: mode-dispatch forced to always-wake ---
//
// The gate: a STRUCTURED workspace must route to restartStructured, NEVER
// silently through the legacy wake branch (which adopts a terminal transcript —
// wrong for a workspace that already owns an SDK session id). The must-FAIL
// sibling reproduces the broken dispatch — a router that ignores the mode and
// always calls restartWake — and asserts it MISHANDLES a structured workspace.
// If the real routeRestart ever regressed to this, the T111.2 structured tests
// above go RED.
async function alwaysWakeRestart(
  _mode: string,
  fresh: boolean,
  effects: RestartEffects,
): Promise<string> {
  // BROKEN ON PURPOSE: the `structured` branch deleted, so every mode → wake.
  await effects.restartWake(fresh);
  return 'wake';
}

test('T111.4 must-FAIL control: always-wake dispatch mishandles a structured ws', async () => {
  const fx = recordingEffects();
  const fired = await alwaysWakeRestart('structured', false, fx);
  // The broken dispatch fires the wake effect for a structured workspace — the
  // observable wrong path the gate exists to catch.
  assert.equal(fired, 'wake');
  assert.deepEqual(fx.calls, [{ kind: 'wake', fresh: false }]);
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

const liveNone = { sdkLive: false };

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

test('resolveRestart: stopped legacy terminal-only ws → WAKE effect fires (#228)', async () => {
  const fx = recordingEffects();
  const ws: RestartWorkspace = { hasInput: true };
  const r = await resolveRestart({ id: 'ws-p', ws, live: liveNone, fresh: false, effects: fx });
  assert.deepEqual(r, { ok: true, mode: 'wake', fresh: false });
  assert.deepEqual(fx.calls, [{ kind: 'wake', fresh: false }]);
});

test('resolveRestart: a LIVE SDK session of a legacy-shaped ws takes the structured effect, not the wake', async () => {
  const fx = recordingEffects();
  const ws: RestartWorkspace = { hasInput: true };
  const r = await resolveRestart({ id: 'ws-p', ws, live: { sdkLive: true }, fresh: false, effects: fx });
  assert.deepEqual(r, { ok: true, mode: 'structured', fresh: false });
  assert.deepEqual(fx.calls, [{ kind: 'structured', fresh: false }]);
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
