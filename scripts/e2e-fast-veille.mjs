// #288 (wave G, ledger #295; epic #284 Testing "Seam 1") — FAST VEILLE: while Admission is held, an idle FLEET member (has a coordinator) goes into
// Veille at the next sweep instead of waiting out its 5-min idle threshold; every other Veille guard still spares it.
// Driven through the REAL sweeper (`sweepHibernation` / `startHibernationSweeper`), the REAL guard (memory-guard.ts: held/reopened edges, hysteresis,
// toggle), REAL sessions (agent-sdk + sdk-delivery) over a STUB CLI, the REAL store and `applyAgentEvent` activity funnel. The ONLY fakes: the
// MemAvailable number (the guard's injectable source), the clock (`Date.now` skew, the sweeper reads it directly) and the stub CLI standing in for
// `claude`. The 5-min default is the SHIPPED one (env override deleted) — a "1 min idle" arm measures the real threshold, not a knob.
//
// SAFETY (D4): scratch ORCHESTRA_HOME + HOME + CLAUDE_CONFIG_DIR under ~/.cache (btrfs), refused anywhere near a live ~/.orchestra / ~/.claude*;
// no live bus, no network, no real run is paused/held/resumed, no `claude` is ever launched. One arm per process (module state is global); no arg = all.
//
// Fleet: every arm builds its members through the real start path (one answered turn, then "the user has seen it") — members carry `parentId`
// (a coordinator) unless the arm says otherwise. Guard arms run TWO members, A (guarded) and B (clean control): under the hold B must go and A must
// stay, so a "spared" can never be a vacuous instrument and "B goes" proves the same sweep CAN hibernate.
//
//   open_waits       CONTROL (green on master) Admission open: a fleet member idle 1 min is NOT hibernated; at 6 min it is, and the log line is the plain one
//   held_veille      ★ must-FAIL on master  open → no Veille at 1 min; Admission becomes held → the SAME members go at the first sweep: stopped, session id and
//                      transcript kept, `hibernatedAt` set, the log names MemAvailable; a top-level member idle as long is spared; the next send resumes by id
//   held_mixed       ★ under the hold a member already past its threshold goes WITHOUT the "fast Veille" mark, one idle 1 min goes WITH it
//   reopen_waits     ★ held then reopened (hysteresis) → the hold stops acting: a member idle 1 min waits again
//   toggle_off       ★ the global toggle OFF (guard state `held`, nothing HELD) → no fast Veille
//   guard_turn       ★ a turn in flight (status running) spares the member while held
//   guard_pending_prompt ★ an undelivered prompt spares it         guard_loop ★ a /loop spares it           guard_bg_task ★ a live background task spares it
//   guard_active_pane ★ the active pane spares it                  guard_run_pty ★ a live `<ws>:run` PTY spares it   guard_waiting ★ status `waiting` spares it
//   no_coordinator   ★ a session without a coordinator is not affected (while its fleet sibling goes)
//   edge_sweep       ★ must-FAIL on master  the real sweeper started (periodic cadence set to 1 h): the guard sample that HOLDS Admission sweeps NOW, not at the next tick
//   boot_held        ★ must-FAIL on master  the sweeper started while Admission is ALREADY held → one sweep at boot (subscribe first, then reconcile)
//   late_idler       ★ must-FAIL on the merged tip (#288 review F1)  a member that goes idle AFTER the held edge sleeps at the NEXT guard sample, no tick, no edge
//   samples_quiet    CONTROL  samples with Admission open — or held with the toggle OFF — never run a sweep (a member past its threshold waits for the tick)
//   overlap_probe    ★ (#288 seat-1 MINOR)  a 2nd pass starting while pass 1 is mid-stop of X never re-takes X (rests on `sdkHasSession` excluding a stopping session)
//   overlap_same_tick ★ (#288 follow-up review m2)  two passes started in the SAME tick (a held sample + the tick) take a member once: nothing yields between the live check and the stopping mark
//   reopen_mid_pass  ★ the hold ENDS while a pass is still stopping its first member → the members after it are spared (the hold is read per member)
//
// Run all: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-fast-veille.mjs   (RIG_REPO=<tree> = the must-FAIL run on master)

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.RIG_REPO ?? path.join(HERE, '..'));
const ARM = process.argv[2] ?? '';
const ARMS = ['open_waits', 'held_veille', 'held_mixed', 'reopen_waits', 'toggle_off', 'guard_turn', 'guard_pending_prompt', 'guard_loop', 'guard_bg_task', 'guard_active_pane', 'guard_run_pty', 'guard_waiting', 'no_coordinator', 'edge_sweep', 'boot_held', 'reopen_mid_pass', 'late_idler', 'samples_quiet', 'overlap_probe', 'overlap_same_tick', 'toggle_off_census', 'reopen_census', 'overlap_post_verdict'];
const GIB = 1024 ** 3;
const MIN = 60_000;

