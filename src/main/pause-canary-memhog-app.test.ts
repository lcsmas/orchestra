// Pause canary 1b (#324) — the PACKAGED path's fact shaping (scripts/pause-canary/memhog-app-facts.mjs) fed by the REAL producers: the keeper's notice file (`appendMemNotice`), the store's `sdkMemNotices` entries (`memNoticeEntryOf`) and the
// coordinator's bus body (`memBusBody`). The Q11 run is ONE run: a wrong field name or a file-format surprise must be found here, not there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { workerFromAppFacts, parseNoticeFile, capStateFromKeeperLog, appMemoryGuardSeed, memhogAppEnvelope, heavyTokensWhy, CAP_ON_START_GB, capDegradationsFromKeeperLog } from '../../scripts/pause-canary/memhog-app-facts.mjs';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { evaluateMemhogCycle } from '../../scripts/pause-canary/memhog-bars.mjs';
import { appendMemNotice } from '../shared/mem-notice-file.ts';
import { normalizeMemoryGuardSettings, decideMemoryGuard, INITIAL_GUARD_STATE, thresholdsFrom, isAdmissionHolding, GIB as G } from '../shared/memory-guard.ts';
import { memNoticeEntryOf } from '../shared/mem-notice.ts';
import { memBusBody, type MemKillRecord, type MemSoftRecord } from '../shared/memory-scope.ts';

const GIB = 1024 ** 3;
const OPS = 'aaaaaaaa-0000-4000-8000-000000000002';
const T0 = 1_800_000_000_000;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mhapp-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const wsOf = (i: number) => ({ k: `w${i}`, id: `aaaaaaaa-0000-4000-8000-0000000000${10 + i}` });
const kill = (w: { k: string }, over: Partial<MemKillRecord> = {}): MemKillRecord => ({ kind: 'kill', source: 'kernel', seq: 2, at: T0 + 4200, level: 'hard', command: `python3 /repo/scripts/memory-cap/swarm.py 1 1174 5 memhog-${w.k}-c1`, pid: 4242, rssBytes: null, candidates: [], unit: `orchestra-rig-wh-h3-x-${w.k}.scope`, hardBytes: GIB, ...over });
const soft = (w: { k: string }): MemSoftRecord => ({ kind: 'soft', seq: 1, at: T0 + 2000, unit: `orchestra-rig-wh-h3-x-${w.k}.scope`, bytes: 800 * 1024 ** 2, softBytes: 768 * 1024 ** 2, hardBytes: GIB });

/** The keeper's summary line, built from the producer's own template (pinned against src/keeper/index.ts below). */
const keeperCapLine = (state: string, unit: string) => `[keeper 2026-10-09T10:00:00.000Z] memory cap: ${state} unit=${unit} memory.max=${GIB} cgroup=/sys/fs/cgroup/user.slice/${unit}\n`;

