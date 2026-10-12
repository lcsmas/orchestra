// #232 (wave "Agent view only", #219) — source pins: wake, messages, the prompt queue, review/fix-checks, account
// migration, peers, the branch switch, hibernation and the restart dispatcher reason about SDK sessions ONLY.
// These files import Electron and cannot load under `node --test`, so each pin reads the shipped source.
// The BEHAVIOUR is proven in the built app by scripts/e2e-agent-view-removal.mjs arms `sdk_only_*`
// (a stray agent PTY is ignored by every one of these seams); an absence pin alone passes whether or not the
// behaviour changed, so every pin below names the surviving control it must not break.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string) => fs.readFileSync(path.join(here, f), 'utf8');
const ws = read('workspaces.ts');
const api = read('api-handlers.ts');
const hib = read('hibernation.ts');
const pq = read('prompt-queue.ts');
const rw = read('restart-workspace.ts');
const cli = fs.readFileSync(path.join(here, '..', 'cli', 'index.ts'), 'utf8');

/** From `decl` to the next column-0 `function` / `export` declaration. */
function body(src: string, decl: string): string {
  const at = src.indexOf(decl);
  assert.notEqual(at, -1, `declaration not found: ${decl}`);
  const rest = src.slice(at + decl.length);
  const end = rest.search(/\n(?:export )?(?:async )?function |\nexport (?:const|interface|type) /);
  return rest.slice(0, end === -1 ? rest.length : end);
}
/** The code of `src` without // line comments (a comment naming a removed symbol must not fail an absence pin). */
const code = (src: string) => src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
const LIVE_AGENT_PTY = /\bisRunning\(|\bwritePty\(|\bstopPty\(|\bgetPtySize\(|\bgetPtyPid\(|\bstartAgentPty\(/;

test('CONTROL: the sources are the real files and the Run/nvim/Veille PTY probes still exist (the absence pins below are not vacuous)', () => {
  assert.ok(ws.length > 100_000 && api.length > 30_000 && hib.length > 5_000 && pq.length > 5_000 && rw.length > 2_000);
  assert.match(code(hib), /hasLiveRunPty: isRunning\(`\$\{ws\.id\}:run`\),/, 'hibernation keeps the RUN-terminal signal');
  assert.match(body(ws, 'export async function switchWorkspaceBranch('), /stopPty\(nvimId\);/, 'the branch switch still recycles the nvim PTY');
  assert.match(api, /ptyStart: async \(id, cols, rows\) =>/, 'control: the launcher is still here for #233 to delete (not this ticket)');
});

test('message delivery: no typing into a live TUI — a live SDK session, a wake, or the inbox', () => {
  const m = code(body(ws, 'async function dispatchMessageRequestUnmirrored('));
  assert.doesNotMatch(m, LIVE_AGENT_PTY);
  assert.match(m, /sdkDeliverConfirmed\(input\.to, body, peerOrigin\)/, 'control: the live SDK delivery stays');
  assert.match(m, /wakeAgentWithPrompt\(input\.to, body\)/, 'control: the wake stays');
  assert.match(m, /queueInbox\(input\.to, body\)/, 'control: the inbox fallback stays');
  assert.match(m, /if \(!sdkSessionLive\(to\)\) void queueInbox\(to, body\);/, 'the 5 s insurance asks the SDK session only');
});

test('wake: wakeAgentWithPrompt refuses on missing/archived only — a live agent PTY no longer blocks it', () => {
  const w = code(body(ws, 'export async function wakeAgentWithPrompt('));
  assert.match(w, /if \(!ws \|\| ws\.archived\) return false;/);
  assert.doesNotMatch(w, LIVE_AGENT_PTY);
  const s = code(body(ws, 'async function startWorkspaceAgentOnce('));
  assert.doesNotMatch(s, LIVE_AGENT_PTY);
});

test('prompt queue: the flush delivers through the wake path only; the insurance asks the SDK session', () => {
  const f = code(body(pq, 'export async function flushQueuedPrompts('));
  assert.doesNotMatch(f, LIVE_AGENT_PTY);
  assert.match(f, /wakeAgentWithPrompt\(id, body,/, 'control: the wake delivery stays');
  assert.match(f, /if \(!sdkSessionLive\(id\)\) void requeue\(\);/);
  assert.doesNotMatch(code(pq), /from '\.\/pty'/, 'the module no longer imports the PTY layer at all');
});

test('fix checks / send review: a failed wake throws, with no PTY branch', () => {
  for (const name of ['fixChecks', 'sendReviewToAgent']) {
    const at = api.indexOf(`  ${name}: async (`);
    const h = code(api.slice(at, api.indexOf('\n  },\n', at)));
    assert.match(h, /if \(!\(await wakeAgentWithPrompt\(id, prompt, \{ origin: 'human' \}\)\)\) throw new Error\(AGENT_WAKE_FAILED\);/, name);
    assert.doesNotMatch(h, LIVE_AGENT_PTY, name);
  }
});

test('toolbar Restart: no live-PTY branch — straight to the restart dispatcher (sandbox pause thrown after)', () => {
  const at = api.indexOf('  restartAgent: async (id) =>');
  const h = code(api.slice(at, api.indexOf('  stopAgent: async', at)));
  assert.doesNotMatch(h, LIVE_AGENT_PTY);
  assert.doesNotMatch(h, /pty:restart/);
  assert.match(h, /dispatchRestartRequest\(\{ id, fresh: false, trigger: 'toolbar' \}\)/);
  assert.match(h, /if \(!res\.ok && paused\) throw new Error\(paused\);/, 'control: the B1 pause rejection stays');
});

test('restart dispatcher: no PTY mode, no PTY probe; the B1/B3 guard order is intact (sandbox refusal → Pause → Admission → classifier)', () => {
  const r = code(rw);
  assert.doesNotMatch(r, LIVE_AGENT_PTY);
  assert.doesNotMatch(r, /ptyLive|restartPty|from '\.\/pty'/);
  const d = r.slice(r.indexOf('export async function dispatchRestartRequest('));
  const order = ['sandboxPausedMessage(ws)', 'pauseRefusal(ws, restartOrigin)', 'admissionGate({', 'resolveRestart({'].map((s) => d.indexOf(s));
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => k === 0 || i > order[k - 1]), `guard order broken: ${order}`);
});

test('account migration: stops the SDK session and moves the transcript — it never resumes a PTY', () => {
  const m = code(body(ws, 'export async function dispatchMigrateAccountRequest('));
  assert.doesNotMatch(m, LIVE_AGENT_PTY);
  assert.doesNotMatch(m, /wasRunning|priorSize|resumed/);
  assert.match(m, /await sdkStopIfLive\(id\);/, 'control: the SDK stop before the move stays');
  assert.match(m, /await moveWorkspaceTranscripts\(/, 'control: the transcript move stays');
  assert.doesNotMatch(code(ws), /MIGRATE_RESUME_COLS|MIGRATE_RESUME_ROWS/);
  assert.doesNotMatch(cli, /res\.resumed/, 'the CLI prints no (resumed) any more');
});

test('peers: the `running` flag is DROPPED (derived from a PTY probe; nothing prints it — the CLI table has id/branch/repo/status[/files/+-/note])', () => {
  const p = code(body(ws, 'export async function dispatchPeersRequest('));
  assert.doesNotMatch(p, /running:|isRunning\(/);
  assert.match(p, /status: w\.status,/, 'control: the status the CLI prints stays');
  const info = body(ws, 'export interface PeerInfo');
  assert.doesNotMatch(info, /\brunning\b/);
  const cliInfoAt = cli.indexOf('interface PeerInfo {');
  assert.notEqual(cliInfoAt, -1, 'the CLI PeerInfo interface must be found (an absence pin on a missing anchor passes vacuously)');
  assert.doesNotMatch(cli.slice(cliInfoAt, cli.indexOf('\n}\n', cliInfoAt)), /\brunning\b/);
});

test('branch switch: only the nvim PTY is recycled; the agent session is stopped (lazy restart), no agent pty:restart', () => {
  const b = code(body(ws, 'export async function switchWorkspaceBranch('));
  assert.doesNotMatch(b, /isRunning\(id\)|stopPty\(id\)|restartAgent|broadcast\('pty:restart', id\)/);
  assert.match(b, /await sdkStopIfLive\(id\);/, 'control: the SDK stop stays');
  assert.match(b, /if \(restartNvim\) platform\.broadcast\('pty:restart', nvimId\);/, 'control: nvim still restarts');
});

test('promote / attach / detach: the reparent reconcile asks the SDK session only and has no live-PTY deferral', () => {
  const r = code(body(ws, 'async function reconcileRunAfterReparent('));
  assert.doesNotMatch(r, LIVE_AGENT_PTY);
  assert.doesNotMatch(code(ws), /preferStaleForLivePty/);
  assert.match(r, /live: sdkSessionLive\(ws\.id\),/);
});

test('hibernation: the sweep asks the SDK session for the agent and the Run PTY for the guard — no agent PTY signal, no stopPty/getPtyPid', () => {
  const h = code(hib);
  assert.doesNotMatch(h, /hasLivePty|livePtyNow|stopPty|getPtyPid/);
  assert.match(h, /import \{ isRunning \} from '\.\/pty';/, 'only the run-script probe is imported');
  assert.match(h, /const liveSdkNow = sdkSessionLive\(ws\.id\);\n\s*if \(!liveSdkNow\) continue;/);
  assert.match(h, /await sdkStopIfLive\(ws\.id, \{ hibernate: true \}\)/, 'control: the SDK stop stays');
  const shared = code(fs.readFileSync(path.join(here, '..', 'shared', 'hibernation.ts'), 'utf8'));
  assert.doesNotMatch(shared, /hasLivePty/);
  assert.match(shared, /if \(!hasLiveSdk\) return false;/);
  assert.match(shared, /if \(hasLiveRunPty\) return false;/, 'control: a live Run terminal still blocks the Veille');
});

test('wake roster / admission: a sleeping member = no live SDK session', () => {
  assert.match(code(read('wake-roster.ts')), /sleeping: !sdkSessionLive\(ws\.id\),/);
  const aw = code(read('admission-wake.ts'));
  assert.match(aw, /return !sdkSessionLive\(id\);/);
  assert.doesNotMatch(aw, /from '\.\/pty'/);
});

test('#232 F1: a REFUSED resume id (adopted or not) clears to the \'\' marker at BOTH sites — never undefined (the funnel would re-adopt it)', () => {
  const sdk = read('agent-sdk.ts');
  const c = body(sdk, 'async function consume(');
  const at = c.indexOf('if (isBadResumeError(message)) {');
  assert.notEqual(at, -1);
  const branch = c.slice(at, c.indexOf('} finally {', at));
  assert.match(branch, /void persistWorkspacePatch\(session\.wsId, \{ sdkSessionId: refusedResumeClearValue\(wsNow\) \}\);/);
  assert.doesNotMatch(branch, /sdkSessionId: (?:wasAdopted \? '' : )?undefined/);
  const s = body(sdk, 'export async function sdkSend(');
  const sat = s.indexOf('if (wsNow?.sdkSessionId && isBadResumeError(message)) {');
  assert.notEqual(sat, -1);
  const sb = s.slice(sat, s.indexOf('throw err;', sat));
  assert.match(sb, /persistWorkspacePatch\(wsId, \{ sdkSessionId: refusedResumeClearValue\(wsNow\) \}\)/);
  assert.doesNotMatch(sb, /sdkSessionId: undefined/);
});
