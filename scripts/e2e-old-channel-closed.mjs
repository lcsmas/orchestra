// #441 (spec #431, ledger #443) — THE OLD CHANNEL IS CLOSED: the BUILT CLI (`dist-electron/cli.js`) against the REAL hooks-server, a REAL bus.sqlite and a REAL workspace store (scratch home).
// No app, no Electron. Agents are stubbed at the SDK delivery seam only (it RECORDS every turn pushed into a session, like composed-night); everything the CLI and the host DO is the shipped code.
//
//   c0_control            `message --emergency` to a (wedged) reader still pushes the text into its session (rc 0, "Delivered"), the footer names ONE reply command
//   c1_matrix             `message <id> <text>` WITHOUT --emergency is REFUSED (rc != 0, the equivalent `orchestra send --type status --to <id> '<text>'` printed) for a parent, a child, a sibling,
//                         an unrelated agent, a plain parent's child, a dangling-parent agent; nothing reaches a session, nothing is filed on the bus, no inbox file
//   c2_broadcast          `message --to a,b` / `--children` WITHOUT --emergency refused per target (each its own command); `message --emergency --to a,b` delivers to both
//   c3_leading_token      `--emergency` anywhere but the LEADING token is part of the body: the send is refused
//   c4_delivery_off_row   a run frozen with delivery=0 (pre-update row, no migration): `send` / `check` deliver by the bus, `bus-status` prints no `delivery` row
//
// Run: pnpm run test:old-channel-closed   (builds dist-electron/cli.js first), or node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-old-channel-closed.mjs
// Last lines: per-arm `PASS|FAIL <arm> — why`, then `OLD CHANNEL CLOSED: ALL PASS|RED …`; exit 0 only when every arm passed.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(process.env.RIG_REPO ?? path.join(HERE, '..'));
const ARM_NAMES = ['c0_control', 'c1_matrix', 'c2_broadcast', 'c3_leading_token', 'c4_delivery_off_row'];

