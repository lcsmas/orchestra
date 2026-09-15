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

test('G9 FIX — createWorkspace (the DEFAULT spawn chokepoint) starts the run + writes the notice', () => {
  const body = fnBody(workspacesSrc, 'export async function createWorkspace(');
  assert.match(
    body,
    /await startBusRunAndWriteNotice\(ws, remote\)/,
    'createWorkspace must start the run + notice — the default structured spawn never calls startAgentPty',
  );
  // Negative control: the ORIGINAL defect was the call living only in startAgentPty.
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
