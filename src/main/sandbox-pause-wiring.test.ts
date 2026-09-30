// #226 — WIRING pins for the sandbox pause. agent-sdk.ts / workspaces.ts cannot be imported under
// `node --test` (Electron + extensionless directory imports), so the DECISION is executed in
// src/shared/sandbox-pause.test.ts and the BEHAVIOUR is proven by the built-app arm `sandbox_paused`
// (scripts/e2e-agent-view-removal.mjs); this file pins WHERE the decision sits (funnel, wake, restart,
// fix-checks/send-review, bus-wake roster, headless spawn) and that no other agent-start site exists
// — a source pin, so it proves placement, never effect. The funnel's EFFECT is also driven by
// scripts/verify-answerable-wiring.mjs (`pnpm run test:wiring`).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (f: string) => fs.readFileSync(path.join(process.cwd(), 'src', 'main', f), 'utf8');
const AGENT_SDK = read('agent-sdk.ts');
const WORKSPACES = read('workspaces.ts');
const RESTART = read('restart-workspace.ts');
const API_HANDLERS = read('api-handlers.ts');
const INDEX = read('index.ts');
const STRUCTURED_VIEW = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'components', 'StructuredView.tsx'), 'utf8');
const BOOT_STALL = fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'components', 'BootStall.tsx'), 'utf8');

/** Body of a top-level function: from its signature to the next column-0 `}`. */
function body(src: string, signature: string): string {
  const at = src.indexOf(signature);
  assert.ok(at >= 0, `signature not found: ${signature}`);
  const end = src.indexOf('\n}\n', at);
  assert.ok(end > at, `no closing brace after: ${signature}`);
  return src.slice(at, end);
}
const before = (b: string, guard: string, later: string) => {
  const g = b.indexOf(guard), l = b.indexOf(later);
  assert.ok(g >= 0, `guard missing: ${guard}`);
  assert.ok(l >= 0, `anchor missing: ${later}`);
  assert.ok(g < l, `${guard} must come BEFORE ${later}`);
};

test('SDK funnel: ensureSessionInner refuses a paused sandbox workspace before ANY side effect', () => {
  const b = body(AGENT_SDK, 'async function ensureSessionInner(');
  assert.match(b, /const paused = sandboxPausedMessage\(ws\);\s*\n\s*if \(paused\) throw new Error\(paused\);/);
  // rewind-cut consumption, hibernation clear, env build (+ hook install) and the query() spawn all come after
  for (const later of ['rewindResumeAt.get(wsId)', 'clearHibernated(wsId)', 'installOrchestraHooks(', 'await buildSdkEnv(ws)', 'query({'])
    before(b, 'sandboxPausedMessage(ws)', later);
});