if (!ARM) {
  const rows = [];
  const only = process.env.RIG_ARMS ? new Set(process.env.RIG_ARMS.split(',')) : null;   // the mutant harness runs only the arms a mutant names
  for (const arm of ARMS) {
    if (only && !only.has(arm)) continue;
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', pathToFileURL(path.join(HERE, '.r2-register.mjs')).href, fileURLToPath(import.meta.url), arm], { env: { ...process.env }, encoding: 'utf8', timeout: 150_000 });
    const lastJson = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{') && l.includes('"arm"'));
    let v = null;
    try { v = lastJson ? JSON.parse(lastJson) : null; } catch { /* below */ }
    rows.push({ arm, ok: v?.ok === true, detail: v ? (v.ok ? '' : v.why ?? v.abort ?? '') : `no verdict (exit ${r.status}) ${(r.stderr ?? '').split('\n').slice(-3).join(' ')}` });
  }
  for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.arm}${r.detail ? ` — ${r.detail}` : ''}`);
  const red = rows.filter((r) => !r.ok);
  console.log(`FAST-VEILLE RIG: ${red.length === 0 ? 'ALL PASS' : `RED ${red.map((r) => r.arm).join(',')}`} (${rows.length - red.length}/${rows.length}) tree ${REPO}`);
  process.exit(red.length === 0 ? 0 : 1);
}
if (!ARMS.includes(ARM)) { console.error(`unknown arm: ${ARM} (expected: ${ARMS.join(', ')})`); process.exit(2); }

// ── SAFETY ──
const REAL_HOME = os.homedir();
const base = path.resolve(process.env.FAST_VEILLE_RIG_HOME ?? path.join(REAL_HOME, '.cache', 'e2e-fast-veille'));
const tmpHome = path.join(base, ARM);
const liveDirs = [path.join(REAL_HOME, '.orchestra'), path.join(REAL_HOME, '.claude'), path.join(REAL_HOME, '.claude-mc'), path.join(REAL_HOME, '.config')];
if (!(tmpHome + path.sep).startsWith(path.join(REAL_HOME, '.cache') + path.sep) || liveDirs.some((l) => (tmpHome + path.sep).startsWith(l + path.sep) || l.startsWith(tmpHome + path.sep))) {
  console.error(`SAFETY: refusing scratch path ${tmpHome}`); process.exit(2);
}
fs.rmSync(tmpHome, { recursive: true, force: true });
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
for (const k of Object.keys(process.env)) if (/^(ORCHESTRA_|CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete process.env[k];   // the SHIPPED 5-min default, never an inherited knob
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude');
if (ARM.startsWith('edge_') || ARM === 'boot_held') process.env.ORCHESTRA_HIBERNATE_SWEEP_MS = String(3_600_000);   // the periodic tick can never be what sweeps in these arms

const out = { arm: ARM, tree: REPO };
const fails = [];
let cleanup = () => {};
const verdict = (extra = {}) => { try { cleanup(); } catch { /* best effort */ } console.log(JSON.stringify({ ...out, ...extra, ok: fails.length === 0, ...(fails.length ? { why: fails.join(' | ') } : {}) })); process.exit(fails.length === 0 ? 0 : 1); };
setInterval(() => {}, 1000);   // a hung await must end as a RED verdict at the deadline, never a silent exit
setTimeout(() => { fails.push('deadline: the arm hung'); verdict(); }, 100_000).unref?.();
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, got, want) { const ok = eq(got, want); out[name] = got; if (!ok) fails.push(`${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realNow = Date.now.bind(Date);
let skewMs = 0;
Date.now = () => realNow() + skewMs;
const until = async (pred, ms = 8000, step = 25) => { const t0 = realNow(); while (realNow() - t0 < ms) { if (await pred()) return true; await sleep(step); } return false; };

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
const events = [];
initPlatform({
  kind: 'headless-e2e-fast-veille',
  broadcast: (channel, wsId, event) => { if (channel === 'agent:event' && event) events.push({ wsId, ev: event }); },
  broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`, getAppVersion: () => '0.0.0-e2e-fast-veille', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const logger = await import(`${REPO}/src/main/logger.ts`);
logger.initLogger();
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const hib = await import(`${REPO}/src/main/hibernation.ts`);
const act = await import(`${REPO}/src/main/activity.ts`);
const pty = await import(`${REPO}/src/main/pty.ts`);
const hn = await import(`${REPO}/src/main/hibernation-activity.ts`);
const guardMod = await import(`${REPO}/src/main/memory-guard.ts`);
const guardShared = await import(`${REPO}/src/shared/memory-guard.ts`);
const { shouldHibernate, resolveHibernateAfterMs } = await import(`${REPO}/src/shared/hibernation.ts`);

// ── the memory source + the REAL guard on it ──
let mem = 12;                                   // GB the fake MemAvailable source reports
guardMod.setMemoryGuardSettingsReader(() => store.getMemoryGuardSettings());
const guard = guardMod.__rebuildMemoryGuardForTests({ schedule: () => ({}), cancel: () => {} }, () => mem * GIB);
guard.start();
const holding = () => guardShared.isAdmissionHolding(guardMod.getMemoryGuardSnapshot());
function setMem(gb) { mem = gb; return guard.sampleNow(); }
setMem(12);
if (holding()) { console.error('rig fault: guard held at 12 GB'); process.exit(2); }

// ── stub CLI: one `result` per consumed prompt, per workspace (keyed by the session's cwd); a held turn never results ──
const mangle = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const wsByCwd = new Map();                      // worktreePath → ws id
const callsByWs = new Map();                    // ws id → [call]
const sessId = (id) => `sess-${id}`;
const transcriptFile = (id) => path.join(tmpHome, '.claude', 'projects', mangle(path.join(tmpHome, 'wt', id)), `${sessId(id)}.jsonl`);
const appendTranscript = (id, obj) => { fs.mkdirSync(path.dirname(transcriptFile(id)), { recursive: true }); fs.appendFileSync(transcriptFile(id), JSON.stringify(obj) + '\n'); };
const transcriptSha = (id) => { try { return crypto.createHash('sha256').update(fs.readFileSync(transcriptFile(id))).digest('hex').slice(0, 16); } catch { return null; } };
sdk.__setQueryFactoryForTests(({ prompt, options }) => {
  const id = wsByCwd.get(options?.cwd);
  const list = callsByWs.get(id) ?? [];
  callsByWs.set(id, list);
  const call = { n: list.length + 1, resume: options?.resume, hold: false, interruptDelay: 0, interruptStartedAt: 0, interrupts: 0, ended: false, poke: () => {}, inject: [] };
  list.push(call);
  const queue = [];
  let poke = () => {};
  call.poke = () => poke();
  void (async () => {
    try {
      for await (const m of prompt) {
        appendTranscript(id, { type: 'user', call: call.n, content: m?.message?.content ?? '' });
        queue.push(m); poke();
      }
    } catch { /* torn down; expected */ }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'init', session_id: sessId(id), tools: [], slash_commands: [] };
      while (!call.ended) {
        if (call.inject.length) { yield call.inject.shift(); continue; }
        if (!queue.length) { await new Promise((r) => { poke = r; }); continue; }
        queue.shift();
        if (call.hold) await new Promise((r) => { call.releaseHold = r; });   // a turn that never ends — unless the arm calls releaseHold()
        appendTranscript(id, { type: 'assistant', call: call.n, content: `answer ${call.n}` });
        yield { type: 'result', subtype: 'success', session_id: sessId(id), is_error: false, num_turns: 1, duration_ms: 1, total_cost_usd: 0, result: `answer ${call.n}` };
      }
    },
    interrupt: async () => { call.interrupts += 1; call.interruptStartedAt ||= realNow(); await sleep(call.interruptDelay); call.ended = true; poke(); },
    setModel: async () => {}, setPermissionMode: async () => {}, mcpServerStatus: async () => ({}), supportedCommands: async () => [], supportedModels: async () => [],
    getContextUsage: async () => { await new Promise(() => {}); },
  };
});

// What the CLI's hooks would feed the spool tailer, through the same funnel (the stub has no hooks).
let seenEvents = 0;
setInterval(() => {
  for (; seenEvents < events.length; seenEvents++) {
    const { wsId, ev } = events[seenEvents];
    if (ev.type === 'user-message' && !ev.queued) act.applyAgentEvent(wsId, 'submit', undefined);
    if (ev.type === 'turn-end') act.applyAgentEvent(wsId, 'stop', undefined);
  }
}, 10);

const wsOf = (id) => store.getWorkspace(id);
const live = (id) => delivery.sdkSessionLive(id);
const turnEnds = (id) => events.filter((e) => e.wsId === id && e.ev.type === 'turn-end').length;
const interrupted = (id) => (callsByWs.get(id) ?? []).reduce((n, c) => n + c.interrupts, 0);
const logText = () => { try { return fs.readFileSync(logger.getLogFile(), 'utf8'); } catch { return ''; } };
const veilleLines = (id) => logText().split('\n').filter((l) => l.includes(`hibernating `) && l.includes(`(${id})`));
// Would the member be eligible if it had been idle forever, with Admission OPEN? True ⇒ only recency (or the guard under test) stands between it and Veille.
const eligibleIfOld = (id, over = {}) => shouldHibernate(wsOf(id), {
  now: Date.now(), lastActivityAt: 0, isActive: false, hasLivePty: false, hasLiveSdk: true, hasLiveRunPty: false,
  hasLiveBackgroundTask: false, thresholdMs: resolveHibernateAfterMs(undefined), monotonicIdleMs: Number.MAX_SAFE_INTEGER, admissionHeld: false, liveReliquats: 0, reliquatDelayMs: 30 * MIN, ...over,
});

// ── fleet: a member = a workspace with a coordinator (`parentId`), started through the real path and answered once ──
async function mkMember(id, { parentId = 'ws-ops' } = {}) {
  const wt = path.join(tmpHome, 'wt', id);
  fs.mkdirSync(wt, { recursive: true });
  wsByCwd.set(wt, id);
  await store.upsertWorkspace({ id, name: id, kind: 'scratch', repoPath: '', worktreePath: wt, status: 'idle', createdAt: realNow(), hasInput: false, ...(parentId ? { parentId } : {}) });
  const started = await delivery.sdkStartAndDeliver(id, 'first turn');
  const answered = await until(() => turnEnds(id) >= 1 && wsOf(id).status === 'idle', 5000);
  // `stop` marks autoUnread ASYNCHRONOUSLY (finished, never opened): wait for it, THEN clear it (what opening the pane does), or it blocks the sweep.
  await until(() => wsOf(id).autoUnread === true, 1500);
  await store.upsertWorkspace({ ...wsOf(id), autoUnread: undefined });
  const w = wsOf(id);
  if (!(started && answered && live(id) && w.status === 'idle' && !w.autoUnread && w.sdkSessionId === sessId(id) && !w.hibernatedAt && !!(parentId ? w.parentId : !w.parentId))) {
    console.log(JSON.stringify({ arm: ARM, ok: false, rigFault: `bad pre-state for ${id}`, started, answered, live: live(id), status: w.status, autoUnread: !!w.autoUnread, sid: w.sdkSessionId, hib: w.hibernatedAt ?? null }));
    process.exit(2);
  }
  return id;
}
const skew = (min) => { skewMs = min * MIN; };
const state = (id) => ({ live: live(id), hibernatedAt: wsOf(id)?.hibernatedAt ?? null, sid: wsOf(id)?.sdkSessionId ?? null });
const sweep = async () => (await hib.sweepHibernation()).slice().sort();
cleanup = () => { try { hib.stopHibernationSweeper(); } catch { /* */ } try { pty.stopPty('ws-a:run'); } catch { /* */ } };

// A guard arm: A is guarded, B is the clean control; both are fleet members idle 1 min; Admission opens → held. Open sweep spares both (recency); held sweep takes B only.
async function guardArm(prepare, { aParent = 'ws-ops', proof } = {}) {   // aParent: null = no coordinator (undefined would take the default)
  await mkMember('ws-a', { parentId: aParent });
  await mkMember('ws-b');
  const prepared = (await prepare?.()) ?? {};
  Object.assign(out, prepared);
  skew(1);
  if (proof) check('guard_signal_is_live', await proof(), true);          // the guard under test is demonstrably in effect, not assumed
  check('open_sweep', await sweep(), []);                                  // Admission open: neither moves (idle 1 min < 5)
  setMem(4); check('admission_held', holding(), true);
  check('held_sweep_takes_only_the_control', await sweep(), ['ws-b']);
  check('control_went', { live: live('ws-b'), chip: !!wsOf('ws-b').hibernatedAt }, { live: false, chip: true });
  check('guarded_member_stays', { live: live('ws-a'), chip: !!wsOf('ws-a').hibernatedAt, interrupted: interrupted('ws-a') }, { live: true, chip: false, interrupted: 0 });
  verdict();
}

if (ARM === 'open_waits') {
  await mkMember('ws-a');
  skew(1);
  check('control_eligible_if_old', eligibleIfOld('ws-a'), true);           // only recency can be sparing it
  check('sweep_1min', await sweep(), []);
  check('still_live_1min', live('ws-a'), true);
  skew(6);
  check('sweep_6min_goes', await sweep(), ['ws-a']);                       // the rig CAN hibernate, at the shipped 5-min default
  const lines = veilleLines('ws-a');
  check('one_plain_line', lines.length === 1 && /hibernating ws-a \(ws-a\) — idle 6m sdk$/.test(lines[0]), true);   // byte-identical to what the open path always logged
  verdict();
}

if (ARM === 'held_veille') {
  const T = await mkMember('ws-top', { parentId: null });
  const A = await mkMember('ws-a');
  const B = await mkMember('ws-b');
  const before = { a: transcriptSha(A), b: transcriptSha(B) };
  skew(1);
  check('control_eligible_if_old', eligibleIfOld(A), true);
  check('open_sweep_1min', await sweep(), []);                             // Admission open: nobody goes
  const snap = setMem(4);
  check('admission_held', holding(), true);
  check('held_sweep', await sweep(), [A, B]);                              // EVERY idle fleet member, the same ones that waited above; the top-level one stays
  for (const id of [A, B]) {
    const s = state(id);
    check(`${id}_stopped_sid_kept`, { live: s.live, chip: !!s.hibernatedAt, sid: s.sid, interrupted: interrupted(id) >= 1 }, { live: false, chip: true, sid: sessId(id), interrupted: true });
    check(`${id}_transcript_kept`, transcriptSha(id), before[id === A ? 'a' : 'b']);
  }
  check('top_level_spared', { live: live(T), chip: !!wsOf(T).hibernatedAt }, { live: true, chip: false });
  const lines = veilleLines(A);
  const avail = `MemAvailable ${(4).toFixed(2)} GB`;
  check('log_names_memavailable_and_fast', lines.length === 1 && lines[0].includes(`Admission HELD, ${avail}`) && lines[0].includes('fast Veille (idle below the 5m threshold)'), true);
  out.snapshotAvailBytes = snap.availBytes;
  // Veille is lossless: the next send resumes the same conversation by its id.
  await delivery.sdkStartAndDeliver(A, 'wake');
  const resumed = await until(() => (callsByWs.get(A) ?? []).length === 2, 4000);
  check('resumes_by_id', { resumed, resume: callsByWs.get(A)?.[1]?.resume ?? null, chipCleared: !wsOf(A).hibernatedAt }, { resumed: true, resume: sessId(A), chipCleared: true });
  verdict();
}

if (ARM === 'held_mixed') {
  const OLD = await mkMember('ws-old');
  const A = await mkMember('ws-a');
  skew(5);
  hn.noteActivity(A);                                                      // A is active at +5 min; OLD has been idle since the start
  skew(6);                                                                 // OLD idle 6 min (past its threshold anyway), A idle 1 min
  check('old_eligible_by_threshold_alone', eligibleIfOld(OLD, { lastActivityAt: hn.getLastActivity(OLD) }), true);
  check('a_not_eligible_open', eligibleIfOld(A, { lastActivityAt: hn.getLastActivity(A) }), false);
  setMem(4); check('admission_held', holding(), true);
  check('held_sweep', await sweep(), [A, OLD]);
  const [oldLine] = veilleLines(OLD), [aLine] = veilleLines(A);
  check('old_line_names_mem_but_is_not_early', !!oldLine && oldLine.includes('Admission HELD, MemAvailable 4.00 GB') && !oldLine.includes('fast Veille'), true);
  check('a_line_is_early', !!aLine && aLine.includes('Admission HELD, MemAvailable 4.00 GB, fast Veille (idle below the 5m threshold)'), true);
  verdict();
}

if (ARM === 'reopen_waits') {
  await mkMember('ws-a');
  setMem(4); check('admission_held', holding(), true);
  setMem(12); check('admission_reopened', holding(), false);               // 12 GB > 6 + 1 margin: the episode is over
  skew(1);
  check('control_eligible_if_old', eligibleIfOld('ws-a'), true);
  check('sweep_after_reopen', await sweep(), []);
  check('still_live', live('ws-a'), true);
  verdict();
}

if (ARM === 'toggle_off') {
  await store.setMemoryGuardSettings({ ...store.getMemoryGuardSettings(), admissionEnabled: false });
  await mkMember('ws-a');
  skew(1);
  const s = setMem(4);
  check('guard_state_held_but_nothing_holds', { admission: s.admission, holding: holding() }, { admission: 'held', holding: false });
  check('control_eligible_if_old', eligibleIfOld('ws-a'), true);
  check('sweep', await sweep(), []);
  check('still_live', live('ws-a'), true);
  verdict();
}

if (ARM === 'guard_turn') {
  await guardArm(async () => {
    callsByWs.get('ws-a')[0].hold = true;                                  // the next turn never ends
    await delivery.sdkStartAndDeliver('ws-a', 'long turn');
    return { statusRunning: await until(() => wsOf('ws-a').status === 'running', 3000) };
  }, { proof: async () => wsOf('ws-a').status === 'running' });
}
if (ARM === 'guard_pending_prompt') {
  await guardArm(async () => {
    await store.upsertWorkspace({ ...wsOf('ws-a'), sdkPendingPrompts: [{ id: 'p1', text: 'the brief', createdAt: realNow() }] });
  }, { proof: async () => (wsOf('ws-a').sdkPendingPrompts ?? []).length === 1 });
}
if (ARM === 'guard_loop') {
  await guardArm(async () => { await store.upsertWorkspace({ ...wsOf('ws-a'), loopingSince: realNow() }); }, { proof: async () => !!wsOf('ws-a').loopingSince });
}
if (ARM === 'guard_waiting') {
  await guardArm(async () => { await store.upsertWorkspace({ ...wsOf('ws-a'), status: 'waiting' }); }, { proof: async () => wsOf('ws-a').status === 'waiting' });
}
if (ARM === 'guard_bg_task') {
  await guardArm(async () => {
    const c = callsByWs.get('ws-a')[0];
    const sys = (o) => ({ type: 'system', session_id: sessId('ws-a'), uuid: `u-${Math.random()}`, ...o });
    const taskEvents = () => events.filter((e) => e.wsId === 'ws-a' && e.ev.type === 'task').length;
    c.inject.push(sys({ subtype: 'task_started', task_id: 'bg1', tool_use_id: 'tu-bg1', task_type: 'local_bash', description: 'pnpm test (background)' }));
    c.inject.push(sys({ subtype: 'background_tasks_changed', tasks: [{ task_id: 'bg1' }] }));
    c.poke();
    return { taskSeen: await until(() => taskEvents() >= 2, 3000) };
  }, { proof: async () => delivery.sdkHasBackgroundTasks?.('ws-a') === true });
}
if (ARM === 'guard_active_pane') {
  await guardArm(async () => { hib.setActiveWorkspace('ws-a'); }, { proof: async () => hib.getActiveWorkspaceId() === 'ws-a' });
}
if (ARM === 'guard_run_pty') {
  await guardArm(async () => {
    await pty.startPty({ id: 'ws-a:run', cwd: tmpHome, command: 'sleep', args: ['120'], cols: 80, rows: 24 });
  }, { proof: async () => pty.isRunning('ws-a:run') });
}
if (ARM === 'no_coordinator') {
  await guardArm(async () => {}, { aParent: null });                  // A has NO coordinator (top-level), B does: only B goes
}

if (ARM === 'edge_sweep') {
  await mkMember('ws-a');
  skew(1);
  check('control_eligible_if_old', eligibleIfOld('ws-a'), true);
  hib.startHibernationSweeper();                                           // periodic tick = 1 h: only an edge-triggered sweep can act within this arm
  await sleep(500);
  check('open_start_sweeps_nothing', live('ws-a'), true);
  const t0 = realNow();
  setMem(4); check('admission_held', holding(), true);                     // the guard emits `admission_held` → the subscribed sweeper sweeps NOW
  const went = await until(() => !live('ws-a') && !!wsOf('ws-a')?.hibernatedAt, 8000);
  out.msToVeille = realNow() - t0;
  check('veille_at_the_edge_not_the_tick', went, true);
  verdict();
}

if (ARM === 'boot_held') {
  await mkMember('ws-a');
  skew(1);
  setMem(4); check('already_held_before_start', holding(), true);          // no edge will fire after the sweeper subscribes: the boot reconcile must act
  check('still_live_before_start', live('ws-a'), true);
  hib.startHibernationSweeper();
  const went = await until(() => !live('ws-a') && !!wsOf('ws-a')?.hibernatedAt, 8000);
  check('veille_at_boot_while_held', went, true);
  verdict();
}

if (ARM === 'late_idler') {
  const W = await mkMember('ws-w');
  skew(1);
  callsByWs.get(W)[0].hold = true;                                         // W is mid-turn when Admission becomes held
  await delivery.sdkStartAndDeliver(W, 'long turn');
  check('w_running', await until(() => wsOf(W).status === 'running', 3000), true);
  hib.startHibernationSweeper();                                           // periodic tick = 1 h: only a guard-triggered sweep can act within this arm
  setMem(4); check('admission_held', holding(), true);                     // the edge sample sweeps — W is running, so it is spared
  await sleep(600);
  check('spared_at_the_edge', { live: live(W), interrupted: interrupted(W) }, { live: true, interrupted: 0 });
  callsByWs.get(W)[0].releaseHold();                                       // the turn ends: W is now an idle fleet member, Admission still held
  check('w_idle', await until(() => wsOf(W).status === 'idle', 3000), true);
  await sleep(600);
  check('no_sweep_without_a_sample', live(W), true);                       // nothing but a guard sample can act (no tick, no edge)
  const t0 = realNow();
  setMem(4);                                                               // the NEXT guard sample while held (same level — NOT an edge)
  const went = await until(() => !live(W) && !!wsOf(W)?.hibernatedAt, 8000);
  out.msToVeille = realNow() - t0;
  check('veille_at_the_next_sample', went, true);
  verdict();
}

if (ARM === 'samples_quiet') {
  const M = await mkMember('ws-m');
  skew(6);                                                                 // idle 6 min: past its threshold, so ONLY the missing sweep spares it
  check('control_eligible_by_threshold_alone', eligibleIfOld(M, { lastActivityAt: hn.getLastActivity(M) }), true);
  hib.startHibernationSweeper();                                           // periodic tick = 1 h
  await sleep(300);
  check('start_sweeps_nothing_open', live(M), true);
  for (let i = 0; i < 3; i++) { setMem(12); await sleep(100); }            // open samples
  check('open_samples_run_no_sweep', live(M), true);
  await store.setMemoryGuardSettings({ ...store.getMemoryGuardSettings(), admissionEnabled: false });
  for (let i = 0; i < 3; i++) { const s = setMem(4); out.admission = s.admission; await sleep(100); }   // held STATE, toggle OFF: nothing holds
  check('toggle_off_held_samples_run_no_sweep', { holding: holding(), live: live(M) }, { holding: false, live: true });
  check('rig_can_sweep_this_member', (await sweep()).includes(M), true);   // the same member IS taken by an explicit sweep (instrument control)
  verdict();
}

if (ARM === 'overlap_probe') {
  const X = await mkMember('ws-x');
  skew(1);
  callsByWs.get(X)[0].interruptDelay = 1500;                               // X's graceful close is slow: pass 1 stays in flight for 1.5 s
  setMem(4); check('admission_held', holding(), true);
  const pass1 = hib.sweepHibernation();
  check('x_stop_started', await until(() => interrupted(X) >= 1, 4000), true);
  const pass2 = hib.sweepHibernation();                                    // the overlapping pass (a guard sample / the tick landing mid-pass)
  const [t1, t2] = await Promise.all([pass1, pass2]);
  check('x_taken_by_pass1_only', { t1, t2 }, { t1: [X], t2: [] });
  check('x_stopped_once', interrupted(X), 1);
  check('x_chip_and_not_live', { live: live(X), chip: !!wsOf(X).hibernatedAt }, { live: false, chip: true });
  verdict();
}

if (ARM === 'overlap_same_tick') {
  const Y = await mkMember('ws-y');
  skew(1);
  callsByWs.get(Y)[0].interruptDelay = 300;
  setMem(4); check('admission_held', holding(), true);
  const [p1, p2] = [hib.sweepHibernation(), hib.sweepHibernation()];       // same tick: pass 2 runs while pass 1 is awaiting Y's stop
  const [t1, t2] = await Promise.all([p1, p2]);
  check('y_taken_by_exactly_one_pass', { n: t1.length + t2.length, both: [...t1, ...t2] }, { n: 1, both: [Y] });
  check('y_stopped_once', interrupted(Y), 1);
  check('y_chip_and_not_live', { live: live(Y), chip: !!wsOf(Y).hibernatedAt }, { live: false, chip: true });
  verdict();
}

if (ARM === 'reopen_mid_pass') {
  const X = await mkMember('ws-x');
  const Y = await mkMember('ws-y');
  skew(1);
  callsByWs.get(X)[0].interruptDelay = 1500;                               // X's graceful close is slow: the pass stays in flight for 1.5 s
  setMem(4); check('admission_held', holding(), true);
  const pass = hib.sweepHibernation();                                     // X first (store order): the pass blocks in X's stop
  check('x_stop_started', await until(() => interrupted(X) >= 1, 4000), true);
  setMem(12); check('admission_reopened', holding(), false);               // the hold ends while the pass is still stopping X
  const taken = await pass;
  check('x_went_y_spared', { taken, yLive: live(Y), yChip: !!wsOf(Y).hibernatedAt }, { taken: [X], yLive: true, yChip: false });
  verdict();
}


// ── #326-fu m5: the three arms that keep the #288 mutants S02 / S13 / O04-O06 killable at the RIG level. #326's defence in depth (the fresh re-check after the verdict, `veilleBusy`, the second pass re-reading liveness after ITS own
// awaits) hides their OUTCOME; what they still change is WHO IS ASKED (a Reliquat census for a member that is not eligible) and WHEN a second pass can slip in (a real yield between the live check and the stop). ──
const censusSpy = () => { const asked = []; hib.setVeilleReliquatPort({ census: async (w) => { asked.push(w); return 0; }, stop: async () => null, tell: async () => true }); return asked; };

if (ARM === 'toggle_off_census') {
  await store.setMemoryGuardSettings({ ...store.getMemoryGuardSettings(), admissionEnabled: false });
  await mkMember('ws-a');
  skew(1);
  const asked = censusSpy();
  const s = setMem(4);
  check('guard_state_held_but_nothing_holds', { admission: s.admission, holding: holding() }, { admission: 'held', holding: false });
  check('control_eligible_if_old', eligibleIfOld('ws-a'), true);
  check('sweep', await sweep(), []);
  check('no_census_paid_for_a_member_that_is_not_eligible', asked, []);
  check('still_live', live('ws-a'), true);
  verdict();
}

if (ARM === 'reopen_census') {
  const X = await mkMember('ws-x');
  const Y = await mkMember('ws-y');
  skew(1);
  const asked = censusSpy();
  callsByWs.get(X)[0].interruptDelay = 1500;                               // X's graceful close is slow: the pass stays in flight for 1.5 s
  setMem(4); check('admission_held', holding(), true);
  const pass = hib.sweepHibernation();
  check('x_stop_started', await until(() => interrupted(X) >= 1, 4000), true);
  setMem(12); check('admission_reopened', holding(), false);               // the hold ends while the pass is still stopping X
  const taken = await pass;
  check('x_went_y_spared', { taken, yLive: live(Y), yChip: !!wsOf(Y).hibernatedAt }, { taken: [X], yLive: true, yChip: false });
  check('y_never_asked_after_the_hold_ended', asked, [X]);                 // a snapshot hoisted out of the loop would census Y on the STALE hold
  verdict();
}

if (ARM === 'overlap_post_verdict') {
  const Y = await mkMember('ws-y');
  skew(1);
  callsByWs.get(Y)[0].interruptDelay = 300;
  setMem(4); check('admission_held', holding(), true);
  // a SECOND pass starts the instant the first one yields after its verdict (the microtask is queued when the first re-reads Y on fresh state): any await between the live check and the stop lets it take Y again
  const orig = store.getWorkspace.bind(store);
  let second = null;
  let armed = true;
  store.getWorkspace = (id) => { if (armed && id === Y) { armed = false; queueMicrotask(() => { second = hib.sweepHibernation(); }); } return orig(id); };
  const t1 = await hib.sweepHibernation();
  const t2 = second ? await second : null;
  store.getWorkspace = orig;
  check('second_pass_started_inside_the_first', second !== null, true);
  check('y_taken_by_exactly_one_pass', { n: t1.length + (t2?.length ?? 0), both: [...t1, ...(t2 ?? [])] }, { n: 1, both: [Y] });
  check('y_stopped_once', interrupted(Y), 1);
  check('y_chip_and_not_live', { live: live(Y), chip: !!wsOf(Y).hibernatedAt }, { live: false, chip: true });
  verdict();
}

fails.push(`arm ${ARM} fell through`); verdict();
