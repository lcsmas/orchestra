// #199 residual (T6b, ledger #198 D19): false "hung mid-call 10m" on a healthy member.
//
// Cause (measured, 15/15 field escalations): a tool call that ENDS without
// PostToolUse — a FAILED call fires PostToolUseFailure, a DENIED call fires neither
// (only the batch's PostToolBatch). Orchestra wired PostToolUse only, so the call's
// pretool stayed in inFlightTools until the turn ended; a turn still running 10 min
// later escalated. The coalesced wake in the incident emits no event at all — it is
// a correlate of a long turn, not a cause (arm coalesced_next_turn).
//
// Drives the REAL chain: installOrchestraHooks (workspaces.ts) writes the worktree's
// settings + hook script → this rig plays Claude Code's hook dispatcher (runs each
// installed activity-hook command for the event, payload on stdin, shapes captured
// from CLI 2.1.284) → the real events-spool reader → real applyAgentEvent
// (activity.ts) → real tracker (hibernation-activity.ts) → real decideEscalation.
// SUBJECT_REPO=<tree> drives another tree's modules (G1: master must FAIL the
// must-FAIL arms through this same rig). One arm per process (module state).
//
// Usage: node --experimental-strip-types --import ./scripts/.r2-register.mjs \
//          scripts/e2e-liveness-failed-call.mjs <arm>      → one JSON line, `ok`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(process.env.SUBJECT_REPO ?? HERE_REPO);
const ARM = process.argv[2] ?? 'failed_call';
const MIN = 60_000;

// expect: 'escalate' | 'skip' at the evaluation instant; `mustFailOnMaster` marks
// the arms the fix exists for (G1) — everything else must read the same on master.
const ARMS = {
  failed_call: { expect: 'skip', at: 10 * MIN, mustFailOnMaster: true },
  failed_call_long_sibling: { expect: 'skip', at: 10 * MIN, mustFailOnMaster: true },
  denied_call: { expect: 'skip', at: 10 * MIN, mustFailOnMaster: true },
  mismined_websearch: { expect: 'skip', at: 30 * MIN, mustFailOnMaster: true },
  genuine_hang: { expect: 'escalate', at: 10 * MIN },
  parallel_batch_pending: { expect: 'escalate', at: 10 * MIN },
  subagent_batch_keeps_parent: { expect: 'escalate', at: 30 * MIN },
  empty_batch_no_fifo: { expect: 'escalate', at: 10 * MIN },
  queued_submit_keeps_live: { expect: 'escalate', at: 10 * MIN },
  coalesced_next_turn: { expect: 'skip', at: 10 * MIN },
  healthy: { expect: 'skip', at: 10 * MIN },
  upgrade_reinstall: { expect: 'n/a', at: null, mustFailOnMaster: true },
  real_cli_failed_call: { expect: 'skip', at: null, mustFailOnMaster: true },
  real_cli_denied_call: { expect: 'skip', at: null, mustFailOnMaster: true },
};
const spec = ARMS[ARM];
if (!spec) {
  console.error(`unknown arm: ${ARM} (one of ${Object.keys(ARMS).join(', ')})`);
  process.exit(2);
}

// btrfs, never /tmp (ledger #198 briefing). HOME + ORCHESTRA_HOME both point here
// BEFORE any module import (events-spool reads ORCHESTRA_HOME at load).
const REAL_HOME = os.homedir();
const base = path.join(process.env.T6B_HOME ?? path.join(REAL_HOME, '.t6b-rig'), ARM);
if (!base.startsWith(REAL_HOME + path.sep)) throw new Error(`refusing rig dir outside $HOME: ${base}`);
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'home');
const wt = path.join(base, 'worktree');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(wt, { recursive: true });
process.env.ORCHESTRA_HOME = home;
process.env.HOME = home;

const out = { arm: ARM, subject: REPO, ok: false };
const done = (extra) => {
  Object.assign(out, extra);
  console.log(JSON.stringify(out));
  process.exit(0);
};

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-t6b',
  broadcast: () => {},
  broadcastPtyData: () => {},
  canBroadcast: () => true,
  isFocused: () => false,
  hasAttachedUi: () => true, // the spool reader drains only with a UI attached
  notify: () => {},
  openExternal: () => {},
  showItemInFolder: () => {},
  openPath: () => {},
  openAccountLoginUrl: () => {},
  closeAccountLogin: () => {},
  getUserDataDir: () => home,
  getLogsDir: () => `${home}/logs`,
  getAppVersion: () => '0.0.0-t6b',
  getAppMetrics: () => [],
  isEncryptionAvailable: () => false,
  encryptString: (s) => s,
  decryptString: (s) => s,
});

