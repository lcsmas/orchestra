// #178/#179 — source-binding gate. The DECISION logic is proven in
// src/shared/resume-guard.test.ts, but a green decision suite says nothing if
// the shipped seams never CALL it (the reparent-run-binding.test.ts F2 trap: a
// path that re-implements or omits the wire passes the logic test byte-identical
// on the unfixed build). `agent-sdk.ts` / `workspaces.ts` cannot load under
// `node --test` (the ./platform dir-import + extensionless-import traps in repo
// memory), so this reads the SHIPPED source and asserts each of the four #178
// seams is wired to the guard — each with a must-FAIL arm (a body that merely
// mentions the symbol must not satisfy "actually wired").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const agentSdkSrc = readFileSync(path.join(here, 'agent-sdk.ts'), 'utf8');
const workspacesSrc = readFileSync(path.join(here, 'workspaces.ts'), 'utf8');
const restartModeSrc = readFileSync(path.join(here, '..', 'shared', 'restart-mode.ts'), 'utf8');
const restartWorkspaceSrc = readFileSync(path.join(here, 'restart-workspace.ts'), 'utf8');
const apiHandlersSrc = readFileSync(path.join(here, 'api-handlers.ts'), 'utf8');

/** The body of a named function, from its declaration to the next top-level
 *  `function`/`export function`/`export async function` — scopes a "does THIS
 *  function call X" assertion so a call in a NEIGHBOUR does not satisfy it. */
function bodyOf(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `declaration not found: ${decl}`);
  const after = src.slice(start + decl.length);
  const next = after.search(/\n(?:export )?(?:async )?function /);
  return after.slice(0, next === -1 ? after.length : next);
}

/** True iff `snippet` appears on a NON-comment line (a commented-out `// call()`
 *  must not satisfy a call assertion). */