test('enumeration: exactly ONE agent-start query() (inside the funnel); the other is the tmpdir model probe', () => {
  const sites = [...AGENT_SDK.matchAll(/=\s*query\(\{/g)].map((m) => m.index!);
  assert.equal(sites.length, 2, 'a new query({ site is a new agent-start path — route it through ensureSession or add the pause');
  const inner = body(AGENT_SDK, 'async function ensureSessionInner(');
  const innerAt = AGENT_SDK.indexOf(inner);
  assert.ok(sites.some((s) => s > innerAt && s < innerAt + inner.length), 'a query({ must sit inside ensureSessionInner');
  const probe = body(AGENT_SDK, 'async function probeRuntimeModels(');
  const probeAt = AGENT_SDK.indexOf(probe);
  assert.ok(sites.some((s) => s > probeAt && s < probeAt + probe.length), 'the other query({ must be the model probe');
  assert.match(probe, /cwd: os\.tmpdir\(\)/, 'the probe never runs in a workspace directory');
  // ensureSessionInner has ONE caller (ensureSession) — no side door around the funnel
  assert.equal([...AGENT_SDK.matchAll(/ensureSessionInner\(/g)].length, 2, 'definition + the single ensureSession call');
});

test('wake: wakeAgentWithPrompt refuses a paused sandbox workspace before any wake branch', () => {
  const b = body(WORKSPACES, 'export async function wakeAgentWithPrompt(');
  assert.match(b, /const paused = sandboxPausedMessage\(ws\);\s*\n\s*if \(paused\) \{[\s\S]*?return false;\s*\n\s*\}/);
  for (const later of ['clearHibernated(id)', 'sdkDeliver(id, prompt)', 'sdkStartAndDeliver(id, prompt)'])
    before(b, 'sandboxPausedMessage(ws)', later);
  // #227 deleted the raw-PTY wake fallback: there is no `startPty` left in the wake for the guard to precede
  assert.doesNotMatch(b, /startPty\(/, 'the wake has no PTY fallback (#227)');
});

test('restart: dispatchRestartRequest refuses a paused sandbox workspace BEFORE the classifier (--fresh, legacy PTY route, recordRestart)', () => {
  const b = body(RESTART, 'export async function dispatchRestartRequest(');
  assert.match(b, /const paused = sandboxPausedMessage\(ws\);\s*\n\s*if \(paused\) return \{ ok: false, error: paused \};/);
  before(b, 'sandboxPausedMessage(ws)', 'await resolveRestart(');
  // #227: the owed-opening-task route (a kept child whose brief was never delivered) is a SECOND way to start an agent — the pause sits above it too
  before(b, 'sandboxPausedMessage(ws)', 'restartOwesOpeningTask(ws, live)');
  before(b, 'sandboxPausedMessage(ws)', 'retryOpeningTask(id!, fresh)');
});

test('fix-checks / send-review handlers THROW the pause before doing any work (never answer `requested` into nothing)', () => {
  const fix = API_HANDLERS.slice(API_HANDLERS.indexOf('fixChecks: async (id) =>'), API_HANDLERS.indexOf('getReviewDiff: async'));
  assert.ok(fix.length > 100, 'fixChecks handler not found');
  assert.match(fix, /const paused = sandboxPausedMessage\(ws\);\s*\n\s*if \(paused\) throw new Error\(paused\);/);
  before(fix, 'sandboxPausedMessage(ws)', 'findBranchChecks(');
  before(fix, 'sandboxPausedMessage(ws)', 'wakeAgentWithPrompt(');
  const rev = API_HANDLERS.slice(API_HANDLERS.indexOf('sendReviewToAgent: async (id, prompt) =>'), API_HANDLERS.indexOf('listTickets: async'));
  assert.ok(rev.length > 100, 'sendReviewToAgent handler not found');
  assert.match(rev, /const paused = sandboxPausedMessage\(ws\);\s*\n\s*if \(paused\) throw new Error\(paused\);/);
  before(rev, 'sandboxPausedMessage(ws)', 'wakeAgentWithPrompt(');
});

test('bus-wake: the roster marks a paused sandbox workspace NOT wakeable (else the sweep re-fires at a start that always refuses)', () => {
  const roster = INDEX.slice(INDEX.indexOf('setWakeRoster(() =>'), INDEX.indexOf('setWakeRoster(() =>') + 1500);
  assert.match(roster, /wakeable: !ws\.archived && !!ws\.worktreePath && sandboxPausedMessage\(ws\) === null && !startKeepsFailing\(ws, sdkSessionLive\(ws\.id\)\),/);
});

test('spawn / Restart retry: startWorkspaceAgentOnce answers the pause before the SDK start (unreachable today — no producer spawns a sandbox ws)', () => {
  const b = body(WORKSPACES, 'async function startWorkspaceAgentOnce(');
  assert.match(b, /const paused = sandboxPausedMessage\(ws\);\s*\n\s*if \(paused\) return \{ ok: false, error: paused \};/);
  before(b, 'sandboxPausedMessage(ws)', 'sdkStartAndDeliverResult(id, ws.lastTask, ');
  assert.doesNotMatch(b, /startPty\(/, 'the spawn start has no PTY fallback (#227)');
});

test('toolbar Restart: restartAgent THROWS the pause on a paused ws (never a silent resolve) and its renderer callers tolerate the rejection', () => {
  const h = API_HANDLERS.slice(API_HANDLERS.indexOf('restartAgent: async (id) =>'), API_HANDLERS.indexOf('stopAgent: async'));
  assert.ok(h.length > 200, 'restartAgent handler not found');
  assert.match(h, /const paused = sandboxPausedMessage\(store\.getWorkspace\(id\)\);\s*\n\s*if \(!res\.ok && paused\) throw new Error\(paused\);/);
  before(h, 'await dispatchRestartRequest(', 'sandboxPausedMessage(store.getWorkspace(id))');
  // both BootStall callers catch (App.tsx already try/catches into dialog.error)
  assert.equal([...BOOT_STALL.matchAll(/\.catch\(\(e\) => console\.error\('restartAgent failed', e\)\)/g)].length, 2, 'both BootStall restartAgent callers must tolerate a rejection');
});

test('sdkClear (UI /clear + `restart --fresh`): a paused ws keeps its session id — the guard is the first statement', () => {
  const b = body(AGENT_SDK, 'export async function sdkClear(');
  assert.match(b, /const paused = sandboxPausedMessage\(store\.getWorkspace\(wsId\)\);\s*\n\s*if \(paused\) throw new Error\(paused\);/);
  before(b, 'sandboxPausedMessage(', 'sessions.get(wsId)');
  before(b, 'sandboxPausedMessage(', "persistWorkspacePatch(wsId, { sdkSessionId: '' })");
});

test('composer: a REFUSED send (rejected agentSdkSend) restores the typed text + images into an EMPTY composer, never over new input', () => {
  const at = STRUCTURED_VIEW.indexOf('const sentText = text;');
  assert.ok(at > 0, 'send capture not found');
  const blk = STRUCTURED_VIEW.slice(at, at + 900);
  assert.match(blk, /\.agentSdkSend\(workspaceId, t, images\)\s*\n\s*\.catch\(\(e\) => \{/);
  assert.match(blk, /setText\(\(cur\) => \(cur === '' \? sentText : cur\)\);/);
  assert.match(blk, /setPendingImages\(\(cur\) => \(cur\.length === 0 \? sentImages : cur\)\);/);
  // the optimistic clear still happens AFTER the send is issued (the restore is a rejection handler, not a skipped clear)
  assert.ok(STRUCTURED_VIEW.indexOf("setText('');", at) > at, "the optimistic setText('') must follow the send");
});