const { store } = await import(`${REPO}/src/main/store.ts`);
const { installOrchestraHooks } = await import(`${REPO}/src/main/workspaces.ts`);
const spool = await import(`${REPO}/src/main/events-spool.ts`);
const { applyAgentEvent } = await import(`${REPO}/src/main/activity.ts`);
const tracker = await import(`${REPO}/src/main/hibernation-activity.ts`);
const { decideEscalation } = await import(`${REPO}/src/shared/bus-liveness.ts`);

const COORD = 'ws-t6b-coordinator';
const WS = 'ws-t6b-member';
await store.load?.();
for (const w of [
  { id: COORD, name: 't6b-coordinator' },
  { id: WS, name: 't6b-member', parentId: COORD, lastTask: 'rig task' },
]) {
  await store.upsertWorkspace({
    kind: 'scratch',
    repoPath: '',
    worktreePath: wt,
    status: 'idle',
    createdAt: Date.now(),
    hasInput: true,
    ...w,
  });
}

await installOrchestraHooks(wt);
const settings = JSON.parse(fs.readFileSync(path.join(wt, '.claude', 'settings.local.json'), 'utf8'));
spool.startEventsSpool();
const eventsDir = spool.getEventsDir();
if (!eventsDir.startsWith(home)) throw new Error(`events dir escaped the rig: ${eventsDir}`);

// ── Claude Code's hook dispatcher, for the activity hook only ─────────────────
const hookEnv = {
  HOME: REAL_HOME,
  PATH: '/usr/local/bin:/usr/bin:/bin',
  ORCHESTRA_WS_ID: WS,
  ORCHESTRA_EVENTS_DIR: eventsDir,
  ORCHESTRA_WORKTREE: wt,
};
const hooksRan = {};
function fire(hookEvent, payload) {
  const full = {
    session_id: 't6b-session',
    transcript_path: path.join(home, 'transcript.jsonl'),
    cwd: wt,
    prompt_id: 't6b-prompt',
    permission_mode: 'bypassPermissions',
    hook_event_name: hookEvent,
    ...payload,
  };
  let ran = 0;
  for (const group of settings.hooks?.[hookEvent] ?? []) {
    if (group.matcher && full.tool_name && !new RegExp(`^(?:${group.matcher})$`).test(full.tool_name)) continue;
    for (const h of group.hooks ?? []) {
      if (h.type !== 'command' || !h.command.includes('orchestra-hook.sh')) continue;
      execFileSync('bash', ['-c', h.command], { input: JSON.stringify(full), env: hookEnv, cwd: wt });
      ran++;
    }
  }
  hooksRan[hookEvent] = (hooksRan[hookEvent] ?? 0) + ran;
}
const pre = (tool_name, tool_use_id, tool_input = { command: 'x' }) =>
  fire('PreToolUse', { tool_name, tool_input, tool_use_id });
const post = (tool_name, tool_use_id, tool_response = { stdout: 'ok', stderr: '', interrupted: false }) =>
  fire('PostToolUse', { tool_name, tool_input: { command: 'x' }, tool_response, tool_use_id, duration_ms: 5 });
const fail = (tool_name, tool_use_id) =>
  fire('PostToolUseFailure', {
    tool_name,
    tool_input: { command: 'false' },
    tool_use_id,
    error: 'Exit code 1',
    is_interrupt: false,
    duration_ms: 4,
  });
const batch = (...calls) =>
  fire('PostToolBatch', {
    tool_calls: calls.map(([tool_name, tool_use_id]) => ({
      tool_name,
      tool_input: { command: 'x' },
      tool_use_id,
      tool_response: { stdout: '' },
    })),
  });
const submit = () => fire('UserPromptSubmit', { prompt: 'wake order' });
const stop = () => fire('Stop', { stop_hook_active: false });

