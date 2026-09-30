// #227 fix round 1 — the retained opening task (F2), the persisted start error (F3) and spawn's bounded init wait (F1 / D6),
// driven through the REAL sdkSend / consume / sdkHistory / startWorkspaceAgentHeadless / dispatchSpawnRequest over a FAKE CLI
// (the SDK's `query()` factory). One arm per process. `delivered` = what the fake CLI's stdin received, per session, in order.
//
//   wake_brief_first        kept child, cause removed, a WAKE first → the CLI receives [brief, wake prompt]; marker set at the first output
//   composer_brief_first    same through the composer's sdkSend → [brief, typed text]
//   spawn_brief_once        spawn's own send IS the brief → received once (no duplicate from the chokepoint), marker set
//   firstturn_error         D7: the REAL measured failure shape (init → assistant error + result is_error → exit 1, fixture
//                           scripts/fixtures/real-cli-badmodel-2.1.284.jsonl) → spawn not-ok naming the error + model, brief still owed
//                           (no marker, session id cleared), ONE error row; Restart delivers the brief ONCE
//   firstturn_error_live    same, but the CLI does NOT exit after the errored turn: spawn stops the half-running session (child kept STOPPED)
//   errored_turn_then_message  a wake on a live session whose first turn errors: brief NOT marked, unwound; the NEXT send re-claims it and
//                           the marker + resume id land when that one produces output (exactly one SUCCESSFUL delivery)
//   slow_then_die           F1: silent past the bound (ok + note), THEN the CLI dies before any output → the brief is still owed
//                           (no hasInput flip at the timeout), Restart delivers it ONCE
//   race_restart_vs_composer F2: a composer send and Restart in the SAME tick (either order) → the CLI receives the brief ONCE
//   brief_first_under_concurrency F5: composer + wake in one tick → the brief is the CLI's FIRST message, once
//   attach_then_send        F6: a session whose CLI speaks BEFORE any send (keeper reattach) is owed nothing — the first send is not preceded by the brief
//   restart_note            F8: Restart of a silent-CLI kept child carries the not-confirmed note
//   settle_identity         F9b: a stopped predecessor's late death does not overwrite the successor session's first-turn outcome
//   x_restart_silent_live   round 3 F1: a LIVE silent spawned child (ok + note) then Restart → the brief is delivered ONCE (an intentional end keeps the pending copy)
//   x_recycle_wedged_spawn  round 3 F1: same through the boot-wedge recycle (`recycleSession`)
//   late_error_live_restart round 3 F2: the first turn errors AFTER the bound with the CLI alive → the session is STOPPED (child kept stopped), Restart delivers ONCE
//   held_errored_then_restart round 3 F2: a waiter holds a live errored session (no stop) → Restart still takes the owed route, delivers ONCE, restores the resume id
//   x_interrupt_apiretry / x_stop_apiretry_live  round 3 F3: an interrupted / stopped first turn (aborted result) is NOT a failed start
//   recover_races_claim     round 4 F1: after an intentional stop (pending copy KEPT) a wake's claim and the view-open recovery race → the brief reaches the CLI ONCE
//   restart_wedged_second_start round 4 F2: a first start failed, a composer send starts a HUNG second start → Restart replaces it (fresh session, [brief, composer text])
//   swallow_same_text       round 3 F5: a user's message equal to the in-flight brief is sent, never swallowed
//   history_with_transcript verifier2 F-B: persisted start errors interleave into a history that HAS a transcript, by `at` (before / after its rows)
//   drop_vs_append_race     F9a: the stale-brief drop runs through the serialized chain — a concurrent append survives
//   init_only_not_delivery  init alone (no output yet) is NOT delivery: marker unset until the first non-error output lands
//   preinit_death           CLI dies before its first message → spawn/Restart not-ok naming the exit + model; brief unwound
//                           (owed again, no stale pending entry), error persisted + re-rendered by sdkHistory; the retry delivers it ONCE
//   wake_preinit_death      a WAKE starts a kept child, its CLI dies before init → the wake does NOT retire the brief (hasInput stays
//                           unset, brief unwound); the Restart that follows delivers it ONCE
//   stale_pending_brief     a stale pending-prompt copy of the brief (a start that never landed) is dropped when the brief is claimed,
//                           so the view-open recovery cannot resend it (one brief, not two)
//   slow_init_note          CLI silent past the bound → ok with the "not confirmed" note (brief NOT marked delivered), delivered when the
//                           output finally lands; a CLI that answers returns at once, no note
//   start_error_persisted   ensureSession failure → error row persisted (capped) and returned by sdkHistory with NO transcript
//
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-opening-task.mjs <arm>

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARM = process.argv[2] ?? 'wake_brief_first';
const ARMS = ['wake_brief_first', 'composer_brief_first', 'spawn_brief_once', 'firstturn_error', 'firstturn_error_live', 'errored_turn_then_message', 'slow_then_die', 'race_restart_vs_composer', 'brief_first_under_concurrency', 'attach_then_send', 'restart_note', 'settle_identity', 'x_restart_silent_live', 'x_recycle_wedged_spawn', 'late_error_live_restart', 'held_errored_then_restart', 'x_interrupt_apiretry', 'x_stop_apiretry_live', 'swallow_same_text', 'recover_races_claim', 'restart_wedged_second_start', 'history_with_transcript', 'drop_vs_append_race', 'init_only_not_delivery', 'preinit_death', 'wake_preinit_death', 'stale_pending_brief', 'slow_init_note', 'start_error_persisted'];
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM}`); process.exit(2); }

const tmpHome = path.join(process.env.E2E_HOME ?? path.join(os.homedir(), '.cache', 'e2e-opening-task'), ARM);
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
process.env.PATH = `/usr/local/bin:/usr/bin:/bin`;

const liveErrors = [];
const liveUsers = [];
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-opening-task',
  broadcast: (ch, wsId, ev) => {
    if (ch === 'agent:event' && ev?.type === 'error') liveErrors.push({ wsId, at: ev.at, message: ev.message });
    if (ch === 'agent:event' && ev?.type === 'user-message') liveUsers.push({ wsId, text: ev.text });   // the echo of every send that was NOT swallowed
  },   // the rows the view would render, live
  broadcastPtyData: () => true, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-e2e-opening-task', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
const workspaces = await import(`${REPO}/src/main/workspaces.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const restartMod = await import(`${REPO}/src/main/restart-workspace.ts`);
const { owesOpeningTask, startKeepsFailing } = await import(`${REPO}/src/shared/opening-task.ts`).catch(() => ({ owesOpeningTask: () => false, startKeepsFailing: () => false }));
sdk.__setKillKeeperForTests?.(async () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(25); } };
const TASK = 'E2E-BRIEF-4d21 opening task';

