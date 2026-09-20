// #134 — SOURCE-LEVEL guard for the seam wiring that lives in un-importable
// modules (workspaces.ts, index.ts, hooks-server.ts).
//
// HONEST LIMITATION (same as spawn-default-model.test.ts): `workspaces.ts`
// imports `./store`/`./platform`/the SDK chain and cannot be loaded under
// `node --test`, so the PRESENCE of the wiring is asserted against source text,
// not by calling `startAgentPty`. The behaviour of the pieces IS driven for
// real (bus-run-anchor.test.ts drives `maybeStartRunAtAnchor`; bus-wake-run-
// switch.test.ts drives the real accessor). What this file catches is the
// realistic regression this ticket exists to prevent: the wiring being deleted
// or reverted to the master state (no startRun call, no ORCHESTRA_RUN_ID,
// hardcoded 'default', unwired switch reader). Every assertion has a negative
// control so it cannot pass against an empty/wrong file.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const workspacesSrc = read('src/main/workspaces.ts');
const indexSrc = read('src/main/index.ts');
const hooksSrc = read('src/main/hooks-server.ts');
const agentSdkSrc = read('src/main/agent-sdk.ts');
const restartSrc = read('src/main/restart-workspace.ts');
const apiHandlersSrc = read('src/main/api-handlers.ts');

test('CONTROL: the four sources are readable and non-trivial', () => {
  assert.ok(workspacesSrc.length > 10_000, `workspaces.ts short: ${workspacesSrc.length}`);
  assert.ok(indexSrc.length > 10_000, `index.ts short: ${indexSrc.length}`);
  assert.ok(hooksSrc.length > 5_000, `hooks-server.ts short: ${hooksSrc.length}`);
  assert.ok(agentSdkSrc.length > 10_000, `agent-sdk.ts short: ${agentSdkSrc.length}`);
  assert.doesNotMatch(workspacesSrc, /zzzNoSuchPatternZzz/);
});

// ── EVERY LAUNCH PATH must reach the run row + notice (LEAD, post-G9) ──────────
// The G9 miss was that ONE path (structured default) was unwired. This block
// enumerates ALL launch paths and asserts each reaches the row+notice (and the
// structured path also plumbs ORCHESTRA_RUN_ID), so no single path can silently
// regress again. Source-grep (workspaces.ts/agent-sdk.ts are un-importable under
// node --test); the packaged G9 (VERIFY-F) is the authoritative end-to-end arm.

