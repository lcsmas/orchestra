// #142 — source-binding gate: the pure decision (reparent-run.test.ts) proves the
// LOGIC, but a green logic suite says nothing if the admin handlers never CALL the
// reconcile, or the CLI send never calls the refusal (the #116 review-F2 trap: a
// string assertion that passes while the shipped path re-implements or omits the
// wire). `workspaces.ts`/`cli/index.ts` cannot load under `node --test` (Electron/
// socket seams), so this reads the SHIPPED source and asserts each wire is present,
// each with a must-FAIL arm (a body that merely mentions the symbol must not
// satisfy the "actually wired" check).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const workspacesSrc = readFileSync(path.join(here, 'workspaces.ts'), 'utf8');
const restartSrc = readFileSync(path.join(here, 'restart-workspace.ts'), 'utf8');
const cliSrc = readFileSync(path.join(here, '..', 'cli', 'index.ts'), 'utf8');

/** The body of a named function/handler, from its declaration to a heuristic end
 *  (the next top-level `export async function`/`export function`). Good enough to
 *  scope a "does THIS handler call X" assertion so a call in a NEIGHBOUR does not
 *  satisfy it. */
function bodyOf(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `declaration not found: ${decl}`);
  const after = src.slice(start + decl.length);
  const nextExport = after.search(/\nexport (?:async )?function /);
  return after.slice(0, nextExport === -1 ? after.length : nextExport);
}

/** True iff `snippet` appears on a line that is NOT a comment (REVIEW-142 F3: a
 *  bare `includes()` is satisfied by a commented-out `// call()`, so a call
 *  assertion must reject a line whose trimmed form starts with `//` or `*`). A
 *  crude but sufficient line-scan — the shipped calls we assert are single-line. */