// ── the fake CLI ────────────────────────────────────────────────────────────────
let mode = 'init';                  // 'init' | 'silent-live' | 'late-error-live' | 'api-retry' | 'silent-die' | 'init-eager' | 'init-noresult' | 'init-silent' | 'realshape' | 'realshape-live' | 'error-then-ok' | 'die' | 'silent' | 'throw-on-construct'
let releaseSilent = () => {};       // 'silent' sessions stay mute until this is called, then answer like a healthy CLI
const silentGate = new Promise((r) => { releaseSilent = r; });
let releaseDie = () => {};          // 'silent-die' sessions stay mute until this is called, then exit 1 with no output
const dieGate = new Promise((r) => { releaseDie = r; });
const REAL_ERROR = 'Not logged in · Please run /login';   // the text the measured real CLI put in its error assistant message + result
const realErrorLines = (n) => [
  { type: 'assistant', error: 'authentication_failed', is_api_error_message: true, session_id: `fake-${n}`, message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: REAL_ERROR }] } },
  { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', session_id: `fake-${n}`, num_turns: 1, duration_ms: 0, total_cost_usd: 0, result: REAL_ERROR },
];
const resultOk = (n) => ({ type: 'result', subtype: 'success', session_id: `fake-${n}`, is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: 'ok' });
const assistantOut = (n, text) => ({ type: 'assistant', session_id: `fake-${n}`, message: { role: 'assistant', model: 'claude-e2e', content: [{ type: 'text', text }] } });
const sessions = [];                // one entry per query() call: { mode, delivered: [] }
sdk.__setQueryFactoryForTests(({ prompt }) => {
  if (mode === 'throw-on-construct') throw new Error('INJECTED-CONSTRUCT-FAILURE');
  const s = { mode, delivered: [] };
  sessions.push(s);
  const outbox = [];
  let wake = () => {};
  s.push = (...ms) => { outbox.push(...ms); wake(); };   // inject stream output from an arm (a CLI answering late)
  let gotFirst = () => {};
  const first = new Promise((r) => { gotFirst = r; });
  // Drain the prompt generator (that is what arms each turn) and, like a real CLI, finish every turn it accepts — a parked
  // second message only runs after the first turn's `result` releases the gate.
  void (async () => {
    try {
      for await (const m of prompt) {
        const c = m.message?.content;
        s.delivered.push(typeof c === 'string' ? c : (c ?? []).map((b) => b.text ?? '').join(''));
        gotFirst();
        const n = sessions.length;
        if (s.mode === 'init' || s.mode === 'init-noresult') outbox.push(assistantOut(n, 'working on it'));   // a healthy CLI streams output first…
        if (s.mode === 'init') {   // …then finishes the turn ('init-noresult' never does: a queued second message stays parked)
          outbox.push({ type: 'result', subtype: 'success', session_id: `fake-${n}`, is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: 'ok' });
        }
        s.turns = (s.turns ?? 0) + 1;
        if (s.mode === 'error-then-ok') {   // the FIRST turn errors (CLI stays alive), every later one is healthy
          if (s.turns === 1) outbox.push(...realErrorLines(n));
          else outbox.push(assistantOut(n, 'working on it'), resultOk(n));
        }
        if (s.mode === 'late-error-live') {   // the failure lands LATER (past spawn's bound, MEASURED ~184 s on a bad key); the CLI stays alive; later turns are healthy
          if (s.turns === 1) setTimeout(() => s.push(...realErrorLines(n)), 400);
          else outbox.push(assistantOut(n, 'working on it'), resultOk(n));
        }
        if (s.mode === 'api-retry') {   // MEASURED on a bad key: init after the message, then `system/api_retry` rows and NO output (class: none)
          outbox.push({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 401, error: 'authentication_failed', session_id: `fake-${n}` });
        }
        if (s.mode === 'realshape' || s.mode === 'realshape-live') {   // measured real shape (claude 2.1.284, bad model / no auth): synthetic error assistant, is_error result, then exit 1 ('-live': the CLI stays up)
          outbox.push(...realErrorLines(n));
          if (s.mode === 'realshape') outbox.push({ type: '__exit1' });
        }
        wake();
      }
    } catch { /* torn down */ }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      if (s.mode === 'die') { await first; throw new Error('Claude Code process exited with code 1'); }   // reads its prompt, then exits before any message
      if (s.mode === 'silent-live') { await new Promise((r) => { s.onEnd = r; if (s.ended) r(); }); return; }   // never inits, never outputs; ends only when killed (a wedged boot)
      if (s.mode === 'silent-die') { await dieGate; throw new Error('Claude Code process exited with code 1'); }   // never inits, never outputs, then exits
      if (s.mode === 'silent') await silentGate;   // no init, nothing — until released, then a healthy CLI
      if (['init', 'init-noresult', 'init-silent', 'init-eager', 'realshape', 'realshape-live', 'error-then-ok', 'late-error-live', 'api-retry', 'silent'].includes(s.mode)) {
        if (s.mode !== 'init-eager') await first;   // like the real CLI (MEASURED, claude 2.1.284): init only AFTER the first user message. 'init-eager' = a REATTACHED CLI already running
        yield { type: 'system', subtype: 'init', session_id: `fake-${sessions.length}`, tools: [], slash_commands: [] };
      }
      for (;;) {
        while (outbox.length) {
          const m = outbox.shift();
          if (m.type === '__exit1') throw new Error('Claude Code process exited with code 1');
          yield m;
        }
        if (s.ended) return;   // a killed CLI ends its stream
        await new Promise((r) => { wake = r; });
      }
    },
    interrupt: async () => {
      if (s.mode === 'silent-live') { s.ended = true; s.onEnd?.(); }
      if (s.mode === 'init-silent' || s.mode === 'late-error-live') { s.ended = true; wake(); }   // kill = the stream ends (real CLI: process dies)
      if (s.mode === 'api-retry') {   // MEASURED real bytes for an interrupt before any output: the user marker, then an aborted `error_during_execution` result; the CLI stays alive
        s.push({ type: 'user', session_id: `fake-${sessions.length}`, message: { role: 'user', content: '[Request interrupted by user]' } },
          { type: 'result', subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', session_id: `fake-${sessions.length}`, num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: '' });
      }
    }, setModel: async () => {}, setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
  };
});

// ── a real repo + a kept child (created, never started: the state a failed start leaves) ─────────────────────
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmpHome, GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.invalid', GIT_CONFIG_NOSYSTEM: '1' } });
const repoDir = path.join(tmpHome, 'repo');
fs.mkdirSync(repoDir, { recursive: true });
git(repoDir, ['init', '-q', '-b', 'main']);
fs.writeFileSync(path.join(repoDir, 'README.md'), '# e2e\n');
git(repoDir, ['add', '.']); git(repoDir, ['commit', '-q', '-m', 'seed']);
await store.addRepo({ path: repoDir, name: 'repo', defaultBranch: 'main' });
const keptChild = async (extra = {}) => {
  const ws = await workspaces.createWorkspace({ repoPath: repoDir, task: TASK, agent: 'claude', ...extra }, 'spawned');
  return ws.id;
};
const fresh = (id) => store.getWorkspace(id);
const briefsAt = (list) => list.filter((t) => t === TASK).length;

const out = { arm: ARM };
let ok = false;

if (ARM === 'wake_brief_first') {
  const id = await keptChild();
  const woke = await workspaces.wakeAgentWithPrompt(id, 'PEER-MSG');
  const got = await waitFor(() => (sessions[0]?.delivered.length >= 2 ? sessions[0].delivered : null));
  const marked = await waitFor(() => fresh(id)?.openingTaskDelivered === true);
  const again = await workspaces.startWorkspaceAgentHeadless(id);   // Restart-style retry after the wake: nothing owed
  await sleep(150);
  const total = sessions.flatMap((s) => s.delivered);
  Object.assign(out, { woke, delivered: got, marked: !!marked, hasInput: fresh(id)?.hasInput, again, briefs: briefsAt(total), owesAfter: owesOpeningTask(fresh(id)) });
  ok = woke === true && !!got && got[0] === TASK && got[1] === 'PEER-MSG' && got.length === 2 && !!marked && fresh(id)?.hasInput === true
    && again.ok === true && briefsAt(total) === 1 && total.length === 2 && !owesOpeningTask(fresh(id));
} else if (ARM === 'composer_brief_first') {
  const id = await keptChild();
  await sdk.sdkSend(id, 'TYPED-BY-USER');
  const got = await waitFor(() => (sessions[0]?.delivered.length >= 2 ? sessions[0].delivered : null));
  const marked = await waitFor(() => fresh(id)?.openingTaskDelivered === true);
  const second = await sdk.sdkSend(id, 'TYPED-AGAIN').then(() => true);
  await sleep(150);
  const total = sessions.flatMap((s) => s.delivered);
  Object.assign(out, { delivered: got, marked: !!marked, second, briefs: briefsAt(total), all: total });
  ok = !!got && got[0] === TASK && got[1] === 'TYPED-BY-USER' && !!marked && second && briefsAt(total) === 1 && total.length === 3;
} else if (ARM === 'spawn_brief_once') {
  const id = await keptChild();
  const t0 = Date.now();
  const res = await workspaces.startWorkspaceAgentHeadless(id);
  const ms = Date.now() - t0;
  await sleep(200);
  const total = sessions.flatMap((s) => s.delivered);
  Object.assign(out, { res, ms, delivered: total, marked: fresh(id)?.openingTaskDelivered, hasInput: fresh(id)?.hasInput });
  ok = res.ok === true && !res.note && total.length === 1 && total[0] === TASK && fresh(id)?.openingTaskDelivered === true && fresh(id)?.hasInput === true && ms < 3000;
} else if (ARM === 'firstturn_error') {
  // D7: the CLI INITS, then its first turn errors and it exits 1 — init proves life, not delivery.
  mode = 'realshape';
  const res = await workspaces.dispatchSpawnRequest({ task: TASK, repoPath: repoDir, agent: 'claude', detached: true, defaultKind: 'spawned', model: 'e2e-bad-model' });
  const id = res.id;
  await sleep(150);
  const w = fresh(id);
  const events = await sdk.sdkHistory(id);
  const errRows = events.filter((e) => e.type === 'error');
  Object.assign(out, { res, pending: (w?.sdkPendingPrompts ?? []).length, marked: w?.openingTaskDelivered, hasInput: w?.hasInput, sid: w?.sdkSessionId, owes: owesOpeningTask(w), persisted: (w?.sdkStartErrors ?? []).length, historyErrors: errRows.map((e) => e.message) });
  const err = String(res.error ?? '');
  const live = liveErrors.filter((e) => e.wsId === id);
  out.liveErrors = live;
  // ONE row: the normalizer's own `error` event (result is_error) is THE live row; the persisted copy carries the SAME at+text (the renderer's echo dedupe key)
  const oneRow = live.length === 1 && w?.sdkStartErrors?.[0]?.at === live[0].at && w?.sdkStartErrors?.[0]?.message === live[0].message;
  const failedOk = res.ok === false && typeof id === 'string' && /first turn failed/.test(err) && err.includes(REAL_ERROR) && err.includes('e2e-bad-model') && oneRow
    && (w?.sdkPendingPrompts ?? []).length === 0 && w?.openingTaskDelivered !== true && w?.hasInput !== true && !w?.sdkSessionId && owesOpeningTask(w)
    && (w?.sdkStartErrors ?? []).length === 1 && w.sdkStartErrors[0].message.includes(REAL_ERROR)
    && errRows.length === 1 && errRows[0].message.includes(REAL_ERROR);
  mode = 'init';   // the cause is removed: Restart delivers the brief ONCE to a healthy CLI
  if (typeof id !== 'string' || !failedOk) { out.ok = false; out.failedOk = failedOk; console.log(JSON.stringify(out)); process.exit(0); }
  const restarted = await restartMod.dispatchRestartRequest({ id });
  await sleep(300);
  const delivered = sessions.filter((s) => s.mode === 'init').flatMap((s) => s.delivered);
  Object.assign(out, { restarted, deliveredAfterRestart: delivered, marked2: fresh(id)?.openingTaskDelivered, hasInput2: fresh(id)?.hasInput });
  ok = failedOk && restarted.ok === true && restarted.openingTask === true && delivered.length === 1 && delivered[0] === TASK
    && fresh(id)?.openingTaskDelivered === true && fresh(id)?.hasInput === true && !owesOpeningTask(fresh(id));
} else if (ARM === 'firstturn_error_live') {
  mode = 'realshape-live';   // the errored first turn does NOT end the CLI
  const res = await workspaces.dispatchSpawnRequest({ task: TASK, repoPath: repoDir, agent: 'claude', detached: true, defaultKind: 'spawned', model: 'e2e-bad-model' });
  const id = res.id;
  const stopped = await waitFor(() => (typeof id === 'string' && !sdk.sdkHasSession(id) ? true : null), 3000);
  const w = fresh(id);
  Object.assign(out, { res, stopped: !!stopped, hasInput: w?.hasInput, marked: w?.openingTaskDelivered, sid: w?.sdkSessionId, owes: owesOpeningTask(w) });
  const failedOk = res.ok === false && /first turn failed/.test(String(res.error)) && !!stopped && w?.openingTaskDelivered !== true && w?.hasInput !== true && !w?.sdkSessionId && owesOpeningTask(w);
  mode = 'init';
  if (typeof id !== 'string' || !failedOk) { out.ok = false; out.failedOk = failedOk; console.log(JSON.stringify(out)); process.exit(0); }
  const restarted = await restartMod.dispatchRestartRequest({ id });
  await sleep(300);
  const delivered = sessions.filter((s) => s.mode === 'init').flatMap((s) => s.delivered);
  Object.assign(out, { restarted, deliveredAfterRestart: delivered });
  ok = failedOk && restarted.ok === true && restarted.openingTask === true && delivered.length === 1 && delivered[0] === TASK && fresh(id)?.openingTaskDelivered === true;
} else if (ARM === 'errored_turn_then_message') {
  // F2 (round 3): a wake's first turn errors with the CLI alive and NO waiter → the session is STOPPED (child kept stopped); the NEXT send starts a fresh session that carries the brief.
  const id = await keptChild();
  mode = 'error-then-ok';
  const woke = await workspaces.wakeAgentWithPrompt(id, 'PEER-MSG');
  const stopped = await waitFor(() => (!sdk.sdkHasSession(id) && (fresh(id)?.sdkStartErrors ?? []).length === 1 ? true : null));
  await sleep(200);
  const w1 = fresh(id);
  const events = await sdk.sdkHistory(id);
  const s1 = { marked: w1?.openingTaskDelivered, hasInput: w1?.hasInput, sid: w1?.sdkSessionId, owes: owesOpeningTask(w1), errs: (w1?.sdkStartErrors ?? []).length, histErrs: events.filter((e) => e.type === 'error').length };
  mode = 'init';
  const startS2 = sessions.length;
  await sdk.sdkSend(id, 'TYPED-AFTER');                                                                       // fresh session: re-claims the still-owed brief
  const marked = await waitFor(() => fresh(id)?.openingTaskDelivered === true);
  await sleep(200);
  const d2 = sessions.slice(startS2).flatMap((x) => x.delivered);
  const w2 = fresh(id);
  Object.assign(out, { woke, stopped: !!stopped, s1, marked: !!marked, hasInput: w2?.hasInput, sid: w2?.sdkSessionId, d2 });
  ok = woke === true && !!stopped && s1.marked !== true && s1.hasInput !== true && !s1.sid && s1.owes && s1.errs === 1 && s1.histErrs === 1
    && !!marked && w2?.hasInput === true && !!w2?.sdkSessionId && d2.length === 2 && d2[0] === TASK && d2[1] === 'TYPED-AFTER' && !owesOpeningTask(w2);
} else if (ARM === 'held_errored_then_restart') {
  // A waiter HOLDS the errored live session (as spawn's wait does before it stops it): no stop → live + owed + errored; Restart must still take the owed route.
  const id = await keptChild();
  mode = 'late-error-live';
  await workspaces.wakeAgentWithPrompt(id, 'PEER-MSG');
  const held = await sdk.sdkAwaitFirstTurn(id, 4000);                     // a waiter is attached BEFORE the error lands (400 ms) → failFirstTurn must not stop
  await sleep(150);
  const w1 = fresh(id);
  const live1 = sdk.sdkHasSession(id);
  const owedBefore = owesOpeningTask(w1);
  const startS = sessions.length;
  const restarted = await restartMod.dispatchRestartRequest({ id });      // live + owes + errored → the owed route: the brief goes onto the live session
  const marked = await waitFor(() => fresh(id)?.openingTaskDelivered === true);
  await sleep(200);
  const w2 = fresh(id);
  const all = sessions.flatMap((x) => x.delivered);
  const errs2 = (w2?.sdkStartErrors ?? []).length;   // the session's OWN failure row survives its later healthy output (only EARLIER sessions' rows are stale)
  Object.assign(out, { held, live1, owedBefore, errs: (w1?.sdkStartErrors ?? []).length, errs2, restarted, marked: !!marked, sid: w2?.sdkSessionId, all });
  ok = held.state === 'failed' && live1 === true && owedBefore && (w1?.sdkStartErrors ?? []).length === 1
    && restarted.ok === true && restarted.openingTask === true && !!marked && w2?.hasInput === true && w2?.sdkSessionId === 'fake-1' && errs2 === 1
    && briefsAt(all) === 2 && sessions.length === startS;                 // 2 = the errored attempt + the ONE successful delivery, on the SAME live session
} else if (ARM === 'late_error_live_restart') {
  process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '250';
  const id = await keptChild();
  mode = 'late-error-live';
  const res = await workspaces.startWorkspaceAgentHeadless(id);           // silent past the bound → ok + note; the error lands at ~400 ms with nobody waiting
  const stopped = await waitFor(() => (!sdk.sdkHasSession(id) && (fresh(id)?.sdkStartErrors ?? []).length === 1 ? true : null), 3000);
  const w1 = fresh(id);
  const owes1 = owesOpeningTask(w1);
  mode = 'init';
  const restarted = await restartMod.dispatchRestartRequest({ id });
  await sleep(300);
  const delivered = sessions.filter((x) => x.mode === 'init').flatMap((x) => x.delivered);
  Object.assign(out, { res, stopped: !!stopped, owes1, errs: (w1?.sdkStartErrors ?? []).length, restarted, delivered });
  ok = res.ok === true && /not confirmed/.test(res.note ?? '') && !!stopped && owes1 && !w1?.sdkSessionId
    && restarted.ok === true && restarted.openingTask === true && delivered.length === 1 && delivered[0] === TASK && fresh(id)?.openingTaskDelivered === true;
} else if (ARM === 'x_restart_silent_live' || ARM === 'x_recycle_wedged_spawn') {
  process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '250';
  const id = await keptChild();
  mode = 'silent-live';                                                   // a WEDGED boot: never inits, never outputs; its stream ends when killed
  const res = await workspaces.startWorkspaceAgentHeadless(id);           // ok + note at the bound: a LIVE session whose first turn is undecided
  const live0 = sdk.sdkHasSession(id);
  mode = 'init';
  let action;
  if (ARM === 'x_restart_silent_live') action = await restartMod.dispatchRestartRequest({ id });
  else { const wd = await import(`${REPO}/src/main/session-watchdog.ts`); action = await wd.recycleSession(id, 'e2e wedged spawn', 'watchdog-boot').then(() => ({ ok: true })); }
  const got = await waitFor(() => (sessions.filter((x) => x.mode === 'init').flatMap((x) => x.delivered).length >= 1 ? true : null), 4000);
  await sleep(300);
  const delivered = sessions.filter((x) => x.mode === 'init').flatMap((x) => x.delivered);
  Object.assign(out, { res, live0, action, got: !!got, delivered, owes: owesOpeningTask(fresh(id)) });
  ok = res.ok === true && live0 === true && action.ok === true && delivered.length === 1 && delivered[0] === TASK;   // the brief reaches a healthy CLI EXACTLY once
} else if (ARM === 'x_interrupt_apiretry' || ARM === 'x_stop_apiretry_live') {
  process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '250';
  const id = await keptChild();
  mode = 'api-retry';                                                     // MEASURED: init after the message, then api_retry rows, no output
  const res = await workspaces.startWorkspaceAgentHeadless(id);           // ok + note at the bound
  const sid0 = fresh(id)?.sdkSessionId;
  if (ARM === 'x_interrupt_apiretry') await sdk.sdkInterrupt(id); else await sdk.sdkStop(id);   // the CLI answers with the interrupted marker + an aborted error_during_execution result
  await sleep(500);
  const w = fresh(id);
  Object.assign(out, { res, sid0, sid: w?.sdkSessionId, errs: w?.sdkStartErrors ?? [], keepsFailing: startKeepsFailing(w, sdk.sdkHasSession(id)), pending: (w?.sdkPendingPrompts ?? []).length });
  ok = res.ok === true && !!sid0 && w?.sdkSessionId === sid0 && (w?.sdkStartErrors ?? []).length === 0 && !startKeepsFailing(w, sdk.sdkHasSession(id));   // NOT a failed start: no row, sid kept, roster untouched
} else if (ARM === 'recover_races_claim') {
  process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '250';
  const id = await keptChild();
  mode = 'silent-live';
  const res = await workspaces.startWorkspaceAgentHeadless(id);           // silent past the bound: ok + note; a live session whose first turn is undecided
  await sdk.sdkStop(id);                                                  // an INTENTIONAL stop before any output: the brief's pending copy is KEPT
  await waitFor(() => (!sdk.sdkHasSession(id) ? true : null), 2000);
  await sleep(150);
  const pendingKept = (fresh(id)?.sdkPendingPrompts ?? []).some((q) => (typeof q === 'string' ? q : q.text) === TASK);
  mode = 'init';
  const startS = sessions.length;
  await Promise.all([workspaces.wakeAgentWithPrompt(id, 'PEER-WAKE'), sdk.recoverPendingPrompts(id, [])]);   // a bus-wake sweep and the view-open recovery inside ONE ensureSession window
  await sleep(500);
  const d = sessions.slice(startS).flatMap((x) => x.delivered);
  Object.assign(out, { res, pendingKept, d });
  ok = res.ok === true && pendingKept && briefsAt(d) === 1 && d.includes('PEER-WAKE');
} else if (ARM === 'restart_wedged_second_start') {
  process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '250';
  const id = await keptChild();
  mode = 'realshape';                                                     // the FIRST start errors and exits: not-ok, brief owed, one persisted error
  const r1 = await workspaces.startWorkspaceAgentHeadless(id);
  const errs1 = (fresh(id)?.sdkStartErrors ?? []).length;
  mode = 'silent-live';                                                   // a composer send starts a SECOND start that HANGS
  await sdk.sdkSend(id, 'composer hello');
  await sleep(150);
  const s2live = sdk.sdkHasSession(id);
  mode = 'init';
  const startS = sessions.length;
  const restarted = await restartMod.dispatchRestartRequest({ id });      // must REPLACE the hung session (a stale persisted error must not turn this into a no-op)
  await sleep(500);
  const d = sessions.slice(startS).flatMap((x) => x.delivered);
  Object.assign(out, { r1, errs1, s2live, restarted, newSessions: sessions.length - startS, d });
  ok = r1.ok === false && errs1 === 1 && s2live && restarted.ok === true && sessions.length > startS && d.length === 2 && d[0] === TASK && d[1] === 'composer hello';
} else if (ARM === 'swallow_same_text') {
  process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '250';
  const id = await keptChild();
  mode = 'init-silent';                                                   // the first turn stays undecided
  const res = await workspaces.startWorkspaceAgentHeadless(id);
  await sdk.sdkSend(id, TASK);                                            // a USER's message that happens to equal the brief
  await sdk.sdkSend(id, `${TASK} `);
  await sleep(300);
  const echoes = liveUsers.filter((e) => e.wsId === id).map((e) => e.text.trim());   // parked behind the undecided turn, so the echo (not CLI stdin) is what shows each send was accepted
  Object.assign(out, { res, echoes });
  ok = res.ok === true && echoes.length === 3 && echoes.every((t) => t === TASK);     // the brief + the two identical user messages: none swallowed
} else if (ARM === 'slow_then_die') {
  process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '400';
  const id = await keptChild();
  mode = 'silent-die';
  const res = await workspaces.startWorkspaceAgentHeadless(id);          // silent past the bound → ok + note
  const w1 = fresh(id);
  const at = { res, hasInput: w1?.hasInput, marked: w1?.openingTaskDelivered, owes: owesOpeningTask(w1) };
  releaseDie();                                                           // the CLI now dies before producing anything
  const gone = await waitFor(() => (!sdk.sdkHasSession(id) && (fresh(id)?.sdkPendingPrompts ?? []).length === 0 ? true : null), 3000);
  const w2 = fresh(id);
  mode = 'init';
  const restarted = await restartMod.dispatchRestartRequest({ id });
  await sleep(300);
  const delivered = sessions.filter((s) => s.mode === 'init').flatMap((s) => s.delivered);
  Object.assign(out, { at, gone: !!gone, owesAfterDeath: owesOpeningTask(w2), hasInputAfterDeath: w2?.hasInput, restarted, delivered });
  ok = res.ok === true && /not confirmed/.test(res.note ?? '') && at.hasInput !== true && at.marked !== true && at.owes
    && !!gone && owesOpeningTask(w2) && w2?.hasInput !== true
    && restarted.ok === true && restarted.openingTask === true && delivered.length === 1 && delivered[0] === TASK && fresh(id)?.openingTaskDelivered === true;
} else if (ARM === 'race_restart_vs_composer') {
  const a = await keptChild();                        // composer FIRST, Restart in the same tick
  await Promise.all([sdk.sdkSend(a, 'TYPED-A'), restartMod.dispatchRestartRequest({ id: a })]);
  await sleep(400);
  const dA = sessions.flatMap((s) => s.delivered);
  const startA = sessions.length;
  const b = await keptChild();                        // Restart FIRST, composer in the same tick
  await Promise.all([restartMod.dispatchRestartRequest({ id: b }), sdk.sdkSend(b, 'TYPED-B')]);
  await sleep(400);
  const dB = sessions.slice(startA).flatMap((s) => s.delivered);
  Object.assign(out, { dA, dB });
  ok = briefsAt(dA) === 1 && dA[0] === TASK && dA.includes('TYPED-A') && briefsAt(dB) === 1 && dB[0] === TASK && dB.includes('TYPED-B');
} else if (ARM === 'brief_first_under_concurrency') {
  const id = await keptChild();
  await Promise.all([workspaces.wakeAgentWithPrompt(id, 'WAKE-PROMPT'), sdk.sdkSend(id, 'COMPOSER-TEXT'), sdk.sdkSend(id, 'THIRD-TEXT')]);
  await sleep(500);
  const d = sessions.flatMap((s) => s.delivered);
  Object.assign(out, { d });
  ok = d[0] === TASK && briefsAt(d) === 1 && d.includes('WAKE-PROMPT') && d.includes('COMPOSER-TEXT') && d.includes('THIRD-TEXT') && d.length === 4;
} else if (ARM === 'attach_then_send') {
  const id = await keptChild();
  mode = 'init-eager';                                // a reattached CLI: already speaking before any user message
  await sdk.sdkMcpStatus(id).catch(() => {});         // creates the session with NO send
  const inited = await waitFor(() => fresh(id)?.sdkSessionId);
  await sdk.sdkSend(id, 'USER-TEXT');
  await sleep(300);
  const d = sessions.flatMap((s) => s.delivered);
  Object.assign(out, { inited: !!inited, d });
  ok = !!inited && d.length === 1 && d[0] === 'USER-TEXT' && briefsAt(d) === 0;
} else if (ARM === 'restart_note') {
  process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '400';
  const id = await keptChild();
  mode = 'silent';
  const restarted = await restartMod.dispatchRestartRequest({ id });
  Object.assign(out, { restarted });
  ok = restarted.ok === true && restarted.openingTask === true && /^first turn not confirmed within \d+ s — started, not confirmed$/.test(restarted.note ?? '');
} else if (ARM === 'settle_identity') {
  process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '300';
  const id = await keptChild();
  mode = 'silent-die';
  await sdk.sdkSend(id, 'X-1');                       // predecessor s1: silent, later dies
  await sdk.sdkStop(id);                              // removed from the live map; its consume loop is still parked on the fake
  mode = 'init';
  const started = await workspaces.startWorkspaceAgentHeadless(id);   // successor s2 (healthy): first-turn outcome ok
  const before = await sdk.sdkAwaitFirstTurn(id, 200);
  releaseDie();                                       // s1's consume now ends LATE and settles its own (failed) outcome
  await sleep(300);
  const after = await sdk.sdkAwaitFirstTurn(id, 200);
  Object.assign(out, { started, before, after });
  ok = started.ok === true && before.state === 'ok' && after.state === 'ok';
} else if (ARM === 'history_with_transcript') {
  const id = await keptChild();
  const w0 = fresh(id);
  const SID = 'aaaaaaaa-0000-4000-8000-00000000f00b';
  const dir = path.join(tmpHome, '.claude', 'projects', workspaces.mangleProjectDir(w0.worktreePath));   // sdkHistory's transcriptDir: HOME/.claude when no account is pinned
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - 3600e3;
  const env = { userType: 'external', entrypoint: 'cli', cwd: w0.worktreePath, sessionId: SID, version: '2.1.284' };
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), [
    { parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content: 'TX-USER-ROW' }, uuid: 'aaaaaaaa-0000-4000-8000-000000000001', timestamp: new Date(t0).toISOString(), ...env },
    { parentUuid: 'aaaaaaaa-0000-4000-8000-000000000001', isSidechain: false, type: 'assistant', message: { id: 'msg_tx', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: 'TX-ASSISTANT-ROW' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, uuid: 'aaaaaaaa-0000-4000-8000-000000000002', timestamp: new Date(t0 + 1000).toISOString(), ...env },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  await store.upsertWorkspace({ ...w0, sdkSessionId: SID, sdkStartErrors: [{ at: t0 - 5000, message: 'START-ERR-BEFORE' }, { at: t0 + 60000, message: 'START-ERR-AFTER' }] });
  const events = await sdk.sdkHistory(id);
  const flat = events.map((e) => JSON.stringify(e));
  const at = (needle) => flat.findIndex((s) => s.includes(needle));
  const ix = { before: at('START-ERR-BEFORE'), user: at('TX-USER-ROW'), asst: at('TX-ASSISTANT-ROW'), after: at('START-ERR-AFTER') };
  Object.assign(out, { ix, n: events.length });
  ok = ix.user >= 0 && ix.asst > ix.user && ix.before >= 0 && ix.before < ix.user && ix.after > ix.asst;   // the transcript rows are real AND the rows sit either side by `at`
} else if (ARM === 'drop_vs_append_race') {
  const id = await keptChild();
  await store.upsertWorkspace({ ...fresh(id), sdkPendingPrompts: [TASK] });      // a stale copy of the brief
  await sdk.__dropPendingRaceForTests(id, TASK, { id: 'race-1', key: 'race-key-1', text: 'CONCURRENT-APPEND' });
  const left = (fresh(id)?.sdkPendingPrompts ?? []).map((p) => (typeof p === 'string' ? p : p.text));
  Object.assign(out, { left });
  ok = left.length === 1 && left[0] === 'CONCURRENT-APPEND';
} else if (ARM === 'init_only_not_delivery') {
  const id = await keptChild();
  mode = 'init-silent';   // inits, then no output
  const woke = await workspaces.wakeAgentWithPrompt(id, 'PEER-MSG');
  await waitFor(() => fresh(id)?.sdkSessionId);
  await sleep(300);
  const beforeOut = { sid: fresh(id)?.sdkSessionId, marked: fresh(id)?.openingTaskDelivered, hasInput: fresh(id)?.hasInput, delivered: sessions[0]?.delivered };
  sessions[0].push(assistantOut(1, 'first output'), resultOk(1));   // the first non-error output lands
  const marked = await waitFor(() => fresh(id)?.openingTaskDelivered === true);
  Object.assign(out, { woke, beforeOut, marked: !!marked, hasInput: fresh(id)?.hasInput });
  ok = woke === true && !!beforeOut.sid && beforeOut.marked !== true && beforeOut.hasInput !== true && beforeOut.delivered?.[0] === TASK
    && !!marked && fresh(id)?.hasInput === true;
} else if (ARM === 'preinit_death') {
  const spawnDied = async () => workspaces.dispatchSpawnRequest({ task: TASK, repoPath: repoDir, agent: 'claude', detached: true, defaultKind: 'spawned', model: 'e2e-bad-model' });
  mode = 'die';
  const res = await spawnDied();
  const id = res.id;
  await sleep(100);
  const w = fresh(id);
  const events = await sdk.sdkHistory(id);
  const errRows = events.filter((e) => e.type === 'error');
  Object.assign(out, { res, pending: (w?.sdkPendingPrompts ?? []).length, marked: w?.openingTaskDelivered, hasInput: w?.hasInput, owes: owesOpeningTask(w), persisted: (w?.sdkStartErrors ?? []).length, historyErrors: errRows.map((e) => e.message) });
  const err = String(res.error ?? '');
  const diedOk = res.ok === false && typeof id === 'string' && /exited before its first turn produced output/.test(err) && /exited with code 1/.test(err) && err.includes('e2e-bad-model')
    && (w?.sdkPendingPrompts ?? []).length === 0 && w?.openingTaskDelivered !== true && w?.hasInput !== true && owesOpeningTask(w)
    && (w?.sdkStartErrors ?? []).length === 1 && /exited with code 1/.test(w.sdkStartErrors[0].message)
    && errRows.length === 1 && /exited with code 1/.test(errRows[0].message);
  // the cause is removed: Restart delivers the brief ONCE to a live CLI
  mode = 'init';
  // (a death that was NOT reported leaves hasInput set, so Restart would take the legacy PTY route — stop with a verdict, don't crash)
  if (typeof id !== 'string' || !diedOk) { out.ok = false; out.diedOk = diedOk; console.log(JSON.stringify(out)); process.exit(0); }
  const restarted = await restartMod.dispatchRestartRequest({ id });
  await sleep(300);
  const okSessions = sessions.filter((s) => s.mode === 'init');
  const delivered = okSessions.flatMap((s) => s.delivered);
  Object.assign(out, { restarted, deliveredAfterRestart: delivered, marked2: fresh(id)?.openingTaskDelivered });
  // F7: the failure was transient — once the healthy session produced output its stale start error must be gone (store AND history)
  const cleared = await waitFor(() => ((fresh(id)?.sdkStartErrors ?? []).length === 0 ? true : null), 2000);
  const histAfter = (await sdk.sdkHistory(id)).filter((e) => e.type === 'error').length;
  Object.assign(out, { staleErrorsCleared: !!cleared, histErrorsAfter: histAfter });
  ok = diedOk && restarted.ok === true && restarted.openingTask === true && delivered.length === 1 && delivered[0] === TASK && fresh(id)?.openingTaskDelivered === true && !!cleared && histAfter === 0;
} else if (ARM === 'wake_preinit_death') {
  const id = await keptChild();
  mode = 'die';
  const woke = await workspaces.wakeAgentWithPrompt(id, 'PEER-MSG');   // starts (true): session created, sends queued
  await sleep(400);                                                     // the CLI reads its prompt, then dies before any message
  const w = fresh(id);
  const stillOwed = owesOpeningTask(w);
  Object.assign(out, { woke, hasInput: w?.hasInput, stillOwed });
  if (!stillOwed) { out.ok = false; console.log(JSON.stringify(out)); process.exit(0); }   // wrongly retired: Restart would leave the SDK path
  mode = 'init';
  const restarted = await restartMod.dispatchRestartRequest({ id });
  await sleep(300);
  const delivered = sessions.filter((s) => s.mode === 'init').flatMap((s) => s.delivered);
  Object.assign(out, { woke, hasInput: w?.hasInput, marked: w?.openingTaskDelivered, stillOwed, pendingBriefs: (w?.sdkPendingPrompts ?? []).filter((p) => p.text === TASK).length, restarted, delivered });
  ok = woke === true && w?.hasInput !== true && w?.openingTaskDelivered !== true && stillOwed
    && (w?.sdkPendingPrompts ?? []).every((p) => p.text !== TASK)
    && restarted.ok === true && restarted.openingTask === true && briefsAt(delivered) === 1;
} else if (ARM === 'stale_pending_brief') {
  const id = await keptChild();
  await store.upsertWorkspace({ ...fresh(id), sdkPendingPrompts: [TASK] });   // legacy string[] form: normalised on read
  mode = 'init-noresult';                                                       // the first turn stays open (a stale copy would otherwise die at its `result`)
  await workspaces.wakeAgentWithPrompt(id, 'PEER-MSG');
  const got = await waitFor(() => (sessions[0]?.delivered.includes(TASK) ? sessions[0].delivered : null));
  await sdk.recoverPendingPrompts(id, []);                                     // what opening the Agent view does
  await sleep(300);
  const pendingBriefs = (fresh(id)?.sdkPendingPrompts ?? []).filter((p) => (typeof p === 'string' ? p : p.text) === TASK).length;
  Object.assign(out, { delivered: got, pendingBriefs });
  ok = !!got && got[0] === TASK && pendingBriefs === 1;   // the live brief only — a surviving stale copy is resent by the recovery = 2
} else if (ARM === 'slow_init_note') {
  process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '700';
  const idSlow = await keptChild();
  mode = 'silent';
  const t0 = Date.now();
  const slow = await workspaces.startWorkspaceAgentHeadless(idSlow);
  const slowMs = Date.now() - t0;
  const slowUnmarked = fresh(idSlow)?.openingTaskDelivered !== true && fresh(idSlow)?.hasInput !== true;   // not confirmed ≠ delivered
  const idFast = await keptChild();
  mode = 'init';
  const t1 = Date.now();
  const fast = await workspaces.startWorkspaceAgentHeadless(idFast);
  const fastMs = Date.now() - t1;
  releaseSilent();                                                         // the slow CLI finally comes up and answers
  await waitFor(() => sessions[0]?.delivered.length);
  sessions[0].push(assistantOut(1, 'late answer'), resultOk(1));
  const lateMarked = await waitFor(() => fresh(idSlow)?.openingTaskDelivered === true);
  Object.assign(out, { slow, slowMs, slowUnmarked, fast, fastMs, lateMarked: !!lateMarked });
  ok = slow.ok === true && /first turn not confirmed within 1 s — started, not confirmed/.test(slow.note ?? '') && slowMs >= 650 && slowMs < 2500 && slowUnmarked
    && fast.ok === true && !fast.note && fastMs < 500 && fresh(idFast)?.hasInput === true
    && !!lateMarked && fresh(idSlow)?.hasInput === true;
} else if (ARM === 'start_error_persisted') {
  const id = await keptChild();
  mode = 'throw-on-construct';
  const rejected = [];
  for (let i = 0; i < 7; i++) { await sdk.sdkSend(id, `try-${i}`).catch((e) => rejected.push(String(e.message))); await sleep(2); }
  await sleep(100);
  const w = fresh(id);
  const events = await sdk.sdkHistory(id);            // NO transcript exists — the rows must still come back
  const errs = events.filter((e) => e.type === 'error');
  Object.assign(out, { rejected: rejected.length, persisted: (w?.sdkStartErrors ?? []).length, history: errs.length, first: errs[0]?.message, hasTranscript: false });
  ok = rejected.length === 7 && (w?.sdkStartErrors ?? []).length === 5 && errs.length === 5
    && errs.every((e) => /^Couldn't start the agent: INJECTED-CONSTRUCT-FAILURE/.test(e.message)) && owesOpeningTask(w);
}

out.ok = ok;
console.log(JSON.stringify(out));
process.exit(0);