/** A clean cycle's facts for worker i, built with the real writers. */
function facts(i: number, over: Record<string, unknown> = {}) {
  const w = wsOf(i);
  const file = path.join(dir, `${w.k}.memnotices.jsonl`);
  fs.rmSync(file, { force: true });
  const k = kill(w);
  appendMemNotice(file, soft(w));
  appendMemNotice(file, k);
  const label = `pc-${w.k} (${w.id})`;
  return {
    w,
    f: {
      up: true,
      scope: { inRig: true, unit: `orchestra-rig-wh-h3-x-${w.k}.scope`, memoryMax: GIB, swapMax: '0', high: 'max', policy: 'continue' },
      swarmText: 'swarm: children=1 survived=0 killed=1\n',
      oomKillDelta: 1,
      noticeText: fs.readFileSync(file, 'utf8'),
      storeNotices: [memNoticeEntryOf(soft(w)), memNoticeEntryOf(k)],
      msgs: [
        { sequence: 20 + i, kind: 'status', recipient: OPS, body: memBusBody(label, soft(w)), created_at: T0 + 2100 },
        { sequence: 30 + i, kind: 'escalation', recipient: OPS, body: memBusBody(label, k), created_at: T0 + 4300 },
      ],
      lots: [{ from_seq: 0, to_seq: 100, acked_at: T0 + 9000 }],
      idPre: { claude: `${100 + i}@5`, keeper: `${90 + i}@4` }, idPost: { claude: `${100 + i}@5`, keeper: `${90 + i}@4` },
      keeperAlive: true, cliAlive: true, probeAfter: true, scopeActive: true,
      backstop: { kLeafKills: 0, beyondWorkKills: 0 },
      keeperLog: keeperCapLine('ACTIVE', `orchestra-rig-wh-h3-x-${w.k}.scope`),
      ...over,
    },
  };
}
const cycle = (parts: Array<ReturnType<typeof facts>>) => ({ exercise: 'memhog-app', cycle: 1, expectWorkers: parts.length, capGb: 1, opsId: OPS, leadSeen: 0, workers: parts.map((p) => workerFromAppFacts(p.w, 1, T0, OPS, p.f)), tMemberToldS: 4.2, tCoordToldS: 4.3 });
const red = (m: ReturnType<typeof cycle>) => evaluateMemhogCycle(m).filter((c: { ok: boolean }) => !c.ok).map((c: { id: string }) => c.id);

test('facts built with the REAL writers (notice file, sdkMemNotices entries, bus body) shape into a metric every bar accepts — a warning-level crossing on the way up included', () => {
  assert.deepEqual(red(cycle([facts(1), facts(2), facts(3)])), []);
});

test('the keeper\'s notice file parses with its blank separator lines, skips a torn tail and a foreign line; soft records are not kills', () => {
  const w = wsOf(1);
  const f = facts(1).f;
  const torn = `${f.noticeText}\n{"kind":"kill","seq":9,"at":1`;
  const parsed = parseNoticeFile(torn);
  assert.equal(parsed.length, 2, 'a soft record and a kill; the torn tail is dropped');
  assert.equal(parsed.filter((r: { kind?: string }) => r.kind !== 'soft').length, 1);
  assert.deepEqual(parseNoticeFile(`${f.noticeText}\nnot json\n`).length, 2);
  assert.deepEqual(parseNoticeFile(null), []);
  const m = workerFromAppFacts(w, 1, T0, OPS, { ...f, noticeText: torn });
  assert.equal(m.records.length, 1);
  assert.match(m.records[0].command, /memhog-w1-c1$/);
});

