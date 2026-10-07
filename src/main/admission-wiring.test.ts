import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// workspaces.ts / restart-workspace.ts / hooks-server.ts / index.ts cannot be imported under `node --test` (Electron host), so the WIRING of Admission
// (#286) is asserted on source text. The behaviour behind each seam is driven for real by src/main/admission.test.ts and scripts/e2e-admission-hold.mjs.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const ws = read('src/main/workspaces.ts');
const restart = read('src/main/restart-workspace.ts');
const hooks = read('src/main/hooks-server.ts');
const index = read('src/main/index.ts');
const cli = read('src/cli/index.ts');

/** The text of one function body: from its signature to the next top-level closing brace. */
function fn(src: string, signature: string): string {
  const i = src.indexOf(signature);
  assert.ok(i >= 0, `signature not found: ${signature}`);
  const rest = src.slice(i);
  return rest.slice(0, rest.indexOf('\n}\n') + 3);
}

test('CONTROL: the sources are the real files', () => {
  assert.match(ws, /async function startWorkspaceAgentOnce\(/);
  assert.match(restart, /export async function dispatchRestartRequest\(/);
});

test('spawn gate: inside startWorkspaceAgentOnce, AFTER the owed check and BEFORE the start, automatic by default, release bypasses it', () => {
  const body = fn(ws, 'async function startWorkspaceAgentOnce(');
  const owed = body.indexOf('if (!ws.lastTask || !owesOpeningTask(ws)) return { ok: true };');
  const gate = body.indexOf('admissionGate({');
  const start = body.indexOf('await sdkStartAndDeliverResult(');
  assert.ok(owed > 0 && gate > owed && start > gate, 'owed check → gate → start');
  assert.match(body, /if \(!admitted\) \{/);
  assert.match(body, /origin: origin \?\? 'auto',\s*\n\s*kind: 'spawn',/);
  assert.match(body, /run: \(\) => startWorkspaceAgentHeadless\(id, 'auto', true\),/);
  assert.match(body, /if \(gate\.held\) return \{ ok: true, held: \{ since: gate\.since \}, note: heldPhrase\('spawn', gate\.since\) \};/);
  assert.match(ws, /startWorkspaceAgentHeadless\(id: string, origin\?: PauseOrigin, admitted = false\)/);
});

test('spawn stillOwed: owed AND no live SDK session AND no running PTY AND not archived (the PTY half cannot be driven by the rig — it is pinned on text)', () => {
  const body = fn(ws, 'async function startWorkspaceAgentOnce(');
  assert.match(body, /return !!w && !w\.archived && owesOpeningTask\(w\) && !sdkSessionLive\(id\) && !isRunning\(id\);/);
});

test('spawn reply carries held; peers carry heldForMemory', () => {
  assert.match(ws, /\.\.\.\(started\.held \? \{ held: started\.held \} : \{\}\)/);
  assert.match(ws, /heldForMemory\?: \{ kind: 'spawn' \| 'restart'; since: number \}/);
  assert.match(ws, /\.\.\.\(heldStartFor\(w\.id\) \? \{ heldForMemory:/);
});

test('restart gate: after the Pause refusal, BEFORE the classifier / any stop; the toolbar is human; the release (`admitted`) is not re-held, nor by the owed route', () => {
  const body = fn(restart, 'export async function dispatchRestartRequest(');
  const paused = body.indexOf('if (pausedRun) return { ok: false, error: pausedRun };');
  const gate = body.indexOf('admissionGate({');
  const resolve = body.indexOf('resolveRestart({');
  assert.ok(paused > 0 && gate > paused && resolve > gate, 'pause refusal → admission gate → resolveRestart');
  assert.match(body, /if \(!input\.admitted && id && ws\) \{/);
  assert.match(body, /origin: restartOrigin,\s*\n\s*kind: 'restart',/);
  assert.match(body, /run: \(\) => dispatchRestartRequest\(\{ id, fresh, trigger, admitted: true \}\),/);
  assert.match(body, /retryOpeningTask\(id!, fresh, restartOrigin, input\.admitted === true\)/);
  assert.match(restart, /const started = await startWorkspaceAgentHeadless\(id, origin, admitted\);/);
  assert.match(body, /const restartOrigin: PauseOrigin = trigger === 'toolbar' \? 'human' : 'auto';/);
});

test('reparent reconcile: a HELD restart (ok:true) is NOT "restarted" — the member is marked stale until the released restart clears it', () => {
  const body = fn(ws, 'async function reconcileRunAfterReparent(');
  const heldArm = body.indexOf('if (res.ok && res.held) {');
  const okArm = body.indexOf('} else if (res.ok) {');
  assert.ok(heldArm > 0 && okArm > heldArm, 'the held arm comes before the plain ok arm');
  assert.match(body.slice(heldArm, okArm), /markWorkspaceStaleRun\(ws, newAnchorId\);\s*\n\s*markedStale\.push\(ws\.id\);/);
  assert.doesNotMatch(body.slice(heldArm, okArm), /restarted\.push/);
});

test('a release refused by a fleet Pause keeps its slot: both gates pass retryLater (the Pause is still in force)', () => {
  assert.match(ws, /retryLater: \(\) => pauseRefusal\(store\.getWorkspace\(id\), 'auto'\) !== null,/);
  assert.match(restart, /retryLater: \(\) => pauseRefusal\(store\.getWorkspace\(id\) \?\? null, restartOrigin\) !== null,/);
});

test('F3 liveness: index.ts silences a member with a held start (the same predicate slot the Pause uses) — pinned beside the behaviour test admission-liveness.test.ts', () => {
  assert.match(index, /setLivenessRoster\(buildLivenessRoster\(store, resolveWaveRunId, \(ws\) => pauseRefusal\(ws, 'auto'\) !== null \|\| livenessSilencedByAdmission\(ws\.id\)\)\);/);
  assert.match(index, /import \{ livenessSilencedByAdmission, startAdmission, stopAdmission \} from '\.\/admission';/);
});

test('F4 delete: teardownWorkspace (single AND bulk delete) drops the held start FIRST', () => {
  const body = fn(ws, 'async function teardownWorkspace(ws: Workspace)');
  assert.ok(body.indexOf('dropHeldStart(id);') > 0 && body.indexOf('dropHeldStart(id);') < body.indexOf('await stopStructuredSession(id);'), 'dropped before anything slow runs');
  assert.match(ws, /import \{ admissionGate, dropHeldStart, heldStartFor \} from '\.\/admission\.ts';/);
});

test('F4 report: a failed release tells the coordinator — a bus `escalation` from the member to its live parent, behind the `liveness` switch like the boot-wedge escalation; both gates pass `report`', () => {
  const body = fn(ws, 'export function reportAdmissionFailure(');
  assert.match(body, /busSwitch\(db, runId, 'liveness'\)/);
  assert.match(body, /decideAdmissionReport\(\{ hasMember: !!ws, coordinatorLive: !!parent && !parent\.archived, hasBus: !!db, switchOn: on \}\)/);
  assert.match(body, /kind: 'escalation', body: text \}\);/);
  assert.match(ws, /report: \(text\) => reportAdmissionFailure\(id, text\),/);
  assert.match(restart, /report: \(text\) => reportAdmissionFailure\(id, text\),/);
});

test('F4 composer: the held restart is dropped when a member that was STOPPED at hold time has been started by a person (liveAtHold)', () => {
  const body = fn(restart, 'export async function dispatchRestartRequest(');
  assert.match(body, /const liveAtHold = isRunning\(id\) \|\| sdkSessionLive\(id\);/);
  assert.match(body, /return !!w && !w\.archived && \(liveAtHold \|\| !\(isRunning\(id\) \|\| sdkSessionLive\(id\)\)\);/);
});

test('F1 the restart reply carries its note and the CLI prints it through the shared formatter; F3 /busStatus labels through heldStartLabel', () => {
  const body = fn(restart, 'export async function dispatchRestartRequest(');
  assert.match(body, /if \(gate\.held\) return \{ ok: true, held: \{ since: gate\.since \}, note: heldPhrase\('restart', gate\.since\) \};/);
  assert.match(cli, /if \(res\.held && typeof res\.note === 'string'\) \{\s*\n[^\n]*\n\s*process\.stdout\.write\(`\$\{formatRestartHeldReply\(target, res\.note\)\}\\n`\);/);
  assert.match(hooks, /label: heldStartLabel\(w, h\.wsId\),/);
});

test('/busStatus lists the held starts and the CLI prints them (no line when none); the CLI marks a held peer and a held restart', () => {
  assert.match(hooks, /heldStarts: listHeldStarts\(\)\.map\(/);
  assert.match(cli, /formatHeldStartsLine\(res\.heldStarts as HeldStartView\[\]\)/);
  assert.match(cli, /p\.heldForMemory \? `\$\{p\.status\} · \$\{p\.heldForMemory\.kind\} HELD for memory since/);
  assert.match(cli, /if \(res\.held && typeof res\.note === 'string'\) \{/);
});

test('lifecycle: admission starts right after the guard and stops before it', () => {
  const start = index.indexOf('startAdmission();');
  assert.ok(start > index.indexOf('startMemoryGuard();'), 'startAdmission after startMemoryGuard');
  const body = index.slice(index.indexOf('function shutdownSubsystems(): void {'));
  const shutdown = body.slice(0, body.indexOf('\n}\n'));
  assert.ok(shutdown.indexOf('stopAdmission();') > 0 && shutdown.indexOf('stopAdmission();') < shutdown.indexOf('stopMemoryGuard();'), 'stopped inside shutdownSubsystems, before the guard');
});

test('startAdmission follows FI-2 item 5: SUBSCRIBE first, then reconcile (a boot kick) — and the no-replay wording says so', () => {
  const adm = read('src/main/admission.ts');
  const body = adm.slice(adm.indexOf('export function startAdmission(): void {'));
  const fnBody = body.slice(0, body.indexOf('\n}\n'));
  assert.ok(fnBody.indexOf('subscribeMemoryGuard(') > 0 && fnBody.indexOf('subscribeMemoryGuard(') < fnBody.indexOf('void singleton.kick(); // the reconcile'), 'subscribe, THEN the reconcile kick');
  assert.match(read('src/main/memory-guard.ts'), /must SUBSCRIBE FIRST, then read `getMemoryGuardSnapshot\(\)` and reconcile — never\n\/\/ snapshot-then-subscribe/);
  assert.match(read('docs/codebase-map/resources.md'), /a late subscriber SUBSCRIBES FIRST, then reconciles/);
});

test('who imports Admission: the #286 start gates + the #287 wake path; Veille (#288) and the alert (#289) are not here yet', () => {
  const importers = (re: RegExp): string[] =>
    fs
      .readdirSync(path.join(root, 'src/main'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => re.test(read(`src/main/${f}`)))
      .sort();
  // Tripwires BY DESIGN: #288 (Veille) / #289 (alert) add their importer HERE.
  assert.deepEqual(importers(/from '\.\/admission(\.ts)?'/), ['admission-wake.ts', 'bus-wake.ts', 'hooks-server.ts', 'index.ts', 'restart-workspace.ts', 'workspaces.ts']);
  assert.deepEqual(importers(/from '\.\/admission-wake'/), ['api-handlers.ts', 'prompt-queue.ts', 'workspaces.ts']);
});

// ─── #287: the wake sites (each: the hold sits BEFORE anything is started or cleared, durable state untouched) ───────────────────────

const wake = read('src/main/bus-wake.ts');
const roster = read('src/main/wake-roster.ts');
const pq = read('src/main/prompt-queue.ts');
const api = read('src/main/api-handlers.ts');

test('#287 bus-wake: the hold branch follows decideWake\'s skip handling, precedes the ledger mark and every counter; `continue`s on held; the release re-runs a GUARANTEED sweep', () => {
  const body = fn(wake, 'export async function sweepBusWake(): Promise<void> {');
  const skip = body.indexOf("if (action.kind === 'skip') {");
  const hold = body.indexOf('const held = holdWake({');
  const active = body.indexOf("logWakeableTransition(action.reader, 'active');");
  const mark = body.indexOf('ledger.set(action.reader, ledgerEntry);');
  assert.ok(skip > 0 && hold > skip && active > hold && mark > active, 'skip handling → hold → active transition → ledger mark');
  const branch = body.slice(hold, active);
  assert.match(body.slice(hold - 260, hold), /if \(action\.kind === 'fire' && entry\?\.fleetMember === true && entry\.sleeping === true\) \{/);
  assert.match(branch, /retry: \(\) => sweepBusWakeNow\(\),/);
  assert.match(branch, /logWakeableTransition\(reader, 'held-for-memory'\);\s*\n\s*continue;/);
  assert.doesNotMatch(branch, /counters\.|ledger\./, 'a held réveil touches no counter and no ledger mark');
  assert.match(wake, /export async function sweepBusWakeNow\(\): Promise<void> \{\s*\n\s*for \(let i = 0; sweeping && i < 200; i\+\+\)/);
});

test('#287 roster: fleetMember / sleeping / coordinator come from the real probes', () => {
  assert.match(roster, /fleetMember: !!ws\.parentId,/);
  assert.match(roster, /sleeping: !isRunning\(ws\.id\) && !sdkSessionLive\(ws\.id\),/);
  assert.match(roster, /coordinator: canOrchestrate\(ws\),/);
});

test('#287 prompt-queue: the TIMER flush holds BEFORE the queue is cleared (Send now passes); the usage-limit nudge holds BEFORE the budget, the marker clear and the re-mark', () => {
  const flush = fn(pq, 'export async function flushQueuedPrompts(');
  const hold = flush.indexOf('wakeHeldForMemory(ws, () => flushQueuedPrompts(id), {');
  const clear = flush.indexOf('const cleared: Workspace = { ...ws, queuedPrompts: [] };');
  const usage = flush.indexOf("'account still at its usage limit'");
  assert.ok(usage > 0 && hold > usage && clear > hold, 'usage check → hold → clear');
  assert.match(flush.slice(hold - 60, hold), /!opts\.force &&\s*\n\s*$/, 'the TIMER flush only: Send now (force) is a human click and passes');
  const resume = fn(pq, 'async function resumeUsageLimited(now: number): Promise<void> {');
  const rh = resume.indexOf("action === 'nudge' &&");
  assert.ok(rh > resume.indexOf("if (action === 'wait') continue;") && rh < resume.indexOf('budget--;') && rh < resume.indexOf('await clearStopReason(ws.id).catch(() => {});\n    let woke'), 'wait → hold → budget → clear');
  assert.match(resume.slice(rh, rh + 160), /wakeHeldForMemory\(ws, \(\) => resumeUsageLimited\(Date\.now\(\)\), \{/);
});

test('#287 peer message: a stopped fleet target is parked in the inbox (honest `inbox`) and woken by the queue; a failed park drops the hold', () => {
  const from = ws.indexOf('export async function dispatchMessageRequest(');
  const body = ws.slice(from, ws.indexOf('export interface BroadcastTargetResult', from));
  const hold = body.indexOf('if (wakeHeldForMemory(target, () => wakeHeldMessageTarget(input.to))) {');
  const wakeTry = body.indexOf('if (await wakeAgentWithPrompt(input.to, body)) {');
  assert.ok(hold > 0 && wakeTry > hold, 'hold before the wake attempt');
  assert.match(body.slice(hold, wakeTry), /if \(await queueInbox\(input\.to, body\)\) return \{ ok: true, delivery: 'inbox', branch: target\.branch \};\s*\n\s*dropHeldStart\(input\.to\);/);
  assert.match(ws, /await new Promise\(\(r\) => setTimeout\(r, HELD_MESSAGE_DRAIN_GRACE_MS\)\);[^\n]*\n\s*await releaseAllInboxBlocks\(id, 'auto'\)/);
});

test('#287 recovery: the VIEW-OPEN recovery holds when it would resend pending prompts to a sleeping fleet member; the recycle/restart callers are NOT gated (they replace a running session — net 0)', () => {
  assert.match(api, /if \(w && \(w\.sdkPendingPrompts \?\? \[\]\)\.length > 0 && wakeHeldForMemory\(w, recoverNow\)\) return;/);
  const sdk = read('src/main/agent-sdk.ts');
  assert.doesNotMatch(sdk, /admission/i, 'agent-sdk.ts (the B5 / D1.6 serialized seam) is untouched');
  assert.doesNotMatch(read('src/main/session-watchdog.ts'), /admission/i);
});
