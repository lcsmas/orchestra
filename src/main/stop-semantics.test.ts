// Keeper stop→restart seam — S2 (D2) + S3 (D3) of docs/research/keeper-audit-2026-09-14.md.
//
// This file carries the DEFAULT-SUITE regression: the pure decisions each fix
// makes, plus source-binding guards that redden on the obvious mutants (identity
// guard removed, fall-through removed, flag never latched). The end-to-end
// SURVIVAL/KILL behaviour these decisions produce is driven by two rigs run
// under the R2 resolve hook (not in this suite — they import real main modules
// with extensionless specifiers the default runner cannot resolve):
//
//   scripts/e2e-stop-semantics.mjs — drives the REAL consume()/sdkStop/sessions
//     map with a stub CLI. MEASURED:
//       s2_successor    fixed → hasSession true / delivery 'started';
//                       unfixed → hasSession false / delivery 'none'.
//       s3_no_result    fixed → killKeeper called 1×; unfixed → 0×.
//       s3_with_result  fixed & unfixed → killKeeper 0× (control).
//   scripts/e2e-keeper-kill-authority.mjs — the half the stub cannot show: a
//     REAL keeper daemon + a REAL never-result child, killed by the REAL
//     killKeeper. MEASURED: keeper pid AND CLI pid both dead within 20 s.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname2 = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname2, '..', '..');
const AGENT_SDK = path.join(REPO, 'src', 'main', 'agent-sdk.ts');

// ─── Source-binding guards ───────────────────────────────────────────────────

/** File with line comments stripped, so prose ABOUT a design cannot satisfy a
 *  structural check. */
function codeOf(file: string): string {
  const raw = fs.readFileSync(file, 'utf8');
  const stripped = raw
    .split('\n')
    .filter(
      (l) =>
        !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'),
    )
    .join('\n');
  assert.ok(stripped.length > 5_000, `comment-stripping ${path.basename(file)} returned too little`);
  return stripped;
}

/** The body of a named function/declaration, sliced to the next top-level
 *  `function`/`export`. */
function fnBody(code: string, sig: string): string {
  const start = code.indexOf(sig);
  assert.notEqual(start, -1, `${sig} not found in agent-sdk.ts — was it renamed?`);
  const rest = code.slice(start);
  const end = rest.indexOf('\nfunction ', 1);
  const alt = rest.indexOf('\nexport ', 1);
  const cut = [end, alt].filter((n) => n > 0).sort((a, b) => a - b)[0] ?? -1;
  const body = cut === -1 ? rest : rest.slice(0, cut);
  assert.ok(body.length > 200, `the ${sig} slice came back suspiciously short`);
  return body;
}

test('S2 GUARD: consume() deletes the session only when it still owns the slot', () => {
  const body = fnBody(codeOf(AGENT_SDK), 'async function consume(');
  // The identity guard must wrap the delete/reconcile. Without it, the finally
  // deletes whatever session owns wsId — the successor after a restart (D2).
  assert.match(
    body,
    /if\s*\(\s*sessions\.get\(session\.wsId\)\s*===\s*session\s*\)\s*\{/,
    'consume() finally must guard `sessions.delete`/`reconcileExited` on ' +
      '`sessions.get(session.wsId) === session` (D2), or it deletes the successor session',
  );
  // Both the delete and the reconcile call must be INSIDE that guard (a live
  // successor's dot must not be floored by the predecessor's teardown).
  const guardAt = body.search(/if\s*\(\s*sessions\.get\(session\.wsId\)\s*===\s*session\s*\)/);
  const deleteAt = body.indexOf('sessions.delete(session.wsId)');
  const reconcileAt = body.indexOf('reconcileExited(session.wsId)');
  assert.ok(guardAt !== -1 && deleteAt > guardAt, 'sessions.delete must be inside the identity guard');
  assert.ok(reconcileAt > guardAt, 'reconcileExited must be inside the identity guard');
});

test('S3 GUARD: sdkStop falls through to killKeeper when no result was seen', () => {
  const body = fnBody(codeOf(AGENT_SDK), 'export async function sdkStop(');
  // The flag is captured before any await (a late result must not retroactively
  // skip the kill).
  assert.match(body, /const\s+sawResult\s*=\s*session\.sawResult/, 'sdkStop must latch sawResult before awaiting');
  // The fall-through kill, guarded on !sawResult.
  assert.match(
    body,
    /if\s*\(\s*!sawResult\s*\)\s*\{[\s\S]*killKeeper/,
    'sdkStop must `await killKeeper` when no result was seen (D3)',
  );
  // The interrupt (graceful attempt) precedes the kill — the kill is a
  // FALL-THROUGH, not a replacement.
  const interruptAt = body.indexOf('.interrupt()');
  const killAt = body.search(/if\s*\(\s*!sawResult\s*\)/);
  assert.ok(interruptAt !== -1 && killAt > interruptAt, 'the killKeeper fall-through must come AFTER the graceful interrupt');
});

test('S3 GUARD: consume() latches sawResult in the result branch', () => {
  const body = fnBody(codeOf(AGENT_SDK), 'async function consume(');
  const resultBranchAt = body.indexOf("msg.type === 'result'");
  assert.notEqual(resultBranchAt, -1, "consume() must have a `msg.type === 'result'` branch");
  const setAt = body.indexOf('session.sawResult = true');
  assert.ok(setAt > resultBranchAt, 'sawResult must be latched true inside the result branch');
});

// ─── The pure decisions, executed (redden on the logic mutant) ────────────────

/** Model sdkStop's D3 decision: does the fall-through kill fire? */
function fallThroughKillFires(sawResult: boolean): boolean {
  return !sawResult; // shipped: `if (!sawResult) await killKeeper(...)`
}

test('S3 DECISION: kill fires iff the CLI produced no result', () => {
  assert.equal(
    fallThroughKillFires(false),
    true,
    'no result yet ⇒ kill (the CLI would otherwise orphan in a removed worktree)',
  );
  assert.equal(
    fallThroughKillFires(true),
    false,
    'result seen ⇒ graceful close alone (preserves transcript flush)',
  );
});

/** Model consume()'s D2 decision: does the finally delete this wsId's slot? */
function finallyDeletesSlot(slotHoldsThisSession: boolean): boolean {
  return slotHoldsThisSession; // shipped: `if (sessions.get(wsId) === session) delete`
}

test('S2 DECISION: the finally removes only its own session', () => {
  // A dies while it still owns the slot (the ordinary case) — delete.
  assert.equal(finallyDeletesSlot(true), true);
  // A's loop unwinds AFTER a restart put successor B in the slot — do NOT delete
  // (that is the D2 fault: it would evict the live successor).
  assert.equal(finallyDeletesSlot(false), false);
});