function callsUncommented(src: string, snippet: string): boolean {
  return src.split('\n').some((line) => {
    if (!line.includes(snippet)) return false;
    const t = line.trimStart();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
}

test('dispatchAttachRequest wires reconcileRunAfterReparent on BOTH branches', () => {
  const body = bodyOf(workspacesSrc, 'export async function dispatchAttachRequest');
  // Two return sites (detach + attach) each snapshot then reconcile.
  const snaps = body.match(/snapshotRunAnchors\(/g) ?? [];
  const recon = body.match(/reconcileRunAfterReparent\(/g) ?? [];
  assert.ok(snaps.length >= 2, `attach must snapshot on both branches, found ${snaps.length}`);
  assert.ok(recon.length >= 2, `attach must reconcile on both branches, found ${recon.length}`);
  // must-FAIL arm: the noRestart plumbing must reach the reconcile, or --no-restart
  // is silently ignored (G4 vacuous).
  assert.ok(body.includes('{ noRestart }'), 'attach must pass noRestart into reconcile');
});

test('dispatchDemoteRequest reconciles the demoted node ITSELF + its subtree (F1)', () => {
  const body = bodyOf(workspacesSrc, 'export async function dispatchDemoteRequest');
  // REVIEW-142 F1: the demoted node is its OWN run anchor while it coordinates;
  // the demote strips canOrchestrate, so its own run moves too. The snapshot MUST
  // root at `id` (which collectWorkspaceTree(id) includes), not at each child —
  // `snapshotRunAnchors(child.id)` never reaches the parent, leaving the demoted
  // node's live session on a defunct self-run.
  assert.ok(
    callsUncommented(body, 'snapshotRunAnchors(id)'),
    'demote must snapshot from `id` (includes the demoted node itself), not child-only',
  );
  assert.ok(
    !body.includes('snapshotRunAnchors(child.id)'),
    'demote must NOT snapshot child-only (F1: that omits the demoted node)',
  );
  assert.ok(
    callsUncommented(body, 'reconcileRunAfterReparent('),
    'demote must reconcile after detaching children',
  );
});

test('#171 — dispatchPromoteRequest snapshots + reconciles on BOTH routes (env refresh)', () => {
  const body = bodyOf(workspacesSrc, 'export async function dispatchPromoteRequest');
  // #171: promote re-anchors the promoted node (member → its OWN run). Without a
  // reconcile the LIVE session keeps the parent's ORCHESTRA_RUN_ID until a manual
  // `orchestra restart` (the ticket's 4× symptom). The snapshot MUST be taken
  // pre-mutation (resolveWaveRunId reads the store), and BOTH promote routes
  // (worktree canOrchestrate + scratch kind-swap) must reconcile.
  assert.ok(
    callsUncommented(body, 'snapshotRunAnchors(id)'),
    'promote must snapshot the promoted node + subtree BEFORE the mutation',
  );
  const recon = body.match(/reconcileRunAfterReparent\(/g) ?? [];
  assert.ok(
    recon.length >= 2,
    `promote must reconcile on BOTH routes (worktree + scratch), found ${recon.length}`,
  );
  // must-FAIL arm: a promote-triggered reconcile must NOT --no-restart by default
  // (that would leave EVERY idle promote stale, defeating the auto-refresh), and
  // must defer a live PTY rather than kill it mid-turn (arm 2).
  assert.ok(
    callsUncommented(body, 'noRestart: false'),
    'promote must reconcile with noRestart:false (auto-restart an idle session)',
  );
  assert.ok(
    callsUncommented(body, 'preferStaleForLivePty: true'),
    'promote must defer a live raw PTY (arm 2: never a mid-turn kill of an unguarded PTY)',
  );
});

test('#171 — a REFUSED/failed restart downgrades to mark-stale (never leaves a stale run silently)', () => {
  const body = bodyOf(workspacesSrc, 'async function reconcileRunAfterReparent');
  // A working structured session throws the mid-turn guard → dispatchRestartRequest
  // returns {ok:false}. Pre-#171 this only log.warn'd, leaving the live session on
  // the OLD run with no operator signal (the promote symptom). The else-branch must
  // now mark the workspace stale (deferred + CLI refusal) instead of only warning.
  const elseIdx = body.indexOf('} else {');
  assert.notEqual(elseIdx, -1, 'the restart-result else branch must exist');
  const elseBlock = body.slice(elseIdx);
  assert.ok(
    /markWorkspaceStaleRun\(ws, newAnchorId\)/.test(elseBlock),
    'a refused/failed restart must fall back to markWorkspaceStaleRun (not just log.warn)',
  );
  assert.ok(
    /markedStale\.push\(ws\.id\)/.test(elseBlock),
    'the fallback stale must be reported in markedStale',
  );
  // must-FAIL arm: the forceStale computation must gate on a LIVE pty (a cold or
  // structured session must NOT be force-deferred — it either restarts or is
  // notice-only).
  assert.ok(
    /const forceStale = opts\.preferStaleForLivePty === true && ptyLive/.test(body),
    'forceStale must require preferStaleForLivePty AND a live PTY specifically',
  );
});

test('#171 — the CLI promote verb reports the reconcile side effects', () => {
  const promoteCase = (() => {
    const i = cliSrc.indexOf("case 'promote': {");
    assert.notEqual(i, -1);
    const j = cliSrc.indexOf("case 'attach': {", i);
    return cliSrc.slice(i, j === -1 ? undefined : j);
  })();
  assert.ok(
    callsUncommented(promoteCase, 'reparentSuffix(res)'),
    'promote must render restarted/markedStale via reparentSuffix (same as attach/detach)',
  );
});

test('dispatchAdoptRepoRequest re-derives + reconciles at the new worktree path', () => {
  const body = bodyOf(workspacesSrc, 'export async function dispatchAdoptRepoRequest');
  assert.ok(
    body.includes('writeBusSwitchState(newWorktreePath'),
    'adopt must rewrite the notice at the NEW worktree path (the path moved)',
  );
  assert.ok(body.includes('reconcileRunAfterReparent('), 'adopt must call the reconcile');
});

test('reconcileRunAfterReparent restarts conversation-preserving (fresh:false)', () => {
  const body = bodyOf(workspacesSrc, 'async function reconcileRunAfterReparent');
  // The restart must be conversation-preserving (issue #111 restart, fresh:false),
  // and it must go through dispatchRestartRequest, not a fresh-clearing path.
  assert.ok(body.includes("import('./restart-workspace.ts')"), 'must use #111 restart');
  assert.ok(body.includes('fresh: false'), 'restart must preserve the conversation (fresh:false)');
  // must-FAIL arm: the notice must be rewritten for the NEW anchor BEFORE any
  // restart/mark, or a restarted session would re-read a stale notice.
  assert.ok(
    body.includes('writeBusSwitchState(ws.worktreePath, newAnchorId)'),
    'must rewrite the notice for the new anchor',
  );
  // must-FAIL arm: mark-stale must write the marker the CLI reads AND set the flag.
  // (#171 refactor: the marker+flag writes now live in the shared markWorkspaceStaleRun
  // helper, which reconcile calls from BOTH the mark-stale action and the refused-
  // restart fallback — assert reconcile calls it, and the helper does the writes.)
  assert.ok(
    callsUncommented(body, 'markWorkspaceStaleRun(ws, newAnchorId)'),
    'reconcile must mark-stale via the shared helper',
  );
  const helper = bodyOf(workspacesSrc, 'async function markWorkspaceStaleRun');
  assert.ok(helper.includes('staleRunMarkerBody('), 'mark-stale must write the CLI marker');
  assert.ok(helper.includes('busRunStale: true'), 'mark-stale must set the pane flag');
});

test('a manual restart clears the stale block ONLY on a SUCCESSFUL restart (F2)', () => {
  assert.ok(
    callsUncommented(restartSrc, 'clearBusRunStale('),
    'dispatchRestartRequest must clear the stale marker/flag on restart',
  );
  // REVIEW-142 F2: the clear must be GATED on the restart succeeding — clearing
  // before/regardless drops the marker while a failed relaunch leaves the old
  // session on the old run, unblocking sends into the stale run. The clear line
  // must carry the `res.ok` guard, and must come AFTER resolveRestart resolved.
  const clearLine = restartSrc
    .split('\n')
    .find((l) => l.includes('clearBusRunStale(') && !l.trimStart().startsWith('//'));
  assert.ok(clearLine, 'a real clearBusRunStale call line must exist');
  assert.ok(
    /res\.ok/.test(clearLine!),
    'the stale-clear must be gated on res.ok (a successful restart), not unconditional',
  );
  const resolveIdx = restartSrc.indexOf('resolveRestart({');
  const clearIdx = restartSrc.indexOf('res.ok) await clearBusRunStale');
  assert.ok(
    resolveIdx !== -1 && clearIdx !== -1 && resolveIdx < clearIdx,
    'the clear must run AFTER resolveRestart (so a thrown relaunch keeps the marker)',
  );
});

test('the CLI send REFUSES a stale-run workspace, and only send', () => {
  const sendCase = (() => {
    const i = cliSrc.indexOf("case 'send': {");
    assert.notEqual(i, -1);
    const j = cliSrc.indexOf("case 'check': {", i);
    return cliSrc.slice(i, j === -1 ? undefined : j);
  })();
  // REVIEW-142 F3: reject a COMMENTED-OUT call — `includes()` alone passes on
  // `// refuseIfStaleRun();`. Require a real, uncommented call line.
  assert.ok(
    callsUncommented(sendCase, 'refuseIfStaleRun()'),
    'send must actually CALL the stale-run guard (not a commented-out line)',
  );
  // must-FAIL arm: the guard reads the MARKER file, not the store (the CLI is
  // store-less) — a guard that tried the store would be a no-op in the CLI.
  assert.ok(
    cliSrc.includes('bus-run-stale'),
    'the guard must key on the .orchestra/bus-run-stale marker',
  );
  // The refusal must run BEFORE opening the bus (no bus handle for a refused send).
  const refuseIdx = sendCase.indexOf('refuseIfStaleRun()');
  const openIdx = sendCase.indexOf('openBusForVerb()');
  assert.ok(refuseIdx !== -1 && openIdx !== -1 && refuseIdx < openIdx,
    'refusal must precede openBusForVerb');
});