test('every degradation of the real-path facts reads RED on the bar that owns it', () => {
  const base = () => [facts(1), facts(2), facts(3)];
  const withOver = (over: Record<string, unknown>) => { const p = base(); p[1] = facts(2, over); return cycle(p); };
  assert.deepEqual(red(withOver({ swarmText: '' })), ['bar:hog_killed'], 'the hog tool printed nothing');
  assert.deepEqual(red(withOver({ swarmText: 'swarm: children=1 survived=1 killed=0\n', oomKillDelta: 0, storeNotices: [], msgs: [], noticeText: '' })).sort(), ['bar:coordinator_told', 'bar:hog_killed', 'bar:member_told'], 'the hog survived and nobody was told');
  assert.ok(red(withOver({ lots: [{ from_seq: 0, to_seq: 100, acked_at: null }] })).includes('bar:coordinator_told'), 'the escalation sits in a lot the OPS took but never acked: not read');
  assert.ok(red(withOver({ lots: [] })).includes('bar:coordinator_told'));
  assert.ok(red(withOver({ storeNotices: [] })).includes('bar:member_told'), 'no persisted row');
  const w2 = facts(2).f;
  assert.deepEqual(red(withOver({ idPost: { claude: '999@7', keeper: w2.idPre.keeper } })), ['bar:session_survives'], 'only the CLI was replaced (same keeper)');
  assert.deepEqual(red(withOver({ idPost: { claude: w2.idPre.claude, keeper: '999@7' } })), ['bar:session_survives'], 'only the keeper was replaced (same CLI)');
  assert.deepEqual(red(withOver({ idPre: { claude: undefined, keeper: undefined }, idPost: { claude: undefined, keeper: undefined } })), ['bar:session_survives'], 'identities that could not be read are not « the same »');
  assert.ok(red(withOver({ oomKillDelta: undefined })).includes('bar:hog_killed'), 'no kernel reading is NOT MEASURED, never a default');
  assert.deepEqual(red(withOver({ probeAfter: false })), ['bar:session_survives'], 'the CLI no longer works');
  assert.deepEqual(red(withOver({ backstop: { kLeafKills: 1, beyondWorkKills: 1 } })), ['bar:no_backstop_kill'], 'a kill in the keeper leaf of a session that SURVIVED (#343)');
  assert.deepEqual(red(withOver({ backstop: null })), ['bar:no_backstop_kill'], 'unreadable counters');
  assert.deepEqual(red(withOver({ keeperAlive: false })).sort(), ['bar:no_backstop_kill'].sort(), 'a dead keeper is a #343 signal (the identity bars see the unchanged identities)');
  assert.deepEqual(red(withOver({ keeperLog: 'nothing' })), ['bar:cap_holds_after_kill'], 'the keeper never said the cap was ACTIVE');
  assert.deepEqual(red(withOver({ keeperLog: '' })), ['bar:cap_holds_after_kill'], 'no keeper log read');
  assert.deepEqual(red(withOver({ keeperLog: keeperCapLine('NOT-APPLIED', 'x.scope') })), ['bar:cap_holds_after_kill'], 'in a scope but memory.max not applied');
  assert.deepEqual(red(withOver({ keeperLog: keeperCapLine('UNPROTECTED', 'x.scope') })), ['bar:cap_holds_after_kill'], 'no tool wrapper');
  assert.deepEqual(red(withOver({ keeperLog: keeperCapLine('ACTIVE', 'x.scope') + keeperCapLine('NOT-APPLIED', 'x.scope') })), ['bar:cap_holds_after_kill'], 'the LAST line wins (a restart re-logs)');
  assert.deepEqual(red(withOver({ scopeActive: false })), ['bar:cap_holds_after_kill']);
  assert.ok(red(withOver({ up: false })).includes('workers_up'));
  assert.ok(red(withOver({ msgs: [facts(2).f.msgs[0], { sequence: 99, kind: 'escalation', recipient: 'the-lead', body: facts(2).f.msgs[1].body, created_at: T0 + 4300 }] })).includes('bar:only_coordinator_told'));
});

test('coordRead counts only the escalations TO the coordinator that lie in a lot it took AND acked', () => {
  const f = facts(1).f;
  assert.equal(workerFromAppFacts(wsOf(1), 1, T0, OPS, f).coordRead, 1, 'the kill escalation (the warning `status` is not an escalation)');
  assert.equal(workerFromAppFacts(wsOf(1), 1, T0, OPS, { ...f, msgs: [...f.msgs, { sequence: 77, kind: 'escalation', recipient: 'the-lead', body: 'x', created_at: T0 }] }).coordRead, 1, 'a copy to someone else is not read by the coordinator');
  assert.equal(workerFromAppFacts(wsOf(1), 1, T0, OPS, { ...f, lots: [{ from_seq: 0, to_seq: 100, acked_at: null }] }).coordRead, 0);
});

test('timings come from the record time and the bus row time, relative to the hogs\' start; absent rows leave them null (published = RED)', () => {
  const m = workerFromAppFacts(wsOf(1), 1, T0, OPS, facts(1).f);
  assert.equal(m.firstRowMs, 4200);
  assert.equal(m.firstEscMs, 4300);
  const n = workerFromAppFacts(wsOf(1), 1, T0, OPS, { ...facts(1).f, storeNotices: [], msgs: [] });
  assert.equal(n.firstRowMs, null);
  assert.equal(n.firstEscMs, null);
});

