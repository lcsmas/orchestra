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

// ─── Seam (b): the terminal --continue gate — workspaces.ts (BOTH sites) ─────

test('seam (b): both PTY launch sites gate --continue on shouldContinuePty + on-disk probe', () => {
  // startAgentPty (the restart/open path) and the raw-PTY wake fallback both
  // compute `resuming` via the guard, never on `ws.hasInput === true` alone.
  const guardCalls = workspacesSrc.match(/shouldContinuePty\(/g) ?? [];
  assert.ok(
    guardCalls.length >= 2,
    `both PTY seams must call shouldContinuePty, found ${guardCalls.length}`,
  );
  const probeCalls = workspacesSrc.match(/newestTranscriptExists\(ws\)/g) ?? [];
  assert.ok(
    probeCalls.length >= 2,
    `both PTY seams must feed the on-disk newestTranscriptExists(ws) probe, found ${probeCalls.length}`,
  );
  // must-FAIL arm: the old `const resuming = ws.hasInput === true` (with or
  // without the fresh clause) must be GONE from both launch sites — it is the
  // phantom `--continue` dead-end.
  assert.ok(
    !/const resuming = ws\.hasInput === true(?:\s*&&|;)/.test(workspacesSrc),
    'the raw `resuming = ws.hasInput === true` gate must be replaced by shouldContinuePty at both sites',
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
  const body = bodyOf(agentSdkSrc, 'export async function sdkWake');
  assert.ok(
    callsUncommented(body, 'fs.existsSync') && body.includes('.jsonl'),
    'sdkWake must only adopt an id whose transcript exists — the precedent seam (a) reuses',
  );
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
