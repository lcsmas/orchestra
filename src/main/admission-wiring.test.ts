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
  assert.match(ws, /heldForMemory\?: \{ kind: HeldStartKind; since: number \}/);
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
  assert.match(ws, /import \{ admissionGate, dropHeldStart, dropWakeSite, heldStartFor, type HeldStartKind \} from '\.\/admission\.ts';/);
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

test('who imports Admission: the #286 start gates + the #287 wake path + the READ-ONLY #289 alert/banner; Veille (#288) is not here yet', () => {
  const importers = (re: RegExp): string[] =>
    fs
      .readdirSync(path.join(root, 'src/main'))
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => re.test(read(`src/main/${f}`)))
      .sort();
  // Tripwires BY DESIGN: #288 (Veille) adds its importer HERE.
  // #289's alert and banner READ the held-start count (`listHeldStarts().length`) for what they tell the LEAD / the human — they never gate or release a start.
  assert.deepEqual(importers(/from '\.\/admission(\.ts)?'/), ['admission-wake.ts', 'bus-wake.ts', 'hooks-server.ts', 'index.ts', 'memory-alert-host.ts', 'memory-banner-host.ts', 'restart-workspace.ts', 'workspaces.ts']);
  assert.deepEqual(importers(/from '\.\/admission-wake'/), ['api-handlers.ts', 'index.ts', 'prompt-queue.ts', 'workspaces.ts']);
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
  assert.match(body.slice(hold - 1000, hold), /if \(action\.kind === 'fire' && entry\?\.fleetMember === true\) \{/);
  assert.match(body.slice(hold - 700, hold), /const now = rosterEntryOf\(reader\) \?\? entry;/, 'the reader is RE-READ right before the decision (the snapshot is from the sweep start)');
  assert.match(body.slice(hold - 140, hold), /if \(now\.fleetMember === true && now\.sleeping === true && !resident\) \{/);
  assert.match(body.slice(hold - 520, hold), /const resident = now\.fleetMember === true && now\.sleeping === true && wakeWouldBeHeld\(\) && \(await readKeeperResident\(reader\)\.catch\(\(\) => false\)\);/, 'F1: a keeper-resident member is probed (only when the wake would be held) and never held');
  assert.match(branch, /site: 'sweep',/);
  assert.match(branch, /retry: \(\) => sweepBusWakeNow\(\),/);
  assert.match(branch, /const r = rosterEntryOf\(reader\);\s*\n\s*return !!r && r\.wakeable && r\.sleeping === true;/, 'stillOwed checks THIS reader only, never the whole roster');
  assert.doesNotMatch(branch, /readRoster\(\)/);
  assert.match(branch, /logWakeableTransition\(reader, 'held-for-memory'\);\s*\n\s*continue;/);
  assert.doesNotMatch(branch, /counters\.|ledger\./, 'a held réveil touches no counter and no ledger mark');
  assert.match(wake, /export async function sweepBusWakeNow\(\): Promise<void> \{\s*\n\s*for \(let i = 0; sweeping && i < 200; i\+\+\) await new Promise\(\(r\) => setTimeout\(r, 25\)\);\s*\n\s*await sweepBusWake\(\);\s*\n\}/, 'F2: the release sweep WAITS for an in-flight sweep, then sweeps (a no-op here leaves every held réveil undelivered)');
});

test('#287 roster: fleetMember / sleeping / coordinator come from the real probes', () => {
  assert.match(roster, /fleetMember: !!ws\.parentId,/);
  assert.match(roster, /sleeping: !isRunning\(ws\.id\) && !sdkSessionLive\(ws\.id\),/);
  assert.match(roster, /coordinator: canOrchestrate\(ws\),/);
  assert.match(index, /setWakeRosterEntry\(\(id\) => \{\s*\n\s*const w = store\.getWorkspace\(id\);\s*\n\s*return w \? wakeRosterEntry\(w\) : null;/, 'the per-reader roster seam is wired (Admission re-checks one reader, not the whole roster)');
});

test('#287 admission-wake: "sleeping" = no PTY AND no live SDK session; a fleet member = has a parent; the default stillOwed re-checks both at release time', () => {
  const aw = read('src/main/admission-wake.ts');
  assert.match(aw, /return !isRunning\(id\) && !sdkSessionLive\(id\);/);
  assert.match(aw, /fleetMember: !!ws\.parentId,/);
  assert.match(aw, /sleeping: isSleeping\(id\),/);
  assert.match(aw, /coordinator: canOrchestrate\(ws\),/, 'coordinators first holds for EVERY wake site (flush / resume / message / recovery all go through this wrapper), not only the sweep');
  assert.match(aw, /setAdmissionWakeSettle\(\(id\) => sdkAwaitFirstTurn\(id, ADMISSION_WAKE_SETTLE_MS\)\);/, 'a wake release waits for the started member\'s first turn (the next reading includes its memory)');
  assert.match(aw, /return !!w && !w\.archived && isSleeping\(id\);/);
});

test('#287 prompt-queue: the TIMER flush holds BEFORE the queue is cleared (Send now passes); the usage-limit nudge holds BEFORE the budget, the marker clear and the re-mark', () => {
  const flush = fn(pq, 'export async function flushQueuedPrompts(');
  const hold = flush.indexOf('wakeHeldForMemory(ws, () => flushQueuedPrompts(id), {');
  const clear = flush.indexOf('const cleared: Workspace = { ...ws, queuedPrompts: [] };');
  const usage = flush.indexOf("'account still at its usage limit'");
  assert.ok(usage > 0 && hold > usage && clear > hold, 'usage check → hold → clear');
  assert.match(flush.slice(hold - 70, hold), /!opts\.force &&\s*\n\s*\(await $/, 'the TIMER flush only: Send now (force) is a human click and passes');
  assert.match(flush.slice(hold, hold + 140), /site: 'flush',/);
  const resume = fn(pq, 'async function resumeUsageLimited(now: number, only?: string): Promise<void> {');
  const rh = resume.indexOf("action === 'nudge' &&");
  assert.ok(rh > resume.indexOf("if (action === 'wait') continue;") && rh < resume.indexOf('budget--;') && rh < resume.indexOf('await clearStopReason(ws.id).catch(() => {});\n    let woke'), 'wait → hold → budget → clear');
  assert.match(resume.slice(rh, rh + 200), /wakeHeldForMemory\(ws, \(\) => resumeUsageLimited\(Date\.now\(\), ws\.id\), \{\s*\n\s*site: 'resume',/, 'the release re-runs THIS member only (no 2nd per-tick budget)');
  assert.match(resume, /if \(only === undefined\) await evaluatePausedRuns\(\);/);
  // the per-site "still wanted at release time" clauses (verifier seat 2: E61/E64): the flush needs PARKED PROMPTS, the resume needs the usage_limit MARKER, both need the member still asleep
  assert.match(flush, /return !!w && !w\.archived && \(w\.queuedPrompts \?\? \[\]\)\.length > 0 && isSleeping\(id\);/);
  assert.match(resume, /return !!w && !w\.archived && w\.lastStopReason === 'usage_limit' && isSleeping\(ws\.id\);/);
  assert.match(resume, /\(only === undefined \|\| ws\.id === only\)/);
});

test('#287 peer message: a stopped fleet target is parked in the inbox (honest `inbox`) and woken by the queue; a failed park drops the hold', () => {
  const from = ws.indexOf('export async function dispatchMessageRequest(');
  const body = ws.slice(from, ws.indexOf('export interface BroadcastTargetResult', from));
  const hold = body.indexOf("if (await wakeHeldForMemory(target, () => wakeHeldMessageTarget(input.to), { site: 'message', reenters: false })) {");
  const wakeTry = body.indexOf('if (await wakeAgentWithPrompt(input.to, body)) {');
  assert.ok(hold > 0 && wakeTry > hold, 'hold before the wake attempt');
  assert.match(body.slice(hold, wakeTry), /if \(await queueInbox\(input\.to, body\)\) return \{ ok: true, delivery: 'inbox', branch: target\.branch \};\s*\n\s*dropWakeSite\(input\.to, 'message'\);/, 'a failed park withdraws THIS site only — never a held spawn / restart of the member');
  assert.doesNotMatch(body.slice(hold, wakeTry), /dropHeldStart/);
  assert.doesNotMatch(ws, /releaseAllInboxBlocks|HELD_MESSAGE_DRAIN_GRACE_MS/, 'no re-release of the parked block: the inbox hook drains it, a 2nd delivery would duplicate it');
});

test('#287 recovery: the VIEW-OPEN recovery holds when it would resend pending prompts to a sleeping fleet member; the recycle/restart callers are NOT gated (they replace a running session — net 0)', () => {
  assert.match(api, /if \(w && \(w\.sdkPendingPrompts \?\? \[\]\)\.length > 0 && \(await wakeHeldForMemory\(w, recoverNow, \{ site: 'recovery', reenters: false \}\)\)\) return;/);
  const sdk = read('src/main/agent-sdk.ts');
  assert.doesNotMatch(sdk, /admission/i, 'agent-sdk.ts (the B5 / D1.6 serialized seam) is untouched');
  assert.doesNotMatch(read('src/main/session-watchdog.ts'), /admission/i);
});

test('#287 F2/F3: the peer-message bring-up wakes ONLY a still-sleeping member (an earlier site\'s release may have started it); both release bodies are pinned', () => {
  const m = /async function wakeHeldMessageTarget\(id: string\): Promise<void> \{\s*\n\s*if \(!isSleeping\(id\)\) return;[^\n]*\n\s*await wakeAgentWithPrompt\(id, HELD_MESSAGE_WAKE_PROMPT\);\s*\n\}/;
  assert.match(ws, m);
});

test('#287 F1: keeper-resident = the CLI is ALIVE in a detached keeper, has run a turn and is not shutting down (its wake only reattaches); probed only when the wake would be held; the sweep seam is wired', () => {
  const aw = read('src/main/admission-wake.ts');
  assert.match(aw, /return !!probe\?\.running && probe\.everStarted !== false && probe\.shuttingDown !== true;/);
  assert.match(aw, /if \(wakeWouldBeHeld\(\) && \(await keeperResident\(id\)\)\) return false;/);
  assert.match(index, /setWakeKeeperResident\(keeperResident\);/);
});

test('#287 F2: the wake rigs are package.json scripts (the 5 site integrations are not gated by regex pins alone)', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  assert.match(pkg.scripts['test:admission-wake'] ?? '', /scripts\/\.r2-register\.mjs scripts\/e2e-admission-wake\.mjs/);
  assert.match(pkg.scripts['test:admission-hold'] ?? '', /scripts\/\.r2-register\.mjs scripts\/e2e-admission-hold\.mjs/);
  assert.match(pkg.scripts['test:admission-mutants'] ?? '', /scripts\/admission-mutants\.mjs/);
});