// ── SAFETY: scratch under ~/.cache of the REAL home, never near a live Orchestra / Claude dir ──
const REAL_HOME = os.homedir();
const base = path.resolve(process.env.OLD_CHANNEL_RIG_HOME ?? path.join(REAL_HOME, '.cache', 'e2e-old-channel-closed'));
const tmpHome = path.join(base, `${process.pid}-${Date.now().toString(36)}`);
const live = [path.join(REAL_HOME, '.orchestra'), path.join(REAL_HOME, '.claude'), path.join(REAL_HOME, '.claude-mc'), path.join(REAL_HOME, '.config')];
if (!(tmpHome + path.sep).startsWith(path.join(REAL_HOME, '.cache') + path.sep) || live.some((l) => (tmpHome + path.sep).startsWith(l + path.sep) || l.startsWith(tmpHome + path.sep))) {
  console.error(`SAFETY: refusing scratch path ${tmpHome}`); process.exit(2);
}
fs.mkdirSync(path.join(tmpHome, '.orchestra'), { recursive: true });
for (const k of Object.keys(process.env)) if (/^(ORCHESTRA_|CLAUDE_CONFIG_DIR|CLAUDECODE|CLAUDE_CODE_)/.test(k)) delete process.env[k];
process.env.ORCHESTRA_AGENT_TMP_BASE = 'off';
process.env.ORCHESTRA_HOME = path.join(tmpHome, '.orchestra');
process.env.HOME = tmpHome;
process.env.CLAUDE_CONFIG_DIR = path.join(tmpHome, '.claude-scratch');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
const stubBin = path.join(tmpHome, 'stub-bin');
fs.mkdirSync(stubBin, { recursive: true });
fs.writeFileSync(path.join(stubBin, 'claude'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
process.env.PATH = `${stubBin}:/usr/local/bin:/usr/bin:/bin`;
process.env.ORCHESTRA_SPAWN_INIT_WAIT_MS = '400';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
setInterval(() => {}, 1000);

const results = [];
let cur = null;
function check(name, got, want) {
  const ok = typeof want === 'function' ? !!want(got) : eq(got, want);
  cur.checks.push({ name, ok, got: ok ? undefined : got, want: ok ? undefined : (typeof want === 'function' ? '(predicate)' : want) });
  return ok;
}
async function arm(name, fn) {
  cur = { name, checks: [], error: null };
  results.push(cur);
  const t0 = Date.now();
  try { await fn(); } catch (e) { cur.error = String(e?.stack ?? e).split('\n').slice(0, 3).join(' ⏎ '); }
  cur.ms = Date.now() - t0;
}
function report() {
  let red = 0;
  for (const r of results) {
    const bad = r.checks.filter((c) => !c.ok);
    const ok = bad.length === 0 && !r.error;
    if (!ok) red++;
    const why = [...bad.map((c) => `${c.name}: got ${JSON.stringify(c.got)} want ${JSON.stringify(c.want)}`), ...(r.error ? [`ERROR ${r.error}`] : [])].join(' | ').slice(0, 1400);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${r.name} (${r.checks.length} checks, ${r.ms} ms)${why ? ` — ${why}` : ''}`);
  }
  const missing = ARM_NAMES.filter((n) => !results.some((r) => r.name === n));
  console.log(`OLD CHANNEL CLOSED: ${red === 0 && missing.length === 0 ? 'ALL PASS' : `RED ${[...results.filter((r) => r.error || r.checks.some((c) => !c.ok)).map((r) => r.name), ...missing.map((m) => `${m}(missing)`)].join(',')}`} (${results.reduce((n, r) => n + r.checks.length, 0)} checks)`);
  return red === 0 && missing.length === 0;
}
const hang = setTimeout(() => { console.log('FAIL deadline — the rig hung (240 s)'); report(); process.exit(1); }, 240_000);
hang.unref?.();

// ── modules from the tree under test ──
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-e2e-old-channel', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => tmpHome, getLogsDir: () => `${tmpHome}/logs`, getAppVersion: () => '0.0.0-e2e-old-channel', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
fs.mkdirSync(path.join(tmpHome, 'orchestra'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'orchestra', 'store.json'), JSON.stringify({ repos: [], workspaces: [], accounts: [], selfTuneRuns: [] }));
const { store } = await import(`${REPO}/src/main/store.ts`);
await store.load?.();
const busMod = await import(`${REPO}/src/main/bus.ts`);
const busRuns = await import(`${REPO}/src/main/bus-runs.ts`);
await import(`${REPO}/src/main/agent-sdk.ts`);                      // registers the REAL delivery seam; the recording stub below replaces it
const delivery = await import(`${REPO}/src/main/sdk-delivery.ts`);
const tray = await import(`${REPO}/src/main/inbox-tray.ts`);
await import(`${REPO}/src/main/workspaces.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);

busMod.initBus();
const db = busMod.getBus();
if (!db) { console.error('bus failed to open'); process.exit(3); }
if (!String(busMod.busPath()).startsWith(tmpHome)) { console.error(`SAFETY: bus resolved outside scratch: ${busMod.busPath()}`); process.exit(2); }

// ── the agents' stub (the ONLY fake): every session is live; RECORDS each turn pushed into it ──
const turns = [];
delivery.registerSdkDelivery({
  hasSession: () => true, hasBackgroundTask: () => false,
  awaitFirstTurn: async () => ({ state: 'ok' }),
  send: async (wsId, text, peer, origin) => { turns.push({ wsId, text, how: 'send', origin }); },
  sendAwaitingStart: async (wsId, text, peer, ms, origin) => { turns.push({ wsId, text, how: 'awaiting', origin }); return 'started'; },
  start: async (wsId, text) => { turns.push({ wsId, text, how: 'start' }); },
  stop: async () => {},
});

// ── the fleet (a REAL store): LEAD ⊃ OPS ⊃ W1,W2 ; STRANGER (an unrelated top-level agent) ; PLAINP ⊃ PKID (a plain parent + its child) ; DANG (its parent was deleted) ──
const now0 = Date.now();
const mk = (id, extra = {}) => ({ id, name: id, branch: id, kind: 'scratch', repoPath: '', worktreePath: tmpHome, status: 'idle', createdAt: now0 - 60_000, hasInput: true, sdkSessionId: `sess-${id}`, ...extra });
const LIVE_SW = { ...DEFAULT_BUS_SWITCHES, wake: true, askGate: true, liveness: true, capability: true };
await store.upsertWorkspace(mk('LEAD', { kind: 'orchestrator' }));
await store.upsertWorkspace(mk('OPS', { parentId: 'LEAD', ownsRun: true }));
await store.upsertWorkspace(mk('W1', { parentId: 'OPS' }));
await store.upsertWorkspace(mk('W2', { parentId: 'OPS' }));
await store.upsertWorkspace(mk('STRANGER'));
await store.upsertWorkspace(mk('PLAINP', { ownsRun: true }));
await store.upsertWorkspace(mk('PKID', { parentId: 'PLAINP' }));
await store.upsertWorkspace(mk('DANG', { parentId: 'deleted-parent' }));
busRuns.startRun(db, { id: 'LEAD', kind: 'mission', coordinator: 'LEAD' }, LIVE_SW);
busRuns.startRun(db, { id: 'OPS', kind: 'vague', coordinator: 'OPS', parentRunId: 'LEAD' }, LIVE_SW);
busRuns.startRun(db, { id: 'STRANGER', kind: 'mission', coordinator: 'STRANGER' }, LIVE_SW);
busRuns.startRun(db, { id: 'PLAINP', kind: 'mission', coordinator: 'PLAINP' }, LIVE_SW);
busRuns.startRun(db, { id: 'DANG', kind: 'mission', coordinator: 'DANG' }, LIVE_SW);
// the run each workspace's bus address belongs to (what the host resolves per CLI call)
const RUN_OF = { LEAD: 'LEAD', OPS: 'LEAD', W1: 'OPS', W2: 'OPS', STRANGER: 'STRANGER', PLAINP: 'PLAINP', PKID: 'PLAINP', DANG: 'DANG' };

const hooks = await import(`${REPO}/src/main/hooks-server.ts`);
await hooks.startHooksServer();
const CLI = path.join(REPO, 'dist-electron', 'cli.js');
if (!fs.existsSync(CLI)) { console.error(`NO CLI BUNDLE at ${CLI} (pnpm run build:cli)`); process.exit(3); }
const newestInput = (() => { let n = 0; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (!/\.test\.ts$/.test(e.name)) n = Math.max(n, fs.statSync(f).mtimeMs); } }; for (const dir of ['src/cli', 'src/shared']) walk(path.join(REPO, dir)); return n; })();
const bundleStale = fs.statSync(CLI).mtimeMs < newestInput;

/** run the BUILT CLI as `asWs` (its host-resolved bus identity = ORCHESTRA_WS_ID + ORCHESTRA_RUN_ID like a real session) → { code, out } */
const cli = (asWs, args) => new Promise((resolve) => {
  const env = { PATH: process.env.PATH, HOME: tmpHome, ORCHESTRA_HOME: process.env.ORCHESTRA_HOME, ORCHESTRA_SOCK: hooks.getHookSocketPath(), ORCHESTRA_WS_ID: asWs, ORCHESTRA_RUN_ID: RUN_OF[asWs] ?? asWs };
  const p = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let so = '', se = '';
  p.stdout.on('data', (c) => (so += c)); p.stderr.on('data', (c) => (se += c));
  p.on('close', (code) => resolve({ code, out: so + se, stdout: so, stderr: se }));
});
const busRowCount = () => db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
const inboxExists = (id) => fs.existsSync(tray.inboxFilePath(id));
const sendCmd = (to, text) => `orchestra send --type status --to ${to} '${text}'`;
const TEXT = 'please run the wave now';

await arm('c0_control', async () => {
  check('bundle_not_stale', bundleStale, false);
  const before = turns.length, rowsBefore0 = busRowCount();
  const r = await cli('LEAD', ['message', '--emergency', 'W1', 'EMG-ONE wake up reader']);
  check('emergency_files_NOTHING_on_the_bus_(no_dispatch_row_in_the_targets_run)', busRowCount() - rowsBefore0, 0);
  check('emergency_rc0', r.code, 0);
  check('emergency_says_delivered', /Delivered \(/.test(r.out), true);
  const t = turns.slice(before).find((x) => x.wsId === 'W1');
  check('the_wedged_reader_got_the_text_in_its_session', !!t && t.text.includes('EMG-ONE wake up reader'), true);
  check('footer_names_ONE_reply_command', !!t && t.text.includes('Reply with: orchestra send --type status --to LEAD "<reply>"') && !/orchestra message|legacy|delivery|— or /i.test(t.text.slice(t.text.indexOf('Reply with:'))), true);
  check('exactly_one_reply_footer', !!t && (t.text.match(/Reply with:/g) ?? []).length, 1);
});

await arm('c1_matrix', async () => {
  const pairs = [
    ['to_a_PARENT', 'W1', 'OPS'],
    ['to_a_CHILD', 'OPS', 'W1'],
    ['to_a_SIBLING', 'W1', 'W2'],
    ['to_an_UNRELATED_agent', 'STRANGER', 'W1'],
    ['to_a_PLAIN_parent_from_its_child', 'PKID', 'PLAINP'],
    ['to_a_plain_parent_from_a_stranger', 'STRANGER', 'PLAINP'],
    ['to_a_dangling_parent_agent', 'STRANGER', 'DANG'],
  ];
  for (const [name, from, to] of pairs) {
    const turnsBefore = turns.length, rowsBefore = busRowCount();
    const r = await cli(from, ['message', to, TEXT]);
    check(`${name}_refused_rc`, r.code !== 0, true);
    check(`${name}_prints_the_equivalent_send`, r.out.includes(sendCmd(to, TEXT)), true);
    check(`${name}_names_the_emergency_escape`, /--emergency/.test(r.out), true);
    check(`${name}_nothing_reached_a_session`, turns.length - turnsBefore, 0);
    check(`${name}_nothing_filed_on_the_bus`, busRowCount() - rowsBefore, 0);
    check(`${name}_no_inbox_file`, inboxExists(to), false);
    check(`${name}_no_switch_wording`, /delivery|legacy/i.test(r.out), false);
  }
  // a 9000-char text is echoed WHOLE (never silently cut), and an id with a space is quoted
  const long = `${'a'.repeat(4500)} ${'b'.repeat(4499)}`;
  const rl = await cli('W1', ['message', 'W2', long]);
  check('long_text_refused_and_echoed_whole', [rl.code !== 0, rl.out.includes(sendCmd('W2', long))], [true, true]);
  const rq = await cli('W1', ['message', 'my agent', 'hi']);
  check('an_id_with_a_space_is_quoted_in_the_printed_command', rq.out.includes("orchestra send --type status --to 'my agent' 'hi'"), true);
  // the printed command is the REAL verb: run it as the sender and the bus carries it (the equivalent actually works)
  const r2 = await cli('W1', ['send', '--type', 'status', '--to', 'OPS', TEXT]);
  check('the_equivalent_send_works_rc0', r2.code, 0);
  check('and_the_bus_holds_it', db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body = ? AND recipient = 'OPS'").get(TEXT).n, 1);
});

await arm('c2_broadcast', async () => {
  const turnsBefore = turns.length, rowsBefore = busRowCount();
  const r = await cli('OPS', ['message', '--to', 'W1,W2', TEXT]);
  check('broadcast_to_refused_rc', r.code !== 0, true);
  check('each_target_has_its_own_command', r.out.includes(sendCmd('W1', TEXT)) && r.out.includes(sendCmd('W2', TEXT)), true);
  const r2 = await cli('OPS', ['message', '--children', TEXT]);
  check('broadcast_children_refused_rc', r2.code !== 0, true);
  check('children_each_has_its_own_command', r2.out.includes(sendCmd('W1', TEXT)) && r2.out.includes(sendCmd('W2', TEXT)), true);
  check('no_turn_no_row', [turns.length - turnsBefore, busRowCount() - rowsBefore], [0, 0]);
  const rowsBeforeHalt = busRowCount();
  const r3 = await cli('OPS', ['message', '--emergency', '--to', 'W1,W2', 'HALT-NOW']);
  check('emergency_broadcast_rc0', r3.code, 0);
  check('emergency_broadcast_files_nothing_on_the_bus', busRowCount() - rowsBeforeHalt, 0);
  const stranger = await cli('STRANGER', ['message', '--emergency', 'W1', 'EMG-STRANGER']);
  check('a_strangers_emergency_is_delivered_but_never_a_dispatch_in_the_targets_run', [stranger.code, db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind = 'dispatch' AND body LIKE '%EMG-STRANGER%'").get().n], [0, 0]);
  check('emergency_broadcast_reached_both', ['W1', 'W2'].every((id) => turns.some((t) => t.wsId === id && t.text.includes('HALT-NOW'))), true);
});

await arm('c3_leading_token', async () => {
  const turnsBefore = turns.length;
  const r = await cli('W1', ['message', 'W2', '--emergency', 'not an escape']);
  check('emergency_not_leading_is_refused', r.code !== 0, true);
  check('and_it_is_part_of_the_body', r.out.includes(sendCmd('W2', '--emergency not an escape')), true);
  check('nothing_delivered', turns.length - turnsBefore, 0);
});

await arm('c4_delivery_off_row', async () => {
  // a PRE-UPDATE run row: frozen with delivery OFF (the removed key), written raw exactly as the old build left it — no migration runs
  busRuns.startRun(db, { id: 'OFFC', kind: 'mission', coordinator: 'OFFC' }, { ...DEFAULT_BUS_SWITCHES, liveness: true });
  db.prepare('UPDATE run_flags SET flags = ? WHERE run_id = ?').run(JSON.stringify({ delivery: false, wake: false, askGate: false, liveness: true, fencing: false, capability: false, receipts: false }), 'OFFC');
  await store.upsertWorkspace(mk('OFFC', { kind: 'orchestrator' }));
  await store.upsertWorkspace(mk('OFFM', { parentId: 'OFFC' }));
  RUN_OF.OFFC = 'OFFC'; RUN_OF.OFFM = 'OFFC';
  const raw = db.prepare('SELECT flags FROM run_flags WHERE run_id = ?').get('OFFC').flags;
  check('fixture_row_really_carries_delivery_false', JSON.parse(raw).delivery, false);
  const s = await cli('OFFM', ['send', '--type', 'status', '--to', 'OFFC', 'hello-from-an-old-run']);
  check('send_on_a_delivery_off_row_rc0', [s.code, s.code === 0 ? '' : s.out.slice(0, 300)], [0, '']);
  check('the_bus_holds_the_mail', db.prepare("SELECT COUNT(*) AS n FROM messages WHERE run_id = 'OFFC' AND body = 'hello-from-an-old-run' AND recipient = 'OFFC'").get().n, 1);
  const c = await cli('OFFC', ['check']);
  check('the_coordinator_reads_it_by_the_bus', c.code === 0 && c.out.includes('hello-from-an-old-run'), true);
  const st = await cli('OFFC', ['bus-status']);
  check('bus_status_prints_the_row_without_a_delivery_switch', st.code === 0 && st.out.includes('OFFC') && !/^\s*delivery\b/m.test(st.out), true);
  check('and_the_other_switches_read_as_frozen', /liveness\s+ON/.test(st.out), true);
});

const ok = report();
process.exit(ok ? 0 : 1);
