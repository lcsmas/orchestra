// #256 (wave E, ledger #276 D6) — auto Pause on a usage limit + auto Reprise when the quota is back, incl. an ACCOUNT SWITCH and a RE-LOGIN,
// driven through the REAL modules (agent-sdk producer → activity → prompt-queue tick → pause-auto → bus; workspaces.dispatchMigrateAccountRequest;
// api-handlers.accountLoginStart) over a REAL bus.sqlite + store, one arm per process. The ONLY fakes: the SDK query (no real CLI), the `claude` binary
// (a stub on a stripped PATH) and the Anthropic USAGE API (a local HTTP server; `fetch` is rewritten to it and every other outbound fetch is refused).
//
// SAFETY (D9): scratch ORCHESTRA_HOME + HOME + CLAUDE_CONFIG_DIR + account config dirs under ~/.cache (btrfs), refused anywhere near a live
// ~/.orchestra / ~/.claude* / ~/.config; no real account, no live bus, no real run is ever paused/held/resumed; no GUI.
//
// Fleet (seedFleet): run `ws-ops` (OPS, pause switch ON) ⊃ members m1 (acct-a) m2 (acct-a); an UNRELATED run `ws-xops` ⊃ xm (acct-b).
// Accounts: acct-a (fake token tok-a) and acct-b (tok-b); the fake API answers per token.
//
// `PAUSE_AUTO_REPO=<tree>` runs the SAME script against another source tree (the must-FAIL arm: the E3 base, before this change).
// Run: node --experimental-strip-types --no-warnings --import ./scripts/.r2-register.mjs scripts/e2e-pause-auto.mjs <arm>

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(process.env.PAUSE_AUTO_REPO ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const ARM = process.argv[2] ?? '';
const ARMS = ['limit_pause', 'switch_resume', 'switch_default_login', 'relogin_resume', 'relogin_race', 'quota_back_tick', 'manual_never', 'trap_wait', 'repause', 'remark_no_repause', 'wake_off_no_pause', 'wake_off_nested', 'wake_off_reparented', 'wake_off_after_pause', 'release_clears_marker', 'nudge_throttle', 'usage_newer_wins', 'off_identity', 'hang_selftest'];
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM} (expected: ${ARMS.join(', ')})`); process.exit(2); }
const TICK_MS = 20_000;   // prompt-queue TICK_MS — "one poll tick" (pinned by pause-auto-wiring.test.ts)

// ── SAFETY: scratch under ~/.cache of the REAL home, never near a live dir ──
const REAL_HOME = os.homedir();
const base = path.resolve(process.env.PAUSE_AUTO_RIG_HOME ?? path.join(REAL_HOME, '.cache', 'e2e-pause-auto'));
const tmpHome = path.join(base, ARM);
const live = [path.join(REAL_HOME, '.orchestra'), path.join(REAL_HOME, '.claude'), path.join(REAL_HOME, '.claude-mc'), path.join(REAL_HOME, '.config')];
if (!(tmpHome + path.sep).startsWith(path.join(REAL_HOME, '.cache') + path.sep) || live.some((l) => (tmpHome + path.sep).startsWith(l + path.sep) || l.startsWith(tmpHome + path.sep))) {
  console.error(`SAFETY: refusing scratch path ${tmpHome}`); process.exit(2);
}
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
for (const k of Object.keys(process.env)) if (/^(ORCHESTRA_|CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_|ANTHROPIC_)/.test(k)) delete process.env[k];
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude-scratch');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const stubBin = path.join(tmpHome, 'stub-bin');
fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 'claude'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
process.env.PATH = `${stubBin}:/usr/local/bin:/usr/bin:/bin`;
process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '400';

// ── the fake Anthropic USAGE API (zero tokens, no account). Answers per bearer token; counts hits per token. ──
const hits = {};
const tokenState = new Map();   // token → { limitedUntil: ms | null }
const usageBody = (t) => {
  const reset = (ms) => new Date(ms).toISOString();
  const lim = t?.limitedUntil ?? null;
  return {
    five_hour: { utilization: lim ? 100 : 10, resets_at: reset(lim ?? Date.now() + 3 * 3_600_000) },
    seven_day: { utilization: 20, resets_at: reset(Date.now() + 5 * 86_400_000) },
  };
};
const delayFirst = new Map();   // token → ms: the FIRST request ISSUED with that token answers this late (set by the fetch wrapper, in issue order)
const issued = {};
const server = http.createServer((req, res) => {
  const tok = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
  hits[tok] = (hits[tok] ?? 0) + 1;
  const answer = () => {
    const st = tokenState.get(tok);   // state is read AT ANSWER time: a late answer reflects what changed meanwhile (arm usage_newer_wins)
    if (!st) { res.writeHead(401).end('{}'); return; }
    if (st.fail) { res.writeHead(500).end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(usageBody(st)));
  };
  const late = Number(req.headers['x-rig-delay'] ?? 0);
  if (late > 0) setTimeout(answer, late); else answer();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = (url, init) => {
  const u = String(url instanceof Request ? url.url : url);
  outbound.push(u);
  if (u.startsWith('https://api.anthropic.com/api/oauth/usage')) {
    const tok = /^Bearer (.+)$/.exec(String(init?.headers?.Authorization ?? ''))?.[1] ?? '';
    issued[tok] = (issued[tok] ?? 0) + 1;
    const late = issued[tok] === 1 ? delayFirst.get(tok) ?? 0 : 0;
    return realFetch(u.replace('https://api.anthropic.com', `http://127.0.0.1:${PORT}`), late ? { ...init, headers: { ...init.headers, 'x-rig-delay': String(late) } } : init);
  }
  return Promise.reject(new Error(`rig: outbound fetch refused: ${u}`));
};

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const errorEvents = [];
initPlatform({
  kind: 'headless-e2e-pause-auto',
  broadcast: (channel, wsId, event) => { if (channel === 'agent:event' && event?.type === 'error') errorEvents.push({ wsId, message: String(event.message ?? '') }); },
  broadcastPtyData: () => true, canBroadcast: () => true,
  isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`,
  getAppVersion: () => '0.0.0-e2e-pause-auto', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();   // a missing store.json is only CREATED by the first load…
await store.load?.();   // …the second parses it: `loadedFromDisk` (the trap's and the auto Reprise's "store is real" rule) is true like in the booted app
const busMod = await import(`${REPO}/src/main/bus.ts`);
const busRuns = await import(`${REPO}/src/main/bus-runs.ts`);
const busPause = await import(`${REPO}/src/main/bus-pause.ts`);
const busRecords = await import(`${REPO}/src/main/bus-pause-records.ts`);
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const workspaces = await import(`${REPO}/src/main/workspaces.ts`);
const activity = await import(`${REPO}/src/main/activity.ts`);
const acctUsage = await import(`${REPO}/src/main/account-usage.ts`);
const pq = await import(`${REPO}/src/main/prompt-queue.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);

// the booted app registers the LIVE workspace tree for #255 (pause-trap-host.ts) — the Reprise's coordinators and #256's wake guard read it
const reprisesMod = await import(`${REPO}/src/main/pause-reprise.ts`);
reprisesMod.setLiveTreeSource?.(() => ({ get: (id) => store.getWorkspace(id), ids: () => store.workspaces.filter((w) => !w.archived).map((w) => w.id) }));
busMod.initBus();
const db = busMod.getBus();
if (!db) { console.error('bus failed to open'); process.exit(3); }
if (!String(busMod.busPath()).startsWith(tmpHome)) { console.error(`SAFETY: bus resolved outside scratch: ${busMod.busPath()}`); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const untilOrFail = async (pred, ms = 4000, step = 20) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await pred()) return true; await sleep(step); } return false; };
const ON = { ...DEFAULT_BUS_SWITCHES, pause: true, wake: true, liveness: true };
const OFFSW = { ...DEFAULT_BUS_SWITCHES, wake: true };
const ws = (id) => store.getWorkspace(id);
const run = (id) => db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
const allRuns = () => JSON.stringify(db.prepare('SELECT * FROM runs ORDER BY id').all());
const resumeStarted = (id = 'ws-ops') => run(id)?.resume_started_at ?? null;