function callsUncommented(src: string, snippet: string): boolean {
  return src.split('\n').some((line) => {
    if (!line.includes(snippet)) return false;
    const t = line.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
}

// ─── Seam (a): the structured resume gate — agent-sdk.ts ensureSessionInner ───

test('seam (a): the ONLY query({resume}) resumes the RESOLVED id, never raw ws.sdkSessionId', () => {
  const body = bodyOf(agentSdkSrc, 'async function ensureSessionInner');
  // The resolved id is computed from the on-disk probe...
  assert.ok(
    callsUncommented(body, 'resolveResumeId(ws.sdkSessionId'),
    'ensureSessionInner must compute resumeId via resolveResumeId(ws.sdkSessionId, …)',
  );
  assert.ok(
    callsUncommented(body, 'transcriptExistsFor(ws'),
    'the resolveResumeId probe must be the on-disk transcriptExistsFor(ws, …)',
  );
  // reviewer-restart F1: the probe MUST be remote-aware — the local-disk check is
  // invalid for a sandbox session (transcript lives in the container), so it must
  // TRUST a remote id, not probe local disk (which would discard remote history).
  // must-FAIL arm: reverting to an unconditional local probe reddens.
  assert.ok(
    callsUncommented(body, 'remote ? true : transcriptExistsFor(ws'),
    'the resolveResumeId probe must be `remote ? true : transcriptExistsFor(ws, id)` (F1: no remote data loss)',
  );
  assert.ok(
    !/resolveResumeId\(ws\.sdkSessionId,\s*\(id\)\s*=>\s*transcriptExistsFor\(ws/.test(body),
    'must NOT feed the unconditional local probe — that discards every sandbox conversation (F1)',
  );
  // ...and THAT is what feeds resume, not the raw field. must-FAIL arm: reject a
  // reversion to `resume: ws.sdkSessionId`.
  assert.ok(
    callsUncommented(body, 'resumeId ? { resume: resumeId }'),
    'the resume option must gate on the resolved resumeId',
  );
  assert.ok(
    !/\bresume:\s*ws\.sdkSessionId\b/.test(body),
    'must NOT resume raw ws.sdkSessionId — that is the phantom-resume dead-end (#178)',
  );
  // The orchestrator brief (fresh-only) must also key on the resolved id, so a
  // phantom fresh-start gets the brief a fresh session is due.
  assert.ok(
    callsUncommented(body, '!resumeId && ws.kind'),
    'the orchestrator-brief fresh gate must key on !resumeId, not !ws.sdkSessionId',
  );
});

test('seam (a): transcriptExistsFor probes the .jsonl on disk (the sdkWake discriminator)', () => {
  const body = bodyOf(agentSdkSrc, 'function transcriptExistsFor');
  assert.ok(
    callsUncommented(body, 'existsSync') && body.includes('.jsonl'),
    'transcriptExistsFor must existsSync the <dir>/<id>.jsonl — the proactive discriminator',
  );
});

// ─── Seam (b): the terminal --continue gate — workspaces.ts (startAgentPty) ──

test('seam (b): the PTY launch site gates --continue on shouldContinuePty + on-disk probe', () => {
  // startAgentPty (the restart/open path) computes `resuming` via the guard, never on
  // `ws.hasInput === true` alone. (#227 removed the SECOND site, the raw-PTY wake fallback: a wake
  // that cannot start an SDK session now returns false instead of launching a PTY.)
  const guardCalls = workspacesSrc.match(/shouldContinuePty\(/g) ?? [];
  assert.ok(
    guardCalls.length >= 1,
    `the PTY seam must call shouldContinuePty, found ${guardCalls.length}`,
  );
  const probeCalls = workspacesSrc.match(/newestTranscriptExists\(ws\)/g) ?? [];
  assert.ok(
    probeCalls.length >= 1,
    `the PTY seam must feed the on-disk newestTranscriptExists(ws) probe, found ${probeCalls.length}`,
  );
  // must-FAIL arm: the old `const resuming = ws.hasInput === true` (with or
  // without the fresh clause) must be GONE from the launch site — it is the
  // phantom `--continue` dead-end.
  assert.ok(
    !/const resuming = ws\.hasInput === true(?:\s*&&|;)/.test(workspacesSrc),
    'the raw `resuming = ws.hasInput === true` gate must be replaced by shouldContinuePty',
  );
});

test('seam (b): newestTranscriptExists reads the project dir for any .jsonl', () => {
  const body = bodyOf(workspacesSrc, 'export function newestTranscriptExists');
  assert.ok(
    callsUncommented(body, 'readdirSync') && body.includes(".jsonl"),
    'newestTranscriptExists must readdirSync the transcript dir and match .jsonl',
  );
});

// ─── Seam (c): the routing classifier — restart-mode.ts ──────────────────────

test('seam (c): a phantom id stays structured (documented) — routing unchanged, heal at the resume site', () => {
  const body = bodyOf(restartModeSrc, 'export function classifyRestartMode');
  // A phantom id is deliberately STILL structured (seam a heals it). Assert the
  // structured branch survives and the reasoning is recorded so a future reader
  // does not reroute it (which would bypass the structured fresh-start).
  assert.ok(
    callsUncommented(body, "if (ws.sdkSessionId !== undefined) return 'structured'"),
    'a non-undefined sdkSessionId (phantom included) must route structured',
  );
  assert.ok(
    /seam \(c\)/.test(restartModeSrc) && /phantom/i.test(restartModeSrc),
    'the phantom-stays-structured reasoning must be documented at seam (c) (#178)',
  );
});

// ─── Seam (d): sdkWake adoption already gates on the transcript existing ──────

test('seam (d): sdkWake adoption still requires the transcript .jsonl to exist (no phantom minted)', () => {
  // #228 moved the adoption body out of sdkWake into adoptTerminalTranscript so the legacy
  // restart (sdkWakeRestart) shares it; the existence probe lives THERE now, and both callers
  // must reach it.
  const body = bodyOf(agentSdkSrc, 'async function adoptTerminalTranscript');
  assert.ok(
    callsUncommented(body, 'fs.existsSync') && body.includes('.jsonl'),
    'adoptTerminalTranscript must only adopt an id whose transcript exists — the precedent seam (a) reuses',
  );
  assert.ok(
    callsUncommented(bodyOf(agentSdkSrc, 'export async function sdkWake'), 'await adoptTerminalTranscript(wsId)'),
    'sdkWake must still adopt through the shared helper',
  );
});

// ─── #228: the legacy terminal-only restart — `wake` mode → sdkWakeRestart → adoption ───────
// The classifier/router are proven in src/shared/restart-mode.test.ts; these pin the two seams
// only the built app (scripts/e2e-agent-view-removal.mjs `legacy_restart*`) exercised, so a later
// wave rewriting the wake/restart area cannot drop adoption with `pnpm run test` green.

test('#228: the restartWake effect is sdkWakeRestart (plain sdkRestart would resume nothing for a legacy ws)', () => {
  const body = bodyOf(restartWorkspaceSrc, 'export async function dispatchRestartRequest');
  assert.ok(
    callsUncommented(body, 'restartWake: (f) => sdkWakeRestart(id!, { fresh: f, trigger })'),
    'dispatchRestartRequest must wire restartWake to sdkWakeRestart(id, {fresh, trigger})',
  );
  // must-FAIL arm: the structured effect (`sdkRestart`) is the neighbour this must not be swapped for.
  assert.ok(
    callsUncommented(body, 'restartStructured: (f) => sdkRestart(id!, { fresh: f, trigger })'),
    'control: restartStructured still calls plain sdkRestart (the two effects stay distinct)',
  );
});

test('#228: sdkWakeRestart adopts the terminal transcript BEFORE sdkRestart, and never on --fresh', () => {
  const body = bodyOf(agentSdkSrc, 'export async function sdkWakeRestart');
  const adopt = 'if (!opts.fresh) await adoptTerminalTranscript(wsId);';
  assert.ok(callsUncommented(body, adopt), 'adoption must be guarded by !opts.fresh (a fresh restart drops the conversation; adopting first would persist an id --fresh must never keep)');
  assert.ok(callsUncommented(body, 'await sdkRestart(wsId, opts);'), 'sdkWakeRestart must hand off to sdkRestart');
  assert.ok(
    body.indexOf(adopt) !== -1 && body.indexOf(adopt) < body.indexOf('await sdkRestart(wsId, opts);'),
    'adoption must run BEFORE sdkRestart (ensureSession resumes ws.sdkSessionId; adopting after it starts a blank session)',
  );
});

// ─── #230 (#228 review O1/F1): the session-start FUNNEL adopts the terminal transcript ─────────────
// Only the built app (scripts/e2e-agent-view-removal.mjs `legacy_composer_send` / `legacy_first_action_*`) exercises the behaviour;
// this pins the seam so a later wave rewriting ensureSessionInner cannot drop adoption or move it after the resume id is resolved.

test('#230: ensureSessionInner adopts the terminal transcript AFTER the sandbox refusal and BEFORE resolveResumeId', () => {
  const body = bodyOf(agentSdkSrc, 'async function ensureSessionInner');
  const adopt = 'await adoptTerminalTranscript(wsId);';
  assert.ok(callsUncommented(body, adopt), 'ensureSessionInner must adopt through the shared helper');
  const at = body.indexOf(adopt);
  const refuse = body.indexOf('if (paused) throw new Error(paused);');
  const resolve = body.indexOf('resolveResumeId(ws.sdkSessionId');
  assert.ok(refuse !== -1 && refuse < at, 'adoption must run AFTER the sandbox refusal (a refused start writes nothing)');
  assert.ok(resolve !== -1 && at < resolve, 'adoption must run BEFORE resolveResumeId (adopting after it starts a blank session)');
  // must-FAIL arm: the record must be RE-READ after the adoption (it persists sdkSessionId) — resolveResumeId reads the fresh one.
  assert.ok(callsUncommented(body, 'ws = store.getWorkspace(wsId) ?? ws;'), 'ws must be re-read after the adoption persisted the resume id');
});

test('#230 r2 F1: consume clears an ADOPTED id whose CLI ended before any stream message — to the \'\' marker, never undefined', () => {
  const body = bodyOf(agentSdkSrc, 'async function consume');
  assert.ok(callsUncommented(body, "const adoptedDead = outcome.kind === 'error' && session.adoptedResume !== undefined && !session.firstMessageSeen;"), 'the adopted-id death signal must key on an errored end, an adopted resume and NO stream message');
  assert.ok(callsUncommented(body, "void persistWorkspacePatch(session.wsId, { sdkSessionId: wasAdopted ? '' : undefined });"), "an adopted id clears to the '' marker; only a non-adopted bad-resume id clears to undefined (undefined re-adopts the same transcript for a hasInput workspace)");
  // the id is recorded by the adoption and read ONCE at session creation
  assert.ok(callsUncommented(bodyOf(agentSdkSrc, 'async function adoptTerminalTranscript'), 'adoptedTranscripts.set(wsId, adopted);'), 'adoptTerminalTranscript must record the id it adopted');
  assert.ok(callsUncommented(bodyOf(agentSdkSrc, 'async function ensureSessionInner'), 'session.adoptedResume = adoptedId !== undefined && resumeId === adoptedId ? adoptedId : undefined;'), 'ensureSessionInner must stamp session.adoptedResume only when the resumed id IS the adopted one');
});

test('#230: the composer IPC is the bare sdkSend — adoption is the funnel\'s job, not one entry point\'s', () => {
  const start = apiHandlersSrc.indexOf('agentSdkSend: async (wsId, text, images) => {');
  assert.notEqual(start, -1, 'agentSdkSend handler not found');
  const body = apiHandlersSrc.slice(start, apiHandlersSrc.indexOf('},', start));
  assert.ok(callsUncommented(body, 'await sdkSend(wsId, text, images);'), 'agentSdkSend must call sdkSend(wsId, text, images)');
});

// ─── #179: the working-guard uses decideRestartGuard, and the fresh path
//     redelivers through the existing #174 seam (recoverPendingPrompts) ───────

test('#179: sdkRestart replaces the raw turnGate refusal with decideRestartGuard', () => {
  const body = bodyOf(agentSdkSrc, 'export async function sdkRestart');
  assert.ok(
    callsUncommented(body, 'decideRestartGuard({'),
    'sdkRestart must decide via decideRestartGuard, not a bare turnGate !== null refusal',
  );
  // must-FAIL arm: the always-refuse gate `if (live && live.turnGate !== null) {
  // throw … working …}` must be GONE from sdkRestart (it is what looped forever).
  assert.ok(
    !/if \(live && live\.turnGate !== null\) \{\s*\n\s*throw new Error\('The agent is working — interrupt it first, then restart\./.test(
      body,
    ),
    'the unconditional working-refusal must be removed from sdkRestart (#179)',
  );
  // refuse still throws for a genuinely working session...
  assert.ok(
    callsUncommented(body, "guard === 'refuse'") &&
      body.includes('The agent is working — interrupt it first, then restart.'),
    'a started session mid-turn must still be politely refused',
  );
  // ...and the never-started 'fresh' path redelivers via the #174 seam, not a
  // parallel one (D3: route fresh-starts through recoverPendingPrompts).
  assert.ok(
    callsUncommented(body, "guard === 'fresh'") &&
      callsUncommented(body, 'recoverPendingPrompts(wsId, [])'),
    'the never-started restart must converge by redelivering via recoverPendingPrompts (#174/#179)',
  );
});

test('F3: recoverPendingPrompts COALESCES concurrent calls (no double opening-prompt delivery)', () => {
  // reviewer-restart F3: sdkRestart's 'fresh' path, the watchdog's recycleSession,
  // and the structured-view open path all call recoverPendingPrompts; two racing
  // callers each read ws.sdkPendingPrompts then drain it, so both could resend the
  // same opening prompt (a TOCTOU double-delivery). The exported entry must
  // coalesce onto ONE in-flight run (same idiom as `ensuring`), so a second caller
  // awaits the first (which drained the list) rather than re-reading stale state.
  // must-FAIL arm: without the in-flight map the export runs the body directly.
  assert.ok(
    /const recovering = new Map<string, Promise<void>>\(\)/.test(agentSdkSrc),
    'a per-wsId in-flight map must coalesce concurrent recoverPendingPrompts calls',
  );
  const exportBody = bodyOf(agentSdkSrc, 'export function recoverPendingPrompts');
  assert.ok(
    callsUncommented(exportBody, 'recovering.get(wsId)') &&
      callsUncommented(exportBody, 'recovering.set(wsId'),
    'the exported recoverPendingPrompts must return an in-flight promise / register one, not run the body inline',
  );
  // The real work moved to the Inner; the export is only the coalescing wrapper.
  assert.ok(
    /async function recoverPendingPromptsInner\(/.test(agentSdkSrc),
    'the recovery body must live in recoverPendingPromptsInner, guarded by the coalescing export',
  );
});