test('records and rows from BEFORE the cycle (an earlier cycle\'s kill) are not this cycle\'s', () => {
  const f = facts(1).f;
  const old = { ...f, storeNotices: f.storeNotices.map((e: { at: number }) => ({ ...e, at: T0 - 60_000 })), noticeText: f.noticeText.replace(/"at":\d+/g, `"at":${T0 - 60_000}`) };
  const m = workerFromAppFacts(wsOf(1), 1, T0, OPS, old);
  assert.deepEqual(m.memberKillRows, []);
  assert.deepEqual(m.records, []);
});

test('capStateFromKeeperLog reads the keeper\'s REAL summary line: the template is pinned against src/keeper/index.ts, every state maps to the probe\'s vocabulary', () => {
  const src = fs.readFileSync(new URL('../keeper/index.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('klog(`memory cap: ${capInfo.state.toUpperCase()} unit=${cap.unit} memory.max=${limit} cgroup=${dir}`)'), 'the keeper\'s summary line changed: capStateFromKeeperLog and keeperCapLine must follow');
  for (const st of ['active', 'unprotected', 'not-applied', 'no-scope']) assert.equal(capStateFromKeeperLog(keeperCapLine(st.toUpperCase(), 'u.scope')), st);
  assert.equal(capStateFromKeeperLog(''), null);
  assert.equal(capStateFromKeeperLog(undefined), null);
  assert.equal(capStateFromKeeperLog('memory cap: ACTIVE-ISH nothing'), null, 'a line that is not the summary line');
  assert.equal(capStateFromKeeperLog('memory-cap[ws]: keeper launched in scope u.scope (hard 1073741824 B, swap 0 B)'), null, 'the app\'s launch line says nothing about the keeper\'s cap state');
});

test('the seeded guard settings survive the app\'s own normalisation, and under them the real decision never holds Admission nor pauses at any reading above 0.6 GB (the run is voided at 2 GB)', () => {
  const seed = appMemoryGuardSeed(0.75, 1);
  const n = normalizeMemoryGuardSettings(seed);
  for (const k of Object.keys(seed) as Array<keyof typeof seed>) assert.equal(n[k], seed[k], `${k} was normalised away: the app would run its default and the rig would hold/pause`);
  const t = thresholdsFrom(n);
  for (const availGb of [9, 6, 4, 3.1, 2, 1, 0.7]) {
    const d = decideMemoryGuard(INITIAL_GUARD_STATE, availGb * G, t);
    assert.equal(d.state.admission, 'open', `the guard\'s Admission STATE is held at ${availGb} GB: the #289 alert opens an episode on that state (toggle or not) and bar:only_coordinator_told would read RED on a correct product`);
    assert.equal(isAdmissionHolding({ admission: d.state.admission, admissionEnabled: n.admissionEnabled }), false, `Admission holds at ${availGb} GB`);
    assert.equal(d.state.pause, 'none', `a memory Pause is due at ${availGb} GB`);
  }
  // below the seeded level the guard WOULD hold (the alert could then fire) — that is far under the run's 2 GB floor, which voids the run first; the toggle is the second line for the start gates
  const low = decideMemoryGuard(INITIAL_GUARD_STATE, 0.55 * G, t);
  assert.equal(low.state.admission, 'held');
  assert.equal(isAdmissionHolding({ admission: low.state.admission, admissionEnabled: n.admissionEnabled }), false, 'the toggle is OFF');
  assert.equal(low.state.pause, 'none', 'critical is 0.5 GB');
  // positive control: the DEFAULTS do hold / pause at those readings (the instrument can say yes)
  const dflt = thresholdsFrom(normalizeMemoryGuardSettings({}));
  assert.equal(decideMemoryGuard(INITIAL_GUARD_STATE, 4 * G, dflt).state.admission, 'held');
  assert.equal(decideMemoryGuard(INITIAL_GUARD_STATE, 2 * G, dflt).state.pause, 'held');
});

test('the Q11 envelope of the packaged run: inside it ⇒ null; every bound, a NaN option and the cap-OFF hogs\' TOTAL are refused (a NaN fails every `>` test)', () => {
  const ok = { members: 6, capGb: 1, softGb: 0.75, hogMb: 1174, capOn: true, waiver: 'D-Q11 ledger #329' };
  assert.equal(memhogAppEnvelope(ok), null, 'the granted run');
  assert.equal(memhogAppEnvelope({ ...ok, capGb: 0.6, softGb: 0.45, hogMb: 800, members: 3 }), null);
  const bad = (o: Record<string, unknown>) => memhogAppEnvelope({ ...ok, ...o }) !== null;
  assert.ok(bad({ members: 7 }), 'more than 6 members');
  assert.ok(bad({ members: 0 }));
  assert.ok(bad({ capGb: 1.5 }), 'cap above 1');
  assert.ok(bad({ capGb: 0.5, softGb: 0.4 }), 'cap-ON below 0.6 (soft below hard, so ONLY the floor refuses it)');
  assert.ok(bad({ capGb: Number('1GB') }), 'NaN cap: the app would run on its default 6 GiB');
  assert.ok(bad({ members: Number('six') }));
  assert.ok(bad({ softGb: Number('x') }));
  assert.ok(bad({ hogMb: Number('1g') }));
  assert.ok(bad({ hogMb: 1300 }), 'hog above 1200');
  assert.ok(bad({ softGb: 0.8 }), 'soft above 0.75');
  assert.ok(bad({ softGb: 1 }), 'soft above 0.75 and not below hard');
  assert.ok(bad({ capGb: 0.6, softGb: 0.7 }), 'soft within 0.75 but NOT below the hard level (ONLY that clause refuses it)');
  assert.ok(bad({ capGb: 0.6, softGb: 0.6 }), 'soft equal to hard');
  assert.ok(bad({ waiver: 'ledger #329' }), 'a waiver that does not name Q11');
  assert.ok(bad({ waiver: null }));
  // the cap-OFF control: no waiver, any cap ≤ 1 (default 0.25), but the hogs no scope bounds are bounded in TOTAL
  const off = { members: 3, capGb: 0.25, softGb: 0.19, hogMb: 406, capOn: false, waiver: null };
  assert.equal(memhogAppEnvelope(off), null, 'the plan\'s cap-OFF run: 3 × 406 MB');
  assert.ok(memhogAppEnvelope({ ...off, softGb: Number('x') }) !== null, 'a non-number is refused on the OFF control too (the finite guard is first, not an accident of a later comparison)');
  assert.ok(memhogAppEnvelope({ ...off, members: 6, hogMb: 1200 }) !== null, '7200 MB of unbounded hogs');
  assert.equal(memhogAppEnvelope({ ...off, members: 3, hogMb: 1200 }), null, 'exactly 3600 MB is allowed');
  assert.ok(memhogAppEnvelope({ ...off, members: 4, hogMb: 1200 }) !== null);
  assert.ok(memhogAppEnvelope({ ...off, members: 7 }) !== null, 'members bound applies to the OFF control too');
});

test('D-Q15: the cap-ON packaged run takes BOTH heavy tokens (two distinct refs, A,B) and starts from 11 GB; the cap-OFF control takes one token', () => {
  assert.equal(CAP_ON_START_GB, 11);
  assert.equal(heavyTokensWhy({ heavy: 'tokA,tokB', capOn: true }), null);
  assert.equal(heavyTokensWhy({ heavy: ' tokA , tokB ', capOn: true }), null);
  for (const bad of ['tokA', 'tokA,tokA', 'tokA,', ',tokB', 'a,b,c', '']) assert.notEqual(heavyTokensWhy({ heavy: bad, capOn: true }), null, `cap-ON with ${JSON.stringify(bad)}`);
  assert.equal(heavyTokensWhy({ heavy: 'tokA', capOn: false }), null, 'the cap-OFF control: one token');
  assert.notEqual(heavyTokensWhy({ heavy: '', capOn: false }), null, 'no token at all');
  assert.notEqual(heavyTokensWhy({ heavy: undefined, capOn: true }), null);
});

test('OPS 7283 (D-Q14): a cap-state flip AFTER boot reaches only keepers/<ws>.log — every `memory cap:` line that is not a known benign one is a degradation, the bar goes RED on it even though the boot summary still says ACTIVE', () => {
  const src = fs.readFileSync(new URL('../keeper/index.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('`[keeper ${new Date().toISOString()}] ${msg}\\n`'), 'the keeper log line format changed: capDegradationsFromKeeperLog strips this prefix');
  for (const benign of ['memory cap: DBUS_SESSION_BUS_ADDRESS removed from the CLI env', 'memory cap: notice file budget for', 'memory cap: the placement tripwire is NOT armed', 'memory cap: the placement tripwire gave up after']) assert.ok(src.includes(benign), `the keeper no longer logs "${benign}": the benign list is stale`);
  // the degradation texts the keeper REALLY writes (#332-fu): the examples below mirror these, and none of them is benign
  for (const real of ['memory cap: TRIPWIRE — ', 'memory cap: WARNING — the tool wrapper could not be RUN', 'memory cap: WARNING — the tool wrapper probe TIMED OUT', 'memory cap: the tool wrapper did NOT place a probe command in the work leaf', 'is not delegated or its leaves could not be built', 'memory cap: NOT in scope', 'the swap escape is open']) assert.ok(src.includes(real), `the keeper no longer logs "${real}": the degradation examples are stale`);
  const L = (msg: string) => `[keeper 2026-10-11T10:00:00.000Z] ${msg}\n`;
  const boot = L('memory cap: ACTIVE unit=u.scope memory.max=1073741824 cgroup=/x/u.scope/w');
  // benign lines only → nothing
  assert.deepEqual(capDegradationsFromKeeperLog(boot + L('memory cap: DBUS_SESSION_BUS_ADDRESS removed from the CLI env (a browser would leave the scope through the session bus)') + L('memory cap: the placement tripwire is NOT armed — /x/cpu.stat is unreadable; the state stays active on the probe\'s word alone') + L('memory cap: the placement tripwire gave up after 40 tool results — cpu.stat stayed unreadable') + L('memory cap: notice file budget for kills full - later ones are only in the keeper log') + L('listening /tmp/x.sock pid=1')), []);
  assert.deepEqual(capDegradationsFromKeeperLog(''), []);
  assert.deepEqual(capDegradationsFromKeeperLog(undefined), []);
  // every degradation text the keeper can write, after the ACTIVE summary
  for (const bad of [
    'memory cap: TRIPWIRE — 5 Bash tool results came back but the work leaf was charged no CPU time since the probe: NOTHING is capped',
    'memory cap: WARNING — the tool wrapper could not be RUN (2 attempts: ENOENT) — the shell prefix is NOT set',
    'memory cap: the tool wrapper did NOT place a probe command in the work leaf (saw /x/k; expected /x/w) — NOTHING is capped at the hard level',
    'memory cap: scope u.scope is not delegated or its leaves could not be built (mkdir: EACCES) — the cap is NOT applied',
    'memory cap: NOT in scope u.scope (cgroup /user.slice) — the keeper was launched plain; no cap, no watch',
    'memory cap: some line a later release adds',
  ]) {
    const d = capDegradationsFromKeeperLog(boot + L(bad));
    assert.equal(d.length, 1, bad);
    assert.ok(!d[0].startsWith('[keeper'), 'the log prefix is stripped');
  }
  // end to end through the facts: the boot summary says ACTIVE, a later TRIPWIRE line flips the bar
  const w = wsOf(1);
  const f = facts(1).f;
  const flipped = workerFromAppFacts(w, 1, T0, OPS, { ...f, keeperLog: boot + L('memory cap: TRIPWIRE — 5 Bash tool results came back but the work leaf was charged no CPU time') });
  assert.equal(flipped.session.capState, 'active', 'the summary alone would have missed the flip');
  assert.equal(flipped.session.capDegradations.length, 1);
  const cycleOf = (wk: unknown) => ({ exercise: 'memhog-app', cycle: 1, expectWorkers: 1, capGb: 1, opsId: OPS, leadSeen: 0, workers: [wk], tMemberToldS: 1, tCoordToldS: 1 });
  assert.deepEqual(red(cycleOf(flipped) as ReturnType<typeof cycle>), ['bar:cap_holds_after_kill']);
  assert.deepEqual(red(cycleOf(workerFromAppFacts(w, 1, T0, OPS, { ...f, keeperLog: boot })) as ReturnType<typeof cycle>), [], 'control: the same facts without the flip line are green');
});

test('run.mjs wiring (found by the first real attempt of the proof\'s cap-OFF arm): the up-front Q11 check treats the proof\'s memhog-app arm as the cap-OFF control — capOn is MH_CAP_ON, which excludes --proof and a switch OFF — and both tokens/start bar hang on the same flag', () => {
  const src = fs.readFileSync(new URL('../../scripts/pause-canary/run.mjs', import.meta.url), 'utf8');
  assert.match(src, /const MH_CAP_ON = MH_ON && !flag\('proof'\) && opt\('memhog-switch', 'on'\) === 'on';/);
  assert.match(src, /const capOn = MH_CAP_ON;/);
  assert.match(src, /const MH_FULL_RUN = MH_CAP_ON && !REHEARSAL;/);   // the tokens and the start bar hang on the FULL run (the rehearsal has its own test below)
});

test('run.mjs wiring of the labelled 1-member REHEARSAL (OPS 7313): one token and the 9 GB start apply to it, the full Q11 run keeps both tokens and 11 GB, the rehearsal is refused for anything but 1 member cap-ON, and it is labelled DRY in the report and the final line', () => {
  const run = fs.readFileSync(new URL('../../scripts/pause-canary/run.mjs', import.meta.url), 'utf8');
  const drive = fs.readFileSync(new URL('../../scripts/pause-canary/drive.mjs', import.meta.url), 'utf8');
  assert.match(run, /const MH_FULL_RUN = MH_CAP_ON && !REHEARSAL;/);
  assert.match(run, /MH_FULL_RUN \? CAP_ON_START_GB : MH_ON \? 9 : 0/);
  assert.match(run, /heavyTokensWhy\(\{ heavy: HEAVY, capOn: MH_FULL_RUN \}\)/);
  assert.match(run, /if \(REHEARSAL && !\(MH_CAP_ON && Number\(opt\('members', '6'\)\) === 1\)\)/);
  assert.match(run, /DRY REHEARSAL \(1 member, plumbing; NOT the Q11 run\)/);
  assert.match(run, /PAUSE-CANARY\$\{REHEARSAL \? ' DRY-REHEARSAL \(plumbing, not the Q11 run\)' : ''\}/);
  assert.match(run, /\.\.\.\(REHEARSAL \? \['--rehearsal'\] : \[\]\)/);
  assert.match(drive, /MH_ON_APP && !REHEARSAL \? CAP_ON_START_GB : MH_APP \? 9 : 0/);
});

test('wiring pins (review 4): the packaged driver reads MemAvailable every 250 ms and the first reading under the floor stops the hog tools and VOIDs the run; run.mjs refuses to start from inside a member leaf / at adj > 0', () => {
  const drive = fs.readFileSync(new URL('../../scripts/pause-canary/drive.mjs', import.meta.url), 'utf8');
  const run = fs.readFileSync(new URL('../../scripts/pause-canary/run.mjs', import.meta.url), 'utf8');
  assert.match(drive, /const floorGuard = MH_APP \? setInterval\(\(\) => \{/);
  assert.match(drive, /if \(a >= RUN_FLOOR_GB\) return;/);
  assert.match(drive, /killHogs\(curRig\.H\)/);
  assert.match(drive, /\}, 250\) : null;/);
  assert.match(drive, /voidReason = `FLOOR: /);
  assert.match(drive, /if \(floorGuard\) clearInterval\(floorGuard\);/);
  assert.match(run, /const placement = ownPlacementWhy\(\);/);
});