// ── fake SDK query: a controllable CLI (no real process). `push(msg)` feeds the newest session. ──
let push = () => {};
let factoryCalls = 0;
sdk.__setQueryFactoryForTests(({ prompt }) => {
  factoryCalls++;
  const pending = [];
  let wake = null;
  push = (...msgs) => { pending.push(...msgs); wake?.(); };
  let firstSeen = () => {};
  const first = new Promise((r) => { firstSeen = r; });
  void (async () => { try { for await (const _m of prompt) firstSeen(); } catch { /* torn down */ } })();
  return {
    async *[Symbol.asyncIterator]() {
      await first;
      yield { type: 'system', subtype: 'init', session_id: 'pa', tools: [], slash_commands: [] };
      for (;;) {
        while (pending.length) yield pending.shift();
        await new Promise((r) => { wake = r; });
      }
    },
    interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {},
    mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
    getContextUsage: async () => { await new Promise(() => {}); },
  };
});
const rateLimitedTurn = (resetsAtSec) => [
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', ...(resetsAtSec ? { resetsAt: resetsAtSec } : {}) } },
  { type: 'result', subtype: 'success', session_id: 'pa', is_error: true, api_error_status: 429, num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: 'You have hit your limit' },
];

const calls = { start: [], send: [] };
let failStart = false;   // a wake that cannot start the session (#74's compensator then RE-MARKS the member)
function useFakeSeam() {
  delivery.registerSdkDelivery({
    hasSession: () => false, hasBackgroundTask: () => false,
    send: async (wsId, text, peer, origin) => { calls.send.push({ wsId, text, origin }); },
    sendAwaitingStart: async (wsId, text, peer, ms, origin) => { calls.send.push({ wsId, text, origin }); return 'started'; },
    start: async (wsId, text, opts) => { calls.start.push({ wsId, text, origin: opts?.origin }); if (failStart) throw new Error('rig: the session cannot start'); },
    stop: async () => {},
  });
}