// Bounded wait until the reader has APPLIED every line written so far: its own
// persisted high-water mark (`<id>.cursor`, written after the apply loop) must
// reach the writer's seq counter. Never sleep-then-read.
async function drained(ms = 10_000) {
  const t0 = Date.now();
  const seqFile = path.join(eventsDir, `${WS}.seq`);
  const curFile = path.join(eventsDir, `${WS}.cursor`);
  for (;;) {
    let want = 0;
    let have = 0;
    try { want = Number(fs.readFileSync(seqFile, 'utf8')) || 0; } catch { /* none yet */ }
    try { have = JSON.parse(fs.readFileSync(curFile, 'utf8')).lastSeq ?? 0; } catch { /* none yet */ }
    if (want > 0 && have >= want) return want;
    if (Date.now() - t0 > ms) throw new Error(`spool not drained: seq ${want}, cursor ${have}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function statusIs(want, ms = 5_000) {
  const t0 = Date.now();
  while (store.getWorkspace(WS)?.status !== want) {
    if (Date.now() - t0 > ms) throw new Error(`status never became ${want} (is ${store.getWorkspace(WS)?.status})`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

// The roster row, built exactly as index.ts setLivenessRoster does.
function member() {
  const ws = store.getWorkspace(WS);
  const parent = ws.parentId ? store.getWorkspace(ws.parentId) : undefined;
  return {
    reader: ws.id,
    coordinator: parent && !parent.archived ? parent.id : null,
    hasTask: !!ws.lastTask,
    lastActivityAt: tracker.getLastActivity(ws.id) ?? Date.now(),
    appStartedAt: Date.now(),
    running: ws.status === 'running',
    waiting: ws.status === 'waiting',
    inFlightTools: tracker.getInFlightTools(ws.id),
    runId: COORD,
  };
}
function judge(atMs, extra = {}) {
  const m = member();
  const now = typeof atMs === 'number' ? atMs : Date.now() + spec.at + 1_000;
  const d = decideEscalation(m, undefined, now, true);
  const got = d.kind === 'escalate' ? 'escalate' : 'skip';
  done({
    ok: got === spec.expect,
    expect: spec.expect,
    got,
    decision: d.kind === 'escalate'
      ? { kind: d.kind, hungTool: d.hungTool ?? null, silentMin: Math.round(d.silentForMs / MIN) }
      : { kind: d.kind, why: d.why },
    running: m.running,
    inFlight: m.inFlightTools.map((c) => `${c.tool}:${c.toolUseId}`),
    hooksRan,
    ...extra,
  });
}

// The REAL CLI with the REAL installed hooks: `firstCmd` (fails, or is denied),
// then a 40 s `tail -f` (the CLI rejects sleep-like commands) that keeps the turn
// running. Judged while that call is live, at the last instant it is still under
// its ceiling (startedAt + 600 s - 1): an OLDER in-flight entry is then past 600 s
// → escalates iff it is a phantom.
async function realCli(permArgs, firstCmd) {
  const cliEnv = {
    ...hookEnv,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? path.join(REAL_HOME, '.claude'),
    PATH: `${path.join(REAL_HOME, '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin`,
    TERM: 'xterm',
  };
  const cli = spawn(
    'claude',
    // Prompt right after -p: `--allowedTools` is variadic and would swallow it.
    ['-p', `Make exactly two Bash tool calls, strictly one after the other, exactly as written, in the foreground (never run_in_background), and you MUST make the second call even if the first one fails or is denied: first \`${firstCmd}\`, then \`timeout 40 tail -f /dev/null\`. Then reply DONE.`,
      '--model', 'haiku', '--output-format', 'text', ...permArgs],
    { cwd: wt, env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let cliOut = '';
  cli.stdout.on('data', (d) => { cliOut += d; });
  cli.stderr.on('data', (d) => { cliOut += d; });
  // OS-level positive control: the long call is REALLY running under this CLI
  // (a denied call also lingers in the tracker on master, so the spool alone
  // cannot prove it is live).
  const tailRunning = () => {
    for (const pid of fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d))) {
      try {
        const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
        if (argv[0] !== 'tail' || argv[1] !== '-f' || argv[2] !== '/dev/null') continue;
        for (let p = pid, hops = 0; p && p !== '1' && hops < 12; hops++) {
          if (Number(p) === cli.pid) return true;
          p = fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' ')[1];
        }
      } catch { /* raced exit */ }
    }
    return false;
  };
  const t0 = Date.now();
  const spoolLines = () => {
    const f = path.join(eventsDir, `${WS}.jsonl`);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  for (;;) {
    const lines = spoolLines();
    const pretools = lines.filter((l) => l.event === 'pretool');
    const stopped = lines.some((l) => l.event === 'stop');
    if (pretools.length >= 2 && !stopped && tailRunning()) {
      await drained();
      await statusIs('running');
      const liveId = pretools[pretools.length - 1].toolUseId;
      const live = tracker.getInFlightTools(WS).find((c) => c.toolUseId === liveId);
      const spoolEvents = spoolLines().map((l) => `${l.event}${l.toolUseId ? ':' + l.toolUseId.slice(-6) : ''}`);
      const markerCreated = fs.existsSync(path.join(wt, 't6b-denied-marker'));
      cli.kill('SIGTERM');
      if (!live) done({ ok: false, error: 'VOID: live call absent from the tracker', spoolEvents });
      judge(live.startedAt + 600_000 - 1, { spoolEvents, tailRunning: true, markerCreated });
    }
    if (stopped || Date.now() - t0 > 180_000 || cli.exitCode !== null) {
      cli.kill('SIGTERM');
      done({ ok: false, error: 'VOID: no live 2nd call before the turn ended', spool: lines.map((l) => l.event), cliOut: cliOut.slice(-400) });
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── arms ─────────────────────────────────────────────────────────────────────
try {
  switch (ARM) {
    case 'failed_call':
      // The incident (verifier ca4268dd, 2026-09-29 17:04:07Z): a turn started by a
      // wake; a Bash exits non-zero mid-turn; the turn keeps working >10 min. The
      // coalesced wake order queued behind it emits NO event (agent-sdk.ts
      // coalesceWakeOrderInto path) — so nothing is fired for it here.
      submit();
      pre('Bash', 'toolu_T6B_OK_A'); post('Bash', 'toolu_T6B_OK_A'); batch(['Bash', 'toolu_T6B_OK_A']);
      pre('Bash', 'toolu_T6B_FAILED'); fail('Bash', 'toolu_T6B_FAILED'); batch(['Bash', 'toolu_T6B_FAILED']);
      pre('Bash', 'toolu_T6B_OK_C'); post('Bash', 'toolu_T6B_OK_C'); batch(['Bash', 'toolu_T6B_OK_C']);
      break;
    case 'failed_call_long_sibling':
      // The failed call's batch stays OPEN behind a legitimately long sibling (an
      // uncapped MCP call, 30-min ceiling): only PostToolUseFailure can remove it
      // before the Bash ceiling — the batch reconciliation cannot (it has not fired).
      submit();
      pre('mcp__slow__long_query', 'toolu_T6B_LONG', { q: 'x' });
      pre('Bash', 'toolu_T6B_FAILED'); fail('Bash', 'toolu_T6B_FAILED');
      break;
    case 'denied_call':
      // A permission/hook/canUseTool deny: PreToolUse fired, then ONLY PostToolBatch.
      // Parallel with an ok sibling listed FIRST, so the batch must carry every id.
      submit();
      pre('Bash', 'toolu_T6B_OK_A'); pre('Bash', 'toolu_T6B_DENIED'); post('Bash', 'toolu_T6B_OK_A');
      batch(['Bash', 'toolu_T6B_OK_A'], ['Bash', 'toolu_T6B_DENIED']);
      break;
    case 'mismined_websearch':
      // Field c3593714: the PostToolUse payload's tool_response nests a server-tool
      // `"tool_use_id":"srvtoolu_…"` BEFORE the top-level id, so the per-call hook
      // mines the wrong id. The batch lists the real one.
      submit();
      pre('WebSearch', 'toolu_T6B_WEB', { query: 'q' });
      post('WebSearch', 'toolu_T6B_WEB', { query: 'q', results: [{ tool_use_id: 'srvtoolu_T6B_NESTED', content: [] }] });
      batch(['WebSearch', 'toolu_T6B_WEB']);
      break;
    case 'genuine_hang':
      // A call that never returns: no per-call end, its batch never resolves.
      submit();
      pre('Bash', 'toolu_T6B_HUNG');
      break;
    case 'parallel_batch_pending':
      // Parallel batch: one call fails fast, its sibling hangs → the batch never
      // resolves; the failed call leaves, the hung one must still escalate.
      submit();
      pre('Bash', 'toolu_T6B_HUNG'); pre('Bash', 'toolu_T6B_FAILED'); fail('Bash', 'toolu_T6B_FAILED');
      break;
    case 'subagent_batch_keeps_parent':
      // A subagent's batch resolves while the parent's Agent call runs: only the
      // listed ids may leave (a clear-all would mask a hung Agent call).
      submit();
      pre('Agent', 'toolu_T6B_PARENT', { prompt: 'p' });
      pre('Bash', 'toolu_T6B_SUB'); post('Bash', 'toolu_T6B_SUB'); batch(['Bash', 'toolu_T6B_SUB']);
      break;
    case 'empty_batch_no_fifo':
      // An id-LESS in-flight call (legacy hook / remote wire) + a batch whose ids
      // match nothing: the batch must NOT fall back to FIFO and strip it.
      submit();
      fire('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' } });
      fire('PostToolBatch', { tool_calls: [] });
      break;
    case 'queued_submit_keeps_live':
      // T6 review-199 F1: a PARKED prompt mid-turn (queuedSubmit) must not wipe a
      // live tool of the running turn — through the real activity.ts gate.
      submit();
      pre('Bash', 'toolu_T6B_HUNG');
      await drained();
      applyAgentEvent(WS, 'submit', undefined, undefined, undefined, undefined, undefined, true);
      break;
    case 'coalesced_next_turn':
      // The D19 hypothesis as briefed: a phantom from turn N (posttool AND stop
      // lost), turn N+1 started from the coalesced wake order. On the hook path
      // that start IS a UserPromptSubmit → T6's turn-start clear runs. Reads
      // `skip` on master too — the hypothesis does not reproduce.
      submit();
      pre('Bash', 'toolu_T6B_PHANTOM_TURN_N');
      submit();
      break;
    case 'upgrade_reinstall': {
      // An EXISTING worktree installed by the previous build (PostToolUse only,
      // stale stamp) must gain the new wiring on its next install — without a
      // duplicate PostToolUse entry.
      const cmd = settings.hooks.PostToolUse[0].hooks[0].command;
      fs.writeFileSync(path.join(wt, '.claude', 'settings.local.json'), JSON.stringify({
        hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: cmd }] }] },
      }));
      fs.writeFileSync(path.join(wt, '.orchestra', '.hooks-version'), 'digest-of-the-previous-build');
      await installOrchestraHooks(wt);
      const after = JSON.parse(fs.readFileSync(path.join(wt, '.claude', 'settings.local.json'), 'utf8')).hooks;
      const activity = (ev) => (after[ev] ?? []).flatMap((g) => g.hooks ?? []).filter((h) => h.command.includes('orchestra-hook.sh')).map((h) => h.command.match(/bash "\$f" (\w+)/)?.[1]);
      const got = { PostToolUse: activity('PostToolUse'), PostToolUseFailure: activity('PostToolUseFailure'), PostToolBatch: activity('PostToolBatch') };
      done({
        ok: JSON.stringify(got) === JSON.stringify({ PostToolUse: ['posttool'], PostToolUseFailure: ['posttool'], PostToolBatch: ['toolbatch'] }),
        got,
        stamp: fs.readFileSync(path.join(wt, '.orchestra', '.hooks-version'), 'utf8').slice(0, 12),
      });
      break;
    }
    case 'healthy':
      submit();
      pre('Bash', 'toolu_T6B_OK_A'); post('Bash', 'toolu_T6B_OK_A'); batch(['Bash', 'toolu_T6B_OK_A']);
      break;
    case 'real_cli_failed_call':
      // bypassPermissions = Orchestra's SDK-session default (agent-sdk.ts).
      await realCli(['--permission-mode', 'bypassPermissions'], 'false');
      break;
    case 'real_cli_denied_call': {
      // A PreToolUse-hook DENY (project settings, beside Orchestra's own local
      // settings): PreToolUse fires, then only PostToolBatch — the same shape as a
      // permission / canUseTool deny (probe + field 4b864aaa AskUserQuestion).
      const deny = path.join(wt, '.claude', 't6b-deny.sh');
      fs.writeFileSync(deny, `#!/usr/bin/env bash\ncase "$(cat)" in *t6b-denied-marker*) echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"t6b rig deny"}}' ;; esac\nexit 0\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(wt, '.claude', 'settings.json'), JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `bash ${deny}` }] }] },
      }));
      await realCli(['--permission-mode', 'bypassPermissions'], 'touch t6b-denied-marker');
      break;
    }
  }
  await drained();
  await statusIs('running');
  judge();
} catch (e) {
  done({ ok: false, error: String(e?.stack ?? e), hooksRan });
}