test('ALL-PATHS — the row+notice write lives at the common CREATION chokepoint (covers structured default)', () => {
  // The structured default spawn is dispatchSpawnRequest → createWorkspace →
  // startWorkspaceAgentHeadless → sdkStartAndDeliver. The row+notice come from
  // createWorkspace (the chokepoint); startWorkspaceAgentHeadless does NOT (and
  // must not need to) write them itself.
  assert.match(
    fnBody(workspacesSrc, 'export async function dispatchSpawnRequest('),
    /await createWorkspace\(/,
    'the CLI/structured spawn routes through createWorkspace (the chokepoint)',
  );
  const headless = fnBody(workspacesSrc, 'async function startWorkspaceAgentHeadless(');
  assert.match(headless, /sdkStartAndDeliver\(/, 'the structured default delivers via sdkStartAndDeliver');
  // createWorkspace is where the row+notice is written (asserted by the G9-FIX
  // test below); the headless path must not be the ONLY writer.
});

test('ALL-PATHS — the structured SDK session env plumbs ORCHESTRA_RUN_ID (parity with the PTY path)', () => {
  // The G9-class second half: the structured session builds its env in
  // agent-sdk.ts buildSdkEnv, NOT startAgentPty. Without ORCHESTRA_RUN_ID there,
  // the default agent's CLI verbs resolve 'default'/host-, not the wave run.
  const body = fnBody(agentSdkSrc, 'async function buildSdkEnv(');
  assert.match(
    body,
    /env\.ORCHESTRA_RUN_ID = resolveWaveRunId\(ws\)/,
    'the structured session env must carry the wave ORCHESTRA_RUN_ID (parity with startAgentPty extraEnv)',
  );
});

// ─── P1 — startRun is called at the anchor, in startAgentPty ─────────────────

/** The body of startAgentPty from its declaration to the `await startPty({`
 *  call — everything the seam wiring lives inside. */
function startAgentPtyBody(): string {
  const start = workspacesSrc.indexOf('export async function startAgentPty(');
  assert.ok(start > 0, 'startAgentPty not found');
  const end = workspacesSrc.indexOf('await startPty({', start);
  assert.ok(end > start, 'startPty call not found — startAgentPty shape changed');
  return workspacesSrc.slice(start, end);
}

/** The body of a named function, decl → the next `\nexport ` / `\nasync function`
 *  / `\nfunction ` at column 0 (good enough for these single-function slices). */
function fnBody(src: string, decl: string): string {
  const start = src.indexOf(decl);
  assert.ok(start > 0, `${decl} not found`);
  const after = src.slice(start + decl.length);
  const rel = after.search(/\n(export (async )?function|async function|function) /);
  return after.slice(0, rel > 0 ? rel : 4000);
}

// The G9 regression: the run-start + notice were wired ONLY into startAgentPty
// (the Raw-tab PTY path), but the DEFAULT spawn is
// dispatchSpawnRequest → startWorkspaceAgentHeadless → sdkStartAndDeliver, which
// never calls startAgentPty — so the feature was a NO-OP on the real AppImage.
// The fix wires it at the CREATION chokepoints. These guards assert THAT, each
// with a negative control; a build that reverts to startAgentPty-only reddens
// the two creation guards (the exact miss the original wiring test had).

test('G9 FIX — createWorkspace (the DEFAULT spawn chokepoint) starts the run + writes the notice, LOCAL-only (R3)', () => {
  const body = fnBody(workspacesSrc, 'export async function createWorkspace(');
  // review-F2 R3 / LEAD D3: the call is guarded behind `!remote` (parity with
  // startAgentPty) so a SANDBOX orchestrator makes no orphan HOST run row. The
  // regex requires the `if (!remote)` guard on the same statement — an unguarded
  // `await startBusRunAndWriteNotice(ws, remote)` (the R3 defect) reddens it.
  assert.match(
    body,
    /if \(!remote\) await startBusRunAndWriteNotice\(ws, remote\)/,
    'createWorkspace must start the run + notice for LOCAL spawns, guarded !remote (R3)',
  );
  // Negative control: the ORIGINAL G9 defect was the call living only in startAgentPty.
  assert.ok(
    body.includes('startBusRunAndWriteNotice'),
    'the default-path chokepoint is unwired — the G9 no-op regression',
  );
});

test('G9 FIX — createScratchLikeWorkspace (orchestrator/scratch spawn) starts the run + writes the notice', () => {
  const body = fnBody(workspacesSrc, 'async function createScratchLikeWorkspace(');
  assert.match(body, /await startBusRunAndWriteNotice\(ws\)/, 'a scratch orchestrator must get its row+notice at creation');
});

test('G9 FIX — startBusRunAndWriteNotice does BOTH the run-start and the notice write', () => {
  const body = fnBody(workspacesSrc, 'async function startBusRunAndWriteNotice(');
  assert.match(body, /maybeStartRunAtAnchor\(busRunAnchorDeps, anchor\)/, 'starts the run at the anchor');
  assert.match(body, /await writeBusSwitchState\(ws\.worktreePath, anchor\.anchorId\)/, 'writes the frozen notice');
});

test('P1 — startAgentPty also starts the run + notice (idempotent, upgrades pre-#134 workspaces)', () => {
  const body = startAgentPtyBody();
  assert.match(body, /const waveRunId = resolveAnchorInfo\(ws\)\.anchorId/, 'the wave run id is resolved for ORCHESTRA_RUN_ID');
  assert.match(body, /await startBusRunAndWriteNotice\(ws, remote\)/, 'startAgentPty re-affirms the run+notice');
});

test('P1 D1 — resolveWaveRunId uses nearestOrchestratorId, NOT walkToRootId (the tree-root defect)', () => {
  const start = workspacesSrc.indexOf('export function resolveWaveRunId(');
  assert.ok(start > 0, 'resolveWaveRunId not found');
  const body = workspacesSrc.slice(start, start + 400);
  assert.match(body, /nearestOrchestratorId\(ws,/, 'the run anchor must be the nearest orchestrator (D1)');
  // The exact overturned model: walkToRootId as the run anchor.
  assert.doesNotMatch(body, /return walkToRootId\(ws,/, 'resolveWaveRunId must NOT use the tree root (D1 overturned it)');
});

test('P1 D1 — /promote starts the run row (a promote does not relaunch the pty)', () => {
  const start = workspacesSrc.indexOf('export async function dispatchPromoteRequest(');
  assert.ok(start > 0, 'dispatchPromoteRequest not found');
  const end = workspacesSrc.indexOf('export interface DemoteResult', start);
  const body = workspacesSrc.slice(start, end > start ? end : start + 3000);
  // Both success branches (capability + kind swap) must start the run.
  const hits = (body.match(/startRunForPromoted\(updated\)/g) ?? []).length;
  assert.equal(hits, 2, 'both promote success branches must start the OPS run row');
});

// ─── P2a — ORCHESTRA_RUN_ID is plumbed into extraEnv = the wave run id ────────

test('P2a — ORCHESTRA_RUN_ID is set in startAgentPty extraEnv to waveRunId', () => {
  const body = startAgentPtyBody();
  assert.match(
    body,
    /ORCHESTRA_RUN_ID:\s*waveRunId/,
    'ORCHESTRA_RUN_ID must be plumbed (was only a comment on master)',
  );
});

// ─── P2b — the wake roster maps the real run id, not the hardcoded default ────

test('P2b — setWakeRoster maps runId to resolveWaveRunId(ws), not the string default', () => {
  const start = indexSrc.indexOf('setWakeRoster(');
  assert.ok(start > 0, 'setWakeRoster not found');
  const body = indexSrc.slice(start, start + 1400);
  assert.match(body, /runId:\s*resolveWaveRunId\(ws\)/, 'the roster must carry the wave run id');
  // The exact master defect: a hardcoded 'default' inside the roster mapper.
  assert.doesNotMatch(
    body,
    /runId:\s*'default'/,
    'the wake roster still hardcodes runId: \'default\' — the reproduced defect',
  );
});

// ─── P2b — the switch readers are WIRED (were () => false on master) ──────────

test('P2b — setWakeSwitchReader + setAskGateSwitchReader are wired to busSwitch', () => {
  assert.match(
    indexSrc,
    /setWakeSwitchReader\(\(runId\)\s*=>\s*\{[\s\S]*?busSwitch\(db,\s*runId,\s*'wake'\)/,
    'the wake switch reader must read the frozen flag off the run row',
  );
  assert.match(
    indexSrc,
    /setAskGateSwitchReader\(\(runId\)\s*=>\s*\{[\s\S]*?busSwitch\(db,\s*runId,\s*'ask_gate'\)/,
    'the askGate switch reader must be wired too',
  );
  // Negative control: a build that never wires them (the master state) has no
  // such call, so this file reddens on the reproduced defect.
  assert.ok(indexSrc.includes('setWakeSwitchReader('), 'wake reader wiring absent');
});

// ─── P4 — bus-status returns frozen + live flags for a CLI-supplied run id ────

test('P4 — /busStatus reads runFlags + getLiveSwitches for the CLI run id', () => {
  const start = hooksSrc.indexOf("route === '/busStatus'");
  assert.ok(start > 0, '/busStatus route not found');
  const body = hooksSrc.slice(start, start + 2400);
  assert.match(body, /runFlags\(db,\s*cliRunId\)/, 'frozen flags must come from the run row');
  assert.match(body, /getLiveSwitches\(\)/, 'live flags must come from the store');
  assert.match(body, /frozenFlags:/, 'the frozen flags must be returned');
  assert.match(body, /liveFlags:/, 'the live flags must be returned');
});

// ─── #166 — the coordinator-generation BUMP is wired at EVERY replacement path ─
// The bump GATE + primitive are driven for real in bus-fencing-wiring.test.ts.
// What THIS block catches is the #134-class regression: a replacement path whose
// bump call is deleted or never added, or the env var never plumbed. The modules
// are un-importable under node --test (./platform / ./store), so source-grep;
// every assertion has a negative control so it cannot pass on an empty/wrong file.

test('#166 — the bump effect calls the PURE gate then the real bump (no re-implementation)', () => {
  const body = fnBody(workspacesSrc, 'export function maybeBumpCoordinatorOnReplacement(');
  assert.match(body, /shouldBumpCoordinatorGeneration\(anchor, runRowExists\)/, 'gate decides the bump');
  assert.match(body, /bumpCoordinatorGeneration\(db, anchor\.anchorId\)/, 'the real primitive performs it');
  // Negative control: a build that dropped the effect has no such function body.
  assert.ok(body.length > 0 && body.includes('getBus()'), 'the effect must read the boot bus');
});

test('#166 — startAgentPty bumps ONLY on a coordinatorReplacement launch, before the env', () => {
  const body = startAgentPtyBody();
  // The bump is gated on the explicit replacement opt (a first open leaves it
  // false → no bump), and lives BEFORE the extraEnv object so the successor
  // presents the new generation.
  assert.match(
    body,
    /if \(!remote && opts\?\.coordinatorReplacement\) maybeBumpCoordinatorOnReplacement\(ws\)/,
    'startAgentPty bumps only on a coordinatorReplacement launch',
  );
  const bumpIdx = body.indexOf('maybeBumpCoordinatorOnReplacement');
  const envIdx = body.indexOf('ORCHESTRA_COORDINATOR_GENERATION');
  assert.ok(bumpIdx > 0 && envIdx > bumpIdx, 'the bump must precede the env read (successor presents the new gen)');
});

test('#166 — startAgentPty extraEnv plumbs ORCHESTRA_COORDINATOR_GENERATION from coordinatorGeneration', () => {
  const body = startAgentPtyBody();
  assert.match(body, /coordinatorGeneration\(db, waveRunId\)/, 'the generation is read from the run row');
  assert.match(
    body,
    /if \(gen > 0\) extraEnv\.ORCHESTRA_COORDINATOR_GENERATION = String\(gen\)/,
    'the var is set ONLY when bumped past 0 (absent/0 = unfenced v1, coexistence-safe)',
  );
});

test('#166 — buildSdkEnv (structured surface) plumbs ORCHESTRA_COORDINATOR_GENERATION too', () => {
  const body = fnBody(agentSdkSrc, 'async function buildSdkEnv(');
  assert.match(body, /coordinatorGeneration\(db, env\.ORCHESTRA_RUN_ID\)/, 'structured env reads the generation');
  assert.match(
    body,
    /if \(gen > 0\) env\.ORCHESTRA_COORDINATOR_GENERATION = String\(gen\)/,
    'parity with the PTY path — set only when bumped past 0',
  );
});

test('#166 — sdkRestart (structured restart) bumps on both branches, past the mid-turn guard', () => {
  const body = fnBody(agentSdkSrc, 'export async function sdkRestart(');
  // The bump helper is invoked (via the local closure) on BOTH the fresh and the
  // conversation-preserving branch. Crucially the NON-fresh bump fires AFTER the
  // mid-turn guard's throw, so a refused restart never bumps.
  assert.match(body, /maybeBumpCoordinatorOnReplacement\(restartingWs\)/, 'the bump closure calls the effect');
  // Two invocations of the closure (fresh branch + non-fresh branch).
  const calls = body.match(/bumpCoordinatorIfSelf\(\);/g) ?? [];
  assert.equal(calls.length, 2, 'the bump closure is called on both the fresh and non-fresh branches');
  const guardIdx = body.indexOf('The agent is working');
  assert.ok(guardIdx > 0, 'the mid-turn guard is present');
  // The LAST closure call (the non-fresh branch) must be after the guard.
  const lastCallIdx = body.lastIndexOf('bumpCoordinatorIfSelf();');
  assert.ok(lastCallIdx > guardIdx, 'the non-fresh bump fires AFTER the mid-turn guard (a refused restart never bumps)');
});

test('#166 — the two renderer-driven pty:restart routes mark a pending replacement', () => {
  // restartAgent (toolbar, live PTY) and switchWorkspaceBranch broadcast
  // pty:restart, which the renderer bounces to ptyStart — which then calls
  // startAgentPty. Without a main-side marker that respawn could not tell itself
  // from a first open (#134 under-wire). Both broadcasters must mark pending.
  // Anchor on the HANDLER forms (`… : async`) — the bare `restartAgent:` /
  // `ptyStart:` keys also appear in the channel-name map earlier in the file.
  const restartAgentStart = apiHandlersSrc.indexOf('restartAgent: async');
  assert.ok(restartAgentStart > 0, 'restartAgent handler not found');
  const restartAgentBody = apiHandlersSrc.slice(
    restartAgentStart,
    apiHandlersSrc.indexOf('stopAgent: async', restartAgentStart),
  );
  assert.match(restartAgentBody, /markPtyRestartPending\(id\)/, 'toolbar live-PTY restart marks pending');
  assert.match(restartAgentBody, /platform\.broadcast\('pty:restart', id\)/, 'and broadcasts pty:restart');

  const switchBody = fnBody(workspacesSrc, 'export async function switchWorkspaceBranch(');
  assert.match(switchBody, /markPtyRestartPending\(id\)/, 'branch switch marks pending');

  // ptyStart consumes the marker and passes it into startAgentPty.
  const ptyStartStart = apiHandlersSrc.indexOf('ptyStart: async');
  assert.ok(ptyStartStart > 0, 'ptyStart handler not found');
  const ptyStartBody = apiHandlersSrc.slice(
    ptyStartStart,
    apiHandlersSrc.indexOf('ptyWrite: async', ptyStartStart),
  );
  assert.match(ptyStartBody, /consumePtyRestartPending\(id\)/, 'ptyStart consumes the pending flag');
  assert.match(
    ptyStartBody,
    /startAgentPty\(ws, cols, rows, \{ coordinatorReplacement \}\)/,
    'and threads it into startAgentPty',
  );
});

test('#166 — the restartPty effect marks its startAgentPty a coordinatorReplacement', () => {
  assert.match(
    restartSrc,
    /coordinatorReplacement: true/,
    'the CLI/#142 restart PTY effect must flag the replacement',
  );
  // Negative control: the source actually contains the startAgentPty call it flags.
  assert.match(restartSrc, /await startAgentPty\(/, 'restart-workspace calls startAgentPty');
});