// ── fleet + accounts ──
const now0 = Date.now();
const mk = (id, extra = {}) => ({ id, name: id, kind: 'scratch', repoPath: '', worktreePath: tmpHome, status: 'idle', createdAt: now0 - 40 * 60_000, ...extra });
const acctDir = (id) => path.join(tmpHome, 'accounts', id);
const writeCreds = (id, token) => {
  fs.mkdirSync(acctDir(id), { recursive: true });
  fs.writeFileSync(path.join(acctDir(id), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: 'r', expiresAt: Date.now() + 86_400_000 } }));
};
async function seed({ pauseSwitch = true, aLimitedMs = 3_600_000, realFlusher = false, wake = true } = {}) {
  writeCreds('acct-a', 'tok-a');
  writeCreds('acct-b', 'tok-b');
  tokenState.set('tok-a', { limitedUntil: aLimitedMs ? Date.now() + aLimitedMs : null });
  tokenState.set('tok-b', { limitedUntil: null });
  await store.setAccounts([{ id: 'acct-a', label: 'A', configDir: acctDir('acct-a') }, { id: 'acct-b', label: 'B', configDir: acctDir('acct-b') }]);
  busRuns.startRun(db, { id: 'ws-ops', kind: 'vague', coordinator: 'ws-ops' }, pauseSwitch ? (wake ? ON : { ...ON, wake: false }) : OFFSW);
  busRuns.startRun(db, { id: 'ws-xops', kind: 'vague', coordinator: 'ws-xops' }, ON);
  await store.upsertWorkspace(mk('ws-ops', { kind: 'orchestrator', accountId: 'acct-a' }));
  await store.upsertWorkspace(mk('ws-m1', { parentId: 'ws-ops', accountId: 'acct-a' }));
  await store.upsertWorkspace(mk('ws-m2', { parentId: 'ws-ops', accountId: 'acct-a' }));
  await store.upsertWorkspace(mk('ws-xops', { kind: 'orchestrator' }));
  await store.upsertWorkspace(mk('ws-xm', { parentId: 'ws-xops', accountId: 'acct-b' }));
  useFakeSeam();
  pq.startPromptQueueFlusher();   // registers the limit-stop observer (the real wiring) AND arms a real 20 s interval
  if (!realFlusher) {
    // deterministic arms: no periodic tick can land mid-arm — ticks are driven by __tickForTests; the observer is re-registered through the host binding
    pq.stopPromptQueueFlusher();
    const host = await import(`${REPO}/src/main/pause-auto-host.ts`).catch(() => null);   // absent on the base ⇒ no observer ⇒ the arms fail honestly
    host?.startPauseAuto();
  }
}
/** The host trap finishing for the current pause (the trap itself is #252's rig): a Bilan row per member (a worker stays BLOCKED until its OPS releases it, so a
 *  Reprise leaves the run RESUMING), then the stamp. */
const trapDone = (id = 'ws-ops') => {
  const at = run(id).paused_at;
  if (at === null || at === undefined) return false;   // nothing paused (the unfixed base never pauses): the arm then FAILS on its assertions instead of crashing
  if (id === 'ws-ops') for (const w of ['ws-m1', 'ws-m2']) busRecords.insertBilan(db, { runId: id, wsId: w, pausedAt: at, activity: { surface: 'none' }, snapshotRef: null, dirty: false, killed: [], error: null });
  return busRecords.markTrapDone(db, id, at);
};
const autoReason = (id = 'ws-ops') => { try { return JSON.parse(run(id).pause_auto); } catch { return null; } };

const out = { arm: ARM };
let ok = false;
const DEADLINE_MS = Number(process.env.PAUSE_RIG_DEADLINE_MS ?? 90_000);
setInterval(() => {}, 1000);
setTimeout(() => { console.log(JSON.stringify({ ...out, ok: false, abort: 'deadline: the arm hung' })); process.exit(1); }, DEADLINE_MS).unref?.();
const rec = (k, v) => { out[k] = v; return v; };

