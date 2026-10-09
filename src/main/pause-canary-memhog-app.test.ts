// Pause canary 1b (#324) — the PACKAGED path's fact shaping (scripts/pause-canary/memhog-app-facts.mjs) fed by the REAL producers: the keeper's notice file (`appendMemNotice`), the store's `sdkMemNotices` entries (`memNoticeEntryOf`) and the
// coordinator's bus body (`memBusBody`). The Q11 run is ONE run: a wrong field name or a file-format surprise must be found here, not there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { workerFromAppFacts, parseNoticeFile, capStateFromKeeperLog, appMemoryGuardSeed } from '../../scripts/pause-canary/memhog-app-facts.mjs';
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
const keeperCapLine = (state: string, unit: string) => `2026-10-09T10:00:00.000Z [keeper] memory cap: ${state} unit=${unit} memory.max=${GIB} cgroup=/sys/fs/cgroup/user.slice/${unit}\n`;

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

test('the seeded guard settings survive the app\'s own normalisation, and under them the real decision never holds Admission nor pauses at the readings the six hogs leave (start 9 GB − ~6 GB)', () => {
  const seed = appMemoryGuardSeed(0.75, 1);
  const n = normalizeMemoryGuardSettings(seed);
  for (const k of Object.keys(seed) as Array<keyof typeof seed>) assert.equal(n[k], seed[k], `${k} was normalised away: the app would run its default and the rig would hold/pause`);
  const t = thresholdsFrom(n);
  for (const availGb of [9, 6, 4, 3.1, 2]) {
    const d = decideMemoryGuard(INITIAL_GUARD_STATE, availGb * G, t);
    assert.equal(d.state.admission, 'open', `the guard\'s Admission state is held at ${availGb} GB: the #289 alert would escalate to the LEAD and bar:only_coordinator_told would read RED on a correct product`);
    assert.equal(isAdmissionHolding({ admission: d.state.admission, admissionEnabled: n.admissionEnabled }), false, `Admission holds at ${availGb} GB`);
    assert.equal(d.state.pause, 'none', `a memory Pause is due at ${availGb} GB`);
  }
  // the toggle is the second line: at 1 GB (below the seeded 1.5 GB level) the guard WOULD hold, the OFF toggle keeps the start gates open
  const low = decideMemoryGuard(INITIAL_GUARD_STATE, 1 * G, t);
  assert.equal(low.state.admission, 'held');
  assert.equal(isAdmissionHolding({ admission: low.state.admission, admissionEnabled: n.admissionEnabled }), false, 'the toggle is OFF');
  assert.equal(low.state.pause, 'none', 'critical is 0.5 GB');
  // positive control: the DEFAULTS do hold / pause at those readings (the instrument can say yes)
  const dflt = thresholdsFrom(normalizeMemoryGuardSettings({}));
  assert.equal(decideMemoryGuard(INITIAL_GUARD_STATE, 4 * G, dflt).state.admission, 'held');
  assert.equal(decideMemoryGuard(INITIAL_GUARD_STATE, 2 * G, dflt).state.pause, 'held');
});
