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

test('NOT in this track: no wake / prompt / recovery / Veille path consults Admission (réveil under low memory = #287)', () => {
  const importers = fs
    .readdirSync(path.join(root, 'src/main'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => /from '\.\/admission(\.ts)?'/.test(read(`src/main/${f}`)))
    .sort();
  // Tripwire BY DESIGN: #287 (bus-wake) / #288 (Veille) add their importer HERE.
  assert.deepEqual(importers, ['hooks-server.ts', 'index.ts', 'restart-workspace.ts', 'workspaces.ts']);
});