// ═════════════════════════════════════════════════════════════════════════════
if (ARM === 'limit_pause') {
  // THE PRODUCER CHAIN: a structured member's turn dies on the limit (rate_limit_event rejected + 429 result) → markStoppedOnUsageLimit → the observer
  // → Pause DURE of ITS run, tagged auto with the member + its PINNED account. The unrelated run, and the member's own marker, are the controls.
  await seed({ realFlusher: true });   // the REAL startPromptQueueFlusher registers the observer (the only arm that exercises that wiring end to end)
  await sdk.sdkSend('ws-m1', 'work', undefined, undefined, undefined, false, false, 'human');
  await untilOrFail(() => factoryCalls >= 1);
  push(...rateLimitedTurn(Math.round((Date.now() + 3_600_000) / 1000)));
  const paused = await untilOrFail(() => run('ws-ops').paused_at !== null, 6000);
  rec('paused', paused);
  rec('marker', ws('ws-m1')?.lastStopReason ?? null);
  const o = run('ws-ops');
  rec('pausedBy', o.paused_by);
  rec('mode', o.pause_mode);
  rec('trapOwed', o.pause_trap_at === null);
  rec('reason', autoReason());
  rec('xopsPaused', run('ws-xops').paused_at !== null);
  // the pause is REAL for the siblings: an auto wake of m2 is refused, the unrelated member's is not
  const starts0 = calls.start.length;
  const w2 = await workspaces.wakeAgentWithPrompt('ws-m2', 'AUTO');
  const wx = await workspaces.wakeAgentWithPrompt('ws-xm', 'AUTO');
  rec('m2Wake', w2); rec('xmWake', wx); rec('startsAdded', calls.start.length - starts0);
  ok = paused && out.marker === 'usage_limit' && out.pausedBy === 'host:usage_limit' && out.mode === 'hard' && out.trapOwed
    && out.reason?.reason === 'usage_limit' && JSON.stringify(out.reason?.wsIds) === '["ws-m1"]' && JSON.stringify(out.reason?.accountIds) === '["acct-a"]'
    && out.xopsPaused === false && w2 === false && wx === true && out.startsAdded === 1;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'switch_resume') {
  // THE ACCEPTANCE RIG: limit on acct-a (still limited, reset an HOUR away) → the run is paused → a tick does NOT resume it → the human SWITCHES m1
  // to acct-b (quota) via the real migrate → a FORCED fresh reading of acct-b (the <180 s cache is bypassed) and the Reprise starts within ONE poll tick.
  await seed();
  const resetMs = Date.now() + 3_600_000;
  await activity.markStoppedOnUsageLimit('ws-m1', resetMs);                  // the limit stop (the SDK producer is `limit_pause`)
  await acctUsage.refreshAccountsNow();                                      // the pollers' cache: A limited, B quota — both fetched AFTER the stop, inside the 180 s floor
  rec('cacheA', acctUsage.getAccountUsage('acct-a')?.data?.fiveHour?.utilization ?? null);
  rec('cacheB', acctUsage.getAccountUsage('acct-b')?.data?.fiveHour?.utilization ?? null);
  rec('paused', run('ws-ops').paused_at !== null);
  rec('reason', autoReason());
  trapDone();
  await pq.__tickForTests();
  rec('resumedByTickWhileLimited', resumeStarted() !== null);
  const bHits0 = hits['tok-b'] ?? 0;
  const t0 = Date.now();
  const mig = rec('migrate', await workspaces.dispatchMigrateAccountRequest({ id: 'ws-m1', accountId: 'acct-b' }));
  const resumed = await untilOrFail(() => resumeStarted() !== null, TICK_MS + 5000);
  rec('resumed', resumed);
  rec('resumeLatencyMs', Date.now() - t0);
  rec('withinOneTick', resumed && Date.now() - t0 <= TICK_MS);
  rec('forcedFetchOfB', (hits['tok-b'] ?? 0) - bHits0);                      // ≥1: the cached (<180 s) reading was NOT reused
  rec('repinned', ws('ws-m1')?.accountId);
  rec('storedAccount', autoReason()?.accountIds ?? null);
  rec('markerKept', ws('ws-m1')?.lastStopReason ?? null);                    // #74's marker is LEFT: it stays the safety net
  rec('pausedStill', run('ws-ops').paused_at !== null);                      // the Reprise is #255's: it lifts the pause itself once every member is released
  rec('xopsTouched', run('ws-xops').paused_at !== null || run('ws-xops').resume_started_at !== null);
  ok = out.paused && out.resumedByTickWhileLimited === false && mig.ok === true && resumed && out.withinOneTick && out.forcedFetchOfB >= 1
    && out.repinned === 'acct-b' && out.markerKept === 'usage_limit' && out.xopsTouched === false && out.cacheA === 100 && out.cacheB === 10;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'switch_default_login') {
  // The switch TO THE DEFAULT LOGIN (accountId null): the global (default-login) poller has its own cache — it must be FORCED too, not just the per-account one.
  await seed();
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-d', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 } }));
  tokenState.set('tok-d', { limitedUntil: null });                           // the default login has quota
  await activity.markStoppedOnUsageLimit('ws-m1', Date.now() + 3_600_000);
  await acctUsage.refreshAccountsNow();
  rec('paused', run('ws-ops').paused_at !== null);
  trapDone();
  await pq.__tickForTests();
  rec('resumedWhileLimited', resumeStarted() !== null);
  const d0 = hits['tok-d'] ?? 0;
  const t0 = Date.now();
  const mig = rec('migrate', await workspaces.dispatchMigrateAccountRequest({ id: 'ws-m1', accountId: null }));
  const resumed = await untilOrFail(() => resumeStarted() !== null, TICK_MS + 5000);
  rec('resumed', resumed);
  rec('resumeLatencyMs', Date.now() - t0);
  rec('forcedFetchOfDefault', (hits['tok-d'] ?? 0) - d0);
  rec('repinned', ws('ws-m1')?.accountId ?? null);
  ok = out.paused && out.resumedWhileLimited === false && mig.ok === true && resumed && Date.now() - t0 <= TICK_MS && out.forcedFetchOfDefault >= 1 && out.repinned === null;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'relogin_resume') {
  // RE-LOGIN: acct-a is limited; the human re-logs acct-a (a NEW token whose account has quota lands in its config dir) through the REAL
  // accountLoginStart → login watcher → a forced fresh reading of acct-a → the paused run Reprises at once.
  await seed();
  await activity.markStoppedOnUsageLimit('ws-m1', Date.now() + 3_600_000);
  await acctUsage.refreshAccountsNow();
  rec('paused', run('ws-ops').paused_at !== null);
  trapDone();
  await pq.__tickForTests();
  rec('resumedWhileLimited', resumeStarted() !== null);
  const { apiHandlers } = await import(`${REPO}/src/main/api-handlers.ts`);
  await apiHandlers.accountLoginStart('acct-a', 80, 24);
  tokenState.set('tok-a2', { limitedUntil: null });                          // the NEW login's account has quota
  const hits0 = hits['tok-a2'] ?? 0;
  const t0 = Date.now();
  writeCreds('acct-a', 'tok-a2');                                            // `claude /login` completing
  const resumed = await untilOrFail(() => resumeStarted() !== null, TICK_MS + 5000);
  rec('resumed', resumed);
  rec('resumeLatencyMs', Date.now() - t0);
  rec('forcedFetchOfNewToken', (hits['tok-a2'] ?? 0) - hits0);
  ok = out.paused && out.resumedWhileLimited === false && resumed && Date.now() - t0 <= TICK_MS && out.forcedFetchOfNewToken >= 1;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'quota_back_tick') {
  // NO switch: the quota returns on its own (the reset). The poller's next reading shows quota → ONE flusher tick later the run Reprises —
  // even though the stored reset time (an hour away) says "wait" (#74 alone waits for it).
  await seed();
  await activity.markStoppedOnUsageLimit('ws-m1', Date.now() + 3_600_000);
  await acctUsage.refreshAccountsNow();
  trapDone();
  await pq.__tickForTests();
  rec('beforeQuota', resumeStarted() !== null);
  tokenState.set('tok-a', { limitedUntil: null });                           // quota is back (well before the stored reset)
  await acctUsage.refreshAccountsNow({ force: ['acct-a'] });                 // the poller's cycle (its 180 s floor is not what is under test)
  rec('beforeTick', resumeStarted() !== null);
  await pq.__tickForTests();
  rec('afterOneTick', resumeStarted() !== null);
  rec('storedResetStillAhead', (ws('ws-m1')?.usageLimitResetsAt ?? 0) > Date.now() + 3_000_000 || ws('ws-m1')?.usageLimitResetsAt === undefined);
  ok = out.beforeQuota === false && out.beforeTick === false && out.afterOneTick === true;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'manual_never') {
  // A MANUAL pause is never auto-resumed: quota everywhere, ticks, an account switch and a re-login — pause_auto stays NULL, resume never starts.
  // A limit stop under the manual pause does not turn it into an auto one.
  await seed({ aLimitedMs: 0 });
  rec('pauseResult', busPause.setRunPause(db, 'ws-ops', true, 'ws-ops'));
  trapDone();
  await activity.markStoppedOnUsageLimit('ws-m1', Date.now() + 3_600_000);   // a limit stop UNDER the manual pause
  rec('autoAfterLimit', run('ws-ops').pause_auto);
  await acctUsage.refreshAccountsNow();
  await pq.__tickForTests();
  await pq.__tickForTests();
  await workspaces.dispatchMigrateAccountRequest({ id: 'ws-m1', accountId: 'acct-b' });
  await sleep(600);
  await pq.__tickForTests();
  const { apiHandlers } = await import(`${REPO}/src/main/api-handlers.ts`);
  await apiHandlers.accountLoginStart('acct-b', 80, 24);
  tokenState.set('tok-b2', { limitedUntil: null });
  writeCreds('acct-b', 'tok-b2');
  await sleep(1800);
  await pq.__tickForTests();
  rec('resume', resumeStarted());
  rec('pausedBy', run('ws-ops').paused_by);
  rec('stillPaused', run('ws-ops').paused_at !== null);
  // control: the lift is the human's — and works
  rec('lift', busPause.setRunPause(db, 'ws-ops', false, 'ws-ops'));
  ok = out.pauseResult === 'paused' && out.autoAfterLimit === null && out.resume === null && out.pausedBy === 'ws-ops' && out.stillPaused && out.lift === 'lifted';

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'trap_wait') {
  // The Reprise waits for the host trap (the Bilans are the Consigne's source): quota is back but pause_trap_at is still NULL → no Reprise; stamped → Reprise.
  await seed({ aLimitedMs: 0 });
  await activity.markStoppedOnUsageLimit('ws-m1', Date.now() + 3_600_000);
  await acctUsage.refreshAccountsNow();
  rec('paused', run('ws-ops').paused_at !== null);
  await pq.__tickForTests();
  rec('whileTrapOwed', resumeStarted() !== null);
  trapDone();
  await pq.__tickForTests();
  rec('afterTrap', resumeStarted() !== null);
  ok = out.paused && out.whileTrapOwed === false && out.afterTrap === true;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'repause') {
  // The Reprise started (quota back) and ANOTHER member then hits the limit: the run goes back to PAUSED in a NEW epoch (trap owed), not a silent half-resume.
  await seed({ aLimitedMs: 0 });
  await activity.markStoppedOnUsageLimit('ws-m1', Date.now() + 3_600_000);
  await acctUsage.refreshAccountsNow();
  trapDone();
  const pausedAt = run('ws-ops').paused_at;
  await pq.__tickForTests();
  rec('resuming', resumeStarted() !== null);
  await activity.markStoppedOnUsageLimit('ws-m2', Date.now() + 3_600_000);
  const o = run('ws-ops');
  rec('backToPaused', o.resume_started_at === null && o.pause_trap_at === null && o.paused_at > pausedAt);   // a NEW epoch: the trap really runs again (#255)
  rec('reason', autoReason());
  rec('epochCarried', autoReason()?.epoch === o.paused_at);
  // FLAP GUARD: quota readings are back and the trap stamped, but the run was just Reprised and limited again — it waits (5 min), it does not loop pause → trap → Reprise
  await acctUsage.refreshAccountsNow({ force: ['acct-a'] });
  trapDone();
  await pq.__tickForTests();
  rec('reprisedAgainAtOnce', resumeStarted() !== null);
  ok = out.resuming === true && out.backToPaused === true && JSON.stringify(out.reason?.wsIds) === '["ws-m1","ws-m2"]' && out.epochCarried === true && out.reprisedAgainAtOnce === false;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'relogin_race') {
  // Two refreshes overlap at a re-login (the handler's plain `refreshAccountsNow()` and the forced one) and the OLDER lands LAST: it must not replace the newer
  // reading in the cache (else the forced reading reads as "taken for the old login" at the next tick). The trap is still owed at the re-login, so the
  // decision is taken at a LATER tick — after the late response landed.
  await seed();
  await activity.markStoppedOnUsageLimit('ws-m1', Date.now() + 3_600_000);
  await acctUsage.refreshAccountsNow();
  fs.mkdirSync(acctDir('acct-a'), { recursive: true });
  fs.writeFileSync(path.join(acctDir('acct-a'), '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-a-old', refreshToken: 'r', expiresAt: Date.now() - 3_600_000 } }));
  await acctUsage.refreshAccountsNow();                                       // the login EXPIRED: status {ok:false, expired}, so the next plain refresh DOES fetch
  rec('expired', acctUsage.getAccountUsage('acct-a')?.expired === true);
  rec('paused', run('ws-ops').paused_at !== null);
  const { apiHandlers } = await import(`${REPO}/src/main/api-handlers.ts`);
  await apiHandlers.accountLoginStart('acct-a', 80, 24);
  tokenState.set('tok-a2', { limitedUntil: null });                          // the new login has quota
  delayFirst.set('tok-a2', 700);                                             // the FIRST request issued (the plain refresh) answers 700 ms late ⇒ it lands LAST
  writeCreds('acct-a', 'tok-a2');                                            // `claude /login` completing
  await untilOrFail(() => (hits['tok-a2'] ?? 0) >= 2, 4000);
  await sleep(1500);                                                         // both responses landed, the late plain one last
  rec('hits', hits['tok-a2'] ?? 0);
  rec('reprisedBeforeTrap', resumeStarted() !== null);
  trapDone();
  await pq.__tickForTests();
  rec('reprisedAtTickAfterTrap', resumeStarted() !== null);
  ok = out.expired && out.paused && out.hits === 2 && out.reprisedBeforeTrap === false && out.reprisedAtTickAfterTrap === true;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'remark_no_repause') {
  // #74's own failed-wake RE-MARK is not a new limit: the compensator re-marks the member and must NOT pause its run. Control in the same arm: a REAL limit stop does.
  await seed({ aLimitedMs: 0 });
  await activity.markStoppedOnUsageLimit('ws-m1', Date.now() - 60_000, { remark: true });   // a marker without a "new limit" (the reset has already passed)
  await sleep(25);                                                           // a reading must be fetched STRICTLY after the marker (canAutoFlushQueue)
  await acctUsage.refreshAccountsNow();                                      // a reading fetched after the marker: #74 will try to wake m1
  rec('pausedBefore', run('ws-ops').paused_at !== null);
  failStart = true;
  const starts0 = calls.start.length;
  await pq.__tickForTests();
  failStart = false;
  rec('wakeAttempts', calls.start.length - starts0);
  rec('markerRestored', ws('ws-m1')?.lastStopReason ?? null);               // the compensator re-marked
  rec('pausedByRemark', run('ws-ops').paused_at !== null);
  await activity.markStoppedOnUsageLimit('ws-m2', Date.now() + 3_600_000);  // control: a REAL stop
  rec('pausedByRealStop', run('ws-ops').paused_at !== null);
  ok = out.pausedBefore === false && out.wakeAttempts === 1 && out.markerRestored === 'usage_limit' && out.pausedByRemark === false && out.pausedByRealStop === true;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'wake_off_no_pause') {
  // M1: `pause` and `wake` are independent frozen opt-ins. With wake OFF a Reprise's bus rows wake nobody and #74's nudge is refused by the pause — the fleet would stall
  // for good. So NO auto Pause: a limit stop writes nothing (= master). Control in the same arm: a run with wake ON pauses.
  await seed({ wake: false });
  const runsBefore = allRuns();
  await activity.markStoppedOnUsageLimit('ws-m1', Date.now() + 3_600_000);
  rec('runsIdentical', allRuns() === runsBefore);
  rec('pausedOps', run('ws-ops').paused_at !== null);
  await activity.markStoppedOnUsageLimit('ws-xm', Date.now() + 3_600_000);   // control: ws-xops has pause + wake ON
  rec('pausedControl', run('ws-xops').paused_at !== null);
  ok = out.runsIdentical === true && out.pausedOps === false && out.pausedControl === true;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'wake_off_nested') {
  // N1: the Reprise sends a row to a coordinator in EVERY run of the subtree and the DEEPER run's frozen wake governs its delivery. A child OPS run with pause OFF / wake OFF under
  // a pause+wake ON carrier would never be woken: the auto Pause must not land (nothing written). Control: the unrelated wake-ON run pauses.
  await seed();
  busRuns.startRun(db, { id: 'ws-sub', kind: 'vague', coordinator: 'ws-sub', parentRunId: 'ws-ops' }, { ...DEFAULT_BUS_SWITCHES, pause: false, wake: false });
  await store.upsertWorkspace(mk('ws-sub', { kind: 'orchestrator', parentId: 'ws-ops', accountId: 'acct-a' }));
  await store.upsertWorkspace(mk('ws-m3', { parentId: 'ws-sub', accountId: 'acct-a' }));
  const runsBefore = allRuns();
  await activity.markStoppedOnUsageLimit('ws-m3', Date.now() + 3_600_000);
  rec('runsIdentical', allRuns() === runsBefore);
  rec('pausedCarrier', run('ws-ops').paused_at !== null);
  await activity.markStoppedOnUsageLimit('ws-xm', Date.now() + 3_600_000);   // control
  rec('pausedControl', run('ws-xops').paused_at !== null);
  ok = out.runsIdentical === true && out.pausedCarrier === false && out.pausedControl === true;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'wake_off_reparented') {
  // R3-1: the guard follows what the Reprise ADDRESSES (live tree first), not the write-once bus subtree: an OPS created top-level (bus parent_run_id NULL, wake OFF) and then ATTACHED
  // under the carrier in the live tree would never be woken by the Reprise — no auto Pause. Control in the same arm: the same OPS with wake ON lets the pause land.
  await seed();
  busRuns.startRun(db, { id: 'ws-att', kind: 'vague', coordinator: 'ws-att' }, { ...DEFAULT_BUS_SWITCHES, pause: false, wake: false });   // top-level run, wake OFF
  await store.upsertWorkspace(mk('ws-att', { kind: 'orchestrator', accountId: 'acct-a' }));
  await store.upsertWorkspace(mk('ws-attm', { parentId: 'ws-att', accountId: 'acct-a' }));
  await store.upsertWorkspace({ ...ws('ws-att'), parentId: 'ws-ops' });                                  // the human ATTACHES it under the carrier
  const runsBefore = allRuns();
  await activity.markStoppedOnUsageLimit('ws-attm', Date.now() + 3_600_000);
  rec('runsIdentical', allRuns() === runsBefore);
  rec('pausedCarrier', run('ws-ops').paused_at !== null);
  await activity.markStoppedOnUsageLimit('ws-m1', Date.now() + 3_600_000);   // control: a member that is NOT below the attached OPS… still blocked (the OPS is an addressee of the carrier)
  rec('pausedByOtherMember', run('ws-ops').paused_at !== null);
  busRuns.startRun(db, { id: 'ws-att2', kind: 'vague', coordinator: 'ws-att2' }, { ...DEFAULT_BUS_SWITCHES, pause: false, wake: true });   // control arm: wake ON
  await store.upsertWorkspace(mk('ws-att2', { kind: 'orchestrator', parentId: 'ws-xops', accountId: 'acct-b' }));
  await store.upsertWorkspace(mk('ws-att2m', { parentId: 'ws-att2', accountId: 'acct-b' }));
  await activity.markStoppedOnUsageLimit('ws-att2m', Date.now() + 3_600_000);
  rec('pausedControl', run('ws-xops').paused_at !== null);
  ok = out.runsIdentical === true && out.pausedCarrier === false && out.pausedByOtherMember === false && out.pausedControl === true;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'wake_off_after_pause') {
  // The addressees are re-read at the auto-Reprise: a wake-OFF OPS attached AFTER the pause HOLDS the Reprise (no row nobody receives): warned + ONE escalation to the carrier's
  // coordinator, run stays PAUSED; detaching it lets the next tick Reprise.
  await seed({ aLimitedMs: 0 });
  await activity.markStoppedOnUsageLimit('ws-m1', Date.now() + 3_600_000);
  await sleep(25);
  await acctUsage.refreshAccountsNow();
  rec('paused', run('ws-ops').paused_at !== null);
  trapDone();
  busRuns.startRun(db, { id: 'ws-late', kind: 'vague', coordinator: 'ws-late' }, { ...DEFAULT_BUS_SWITCHES, pause: false, wake: false });
  await store.upsertWorkspace(mk('ws-late', { kind: 'orchestrator', parentId: 'ws-ops', accountId: 'acct-a' }));
  await pq.__tickForTests();
  await pq.__tickForTests();
  rec('resumedWhileHeld', resumeStarted() !== null);
  const esc = db.prepare("SELECT recipient, run_id FROM messages WHERE kind = 'escalation'").all();
  rec('escalations', esc.map((e) => `${e.recipient}@${e.run_id}`));
  await store.upsertWorkspace({ ...ws('ws-late'), parentId: undefined });                               // detached
  await pq.__tickForTests();
  rec('resumedAfterDetach', resumeStarted() !== null);
  ok = out.paused && out.resumedWhileHeld === false && JSON.stringify(out.escalations) === '["ws-ops@ws-ops"]' && out.resumedAfterDetach === true;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'release_clears_marker') {
  // m1: a member sent its Reprise row (the coordinator's Bilan at beginReprise, a worker's Consigne at `run release`) loses its #74 marker BEFORE #74's candidates are read —
  // else the generic nudge (429 path: reset unknown, fresh reading ⇒ nudge at once) wakes it a SECOND time next to the Consigne.
  await seed({ aLimitedMs: 0 });
  await activity.markStoppedOnUsageLimit('ws-m1', null);      // worker trigger, 429 path (no reset time)
  await activity.markStoppedOnUsageLimit('ws-ops', null);     // the OPS itself (coordinator trigger), merged into the same pause
  await sleep(25);
  await acctUsage.refreshAccountsNow();                       // readings fetched AFTER both markers
  rec('paused', run('ws-ops').paused_at !== null);
  rec('reason', autoReason()?.wsIds ?? null);
  trapDone();
  const starts0 = calls.start.length;
  await pq.__tickForTests();                                  // evaluate → beginReprise (coordinator row) → marker of ws-ops cleared → #74 sees no candidate for it
  rec('resuming', resumeStarted() !== null);
  rec('opsMarker', ws('ws-ops')?.lastStopReason ?? null);
  rec('m1MarkerBlocked', ws('ws-m1')?.lastStopReason ?? null);
  rec('startsAfterReprise', calls.start.length - starts0);
  let released = null;
  try {
    const reprise = await import(`${REPO}/src/main/pause-reprise.ts`);
    released = reprise.releaseMembers(db, 'ws-ops', 'ws-ops', ['ws-m1'])?.released ?? null;   // the OPS releases m1: its Consigne is sent
  } catch (e) { released = String(e); }
  rec('released', released);
  await pq.__tickForTests();                                  // m1 may start now AND would be nudged by #74 — unless its marker is gone first
  rec('m1MarkerAfterRelease', ws('ws-m1')?.lastStopReason ?? null);
  rec('startsAfterRelease', calls.start.length - starts0);
  ok = out.paused && JSON.stringify(out.reason) === '["ws-m1","ws-ops"]' && out.resuming && out.opsMarker === null && out.m1MarkerBlocked === 'usage_limit' && out.startsAfterReprise === 0
    && JSON.stringify(out.released) === '["ws-m1"]' && out.m1MarkerAfterRelease === null && out.startsAfterRelease === 0;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'nudge_throttle') {
  // m2: a reset that is unknown / passed with NO conclusive reading asks the poller for one — at most once per 120 s per account (a failed status is never "fresh": without the
  // throttle every 20 s tick would hit the usage endpoint).
  await seed({ aLimitedMs: 0 });
  tokenState.set('tok-a', { limitedUntil: null, fail: true });   // acct-a's usage endpoint answers 500
  await activity.markStoppedOnUsageLimit('ws-m1', null);         // reset unknown ⇒ refresh wanted every tick
  await sleep(25);
  await acctUsage.refreshAccountsNow();                           // acct-a: a FAILED status (data null)
  rec('failedStatus', acctUsage.getAccountUsage('acct-a')?.ok === false);
  trapDone();
  await sleep(150);
  const h0 = hits['tok-a'] ?? 0;
  for (let i = 0; i < 3; i++) { await pq.__tickForTests(); await sleep(250); }
  rec('fetchesOver3Ticks', (hits['tok-a'] ?? 0) - h0);
  rec('resumed', resumeStarted() !== null);
  ok = out.failedStatus === true && out.fetchesOver3Ticks === 1 && out.resumed === false;

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'usage_newer_wins') {
  // m3: the default-login poller — a plain poll ISSUED BEFORE a forced `refreshUsageNow` lands AFTER it and must not replace its snapshot (ordered by issue sequence).
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-d', refreshToken: 'r', expiresAt: Date.now() + 86_400_000 } }));
  tokenState.set('tok-d', { limitedUntil: null });
  delayFirst.set('tok-d', 600);                                   // the FIRST request issued (the plain poll) answers 600 ms late
  const usageMod = await import(`${REPO}/src/main/usage.ts`);
  if (typeof usageMod.refreshUsageNow !== 'function') { out.error = 'no refreshUsageNow (unfixed base)'; ok = false; }
  else {
    usageMod.startUsagePolling();                                  // plain poll #1 (issued first, answered late)
    await usageMod.refreshUsageNow();                              // forced poll #2 (answered at once, quota)
    rec('forcedSnapshot', usageMod.getLastUsage()?.fiveHour?.utilization ?? null);
    tokenState.set('tok-d', { limitedUntil: Date.now() + 3_600_000 });   // the late answer is computed NOW: it says "limited"
    await sleep(1300);
    rec('afterLateAnswer', usageMod.getLastUsage()?.fiveHour?.utilization ?? null);
    ok = out.forcedSnapshot === 10 && out.afterLateAnswer === 10;
  }

// ═════════════════════════════════════════════════════════════════════════════
} else if (ARM === 'off_identity') {
  // SWITCH OFF ⇒ identical to today: a limit stop writes NO pause column, a tick adds no usage fetch and no Reprise, an account switch forces NOTHING
  // (the fake API's hit counters do not move), and #74 still waits for the stored reset time although a fresh reading shows quota (the master behaviour).
  await seed({ pauseSwitch: false, aLimitedMs: 0 });                         // acct-a has QUOTA
  const runsBefore = allRuns();
  await activity.markStoppedOnUsageLimit('ws-m1', Date.now() + 3_600_000);   // limit stop, reset an hour away
  await acctUsage.refreshAccountsNow();
  rec('runsIdentical', allRuns() === runsBefore);
  const startsBefore = calls.start.length;
  await pq.__tickForTests();
  rec('nudged', calls.start.length - startsBefore);                          // #74: reset not passed ⇒ wait (even though a fresh reading shows quota)
  rec('markerKept', ws('ws-m1')?.lastStopReason === 'usage_limit');
  const bBefore = hits['tok-b'] ?? 0, aBefore = hits['tok-a'] ?? 0;
  await workspaces.dispatchMigrateAccountRequest({ id: 'ws-m1', accountId: 'acct-b' });
  await sleep(500);
  await pq.__tickForTests();
  rec('forcedFetches', { a: (hits['tok-a'] ?? 0) - aBefore, b: (hits['tok-b'] ?? 0) - bBefore });
  rec('runsIdenticalAfterSwitch', allRuns() === runsBefore);
  ok = out.runsIdentical && out.nudged === 0 && out.markerKept && out.forcedFetches.a === 0 && out.runsIdenticalAfterSwitch
    // the migrate's own (non-forcing) refresh may fetch B once — never more than that
    && out.forcedFetches.b <= 1;

} else if (ARM === 'hang_selftest') {
  await new Promise(() => {});
  ok = true;   // unreachable — if this ever printed ok:true the safety net is broken

} else {
  out.error = `arm not implemented yet: ${ARM}`;
}

out.outboundNonLocal = outbound.filter((u) => !u.startsWith('https://api.anthropic.com/api/oauth/usage'));
out.ok = ok && out.outboundNonLocal.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
