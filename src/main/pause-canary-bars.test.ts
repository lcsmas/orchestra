// Pause canary (#258, wave F ledger #281): the drill instruments each have a must-FAIL fixture — a bar crossed, a metric absent, a lost marker, a forbidden request all read RED.
// The same instruments are proven on the PACKAGED app by `pnpm run canary:pause-proof` (build-level mutants); this is the cheap unit layer under it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { BARS, evaluateCycle, lostWorkOf, forbiddenRequests, renderTable } from '../../scripts/pause-canary/bars.mjs';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { MUTANTS, applyEdits } from '../../scripts/pause-canary/mutants.mjs';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { fleetSpec, KIND_ORDER } from '../../scripts/pause-canary/ids.mjs';

type Check = { id: string; ok: boolean; detail: string };
const good = (over: Record<string, unknown> = {}) => ({
  mode: 'hard',
  tAllPausedS: 12.3,
  tAllResumedS: 31.4,
  lostWork: { markers: 40, lostCount: 0, lost: [], branches: 10, branchesIntact: 10 },
  selfRestarts: { members: [], probes: 3, detail: '' },
  repriseAccused: { n: 12, m: 12, missing: [] },
  rosterMin: 12,
  ...over,
});
const red = (cs: Check[]) => cs.filter((c) => !c.ok).map((c) => c.id);

test('a clean hard cycle is GREEN on every check', () => {
  assert.deepEqual(red(evaluateCycle(good())), []);
});

test('Pause dure bar: 59.9 s passes, 60.0 s and NOT MEASURED are RED (the bar is < 60 s and absence is never a pass)', () => {
  assert.deepEqual(red(evaluateCycle(good({ tAllPausedS: 59.9 }))), []);
  assert.deepEqual(red(evaluateCycle(good({ tAllPausedS: 60 }))), ['bar:hard_all_paused_lt_60s']);
  assert.deepEqual(red(evaluateCycle(good({ tAllPausedS: null }))), ['bar:hard_all_paused_lt_60s']);
  assert.deepEqual(red(evaluateCycle(good({ tAllPausedS: Number.NaN }))), ['bar:hard_all_paused_lt_60s']);
});

test('lost work: ONE lost marker, one non-intact branch, no markers at all, or no measurement are each RED', () => {
  assert.deepEqual(red(evaluateCycle(good({ lostWork: { markers: 40, lostCount: 1, lost: ['w1: x'], branches: 10, branchesIntact: 10 } }))), ['bar:lost_work_is_zero']);
  assert.deepEqual(red(evaluateCycle(good({ lostWork: { markers: 40, lostCount: 0, lost: [], branches: 10, branchesIntact: 9 } }))), ['bar:lost_work_is_zero']);
  assert.deepEqual(red(evaluateCycle(good({ lostWork: { markers: 0, lostCount: 0, lost: [], branches: 10, branchesIntact: 10 } }))), ['bar:lost_work_is_zero'], 'zero markers checked is a vacuous pass');
  assert.deepEqual(red(evaluateCycle(good({ lostWork: { markers: 40, lostCount: 0, lost: [], branches: 0, branchesIntact: 0 } }))), ['bar:lost_work_is_zero'], 'no branch checked is a vacuous pass');
  assert.deepEqual(red(evaluateCycle(good({ lostWork: undefined }))), ['bar:lost_work_is_zero']);
});

test('self-restarts: one member, or a probe-less measurement (the wake attempt never landed), or no measurement are RED', () => {
  assert.deepEqual(red(evaluateCycle(good({ selfRestarts: { members: ['pc-w3'], probes: 3 } }))), ['bar:no_self_restart']);
  assert.deepEqual(red(evaluateCycle(good({ selfRestarts: { members: [], probes: 0 } }))), ['bar:no_self_restart']);
  assert.deepEqual(red(evaluateCycle(good({ selfRestarts: undefined }))), ['bar:no_self_restart']);
});

test('accusés: a missing accusé, an empty roster, a roster smaller than the fleet, or no measurement are RED', () => {
  assert.deepEqual(red(evaluateCycle(good({ repriseAccused: { n: 11, m: 12, missing: ['pc-w4'] } }))), ['bar:every_member_reprise_accused']);
  assert.deepEqual(red(evaluateCycle(good({ repriseAccused: { n: 0, m: 0, missing: [] } }))), ['bar:every_member_reprise_accused']);
  assert.deepEqual(red(evaluateCycle(good({ repriseAccused: { n: 5, m: 5, missing: [] } }))), ['bar:every_member_reprise_accused'], 'a roster that lost members is not "all accused"');
  assert.deepEqual(red(evaluateCycle(good({ repriseAccused: undefined }))), ['bar:every_member_reprise_accused']);
});

test('time to all-resumed is published: absent = RED (it can never be silently dropped from the table)', () => {
  assert.deepEqual(red(evaluateCycle(good({ tAllResumedS: null }))), ['published:time_to_all_resumed']);
});

const soft = (over: Record<string, unknown> = {}) => good({ mode: 'soft', deadlineS: 180, escalatedAtS: 180.4, tAllPausedS: 183.1, rosterMin: 12, pauseAccused: { n: 12, m: 12, via: { member: 6, trap: 1 } }, ...over });

test('Pause douce bars: the 3-min deadline is a CONSTANT of the harness (an app deadline of 10 min reads RED, even when escalation is "on time" by ITS clock)', () => {
  assert.equal(BARS.softDeadlineS, 180, 'the ticket\'s 3 min');
  assert.deepEqual(red(evaluateCycle(soft())), []);
  assert.deepEqual(red(evaluateCycle(soft({ escalatedAtS: 185 }))), []);
  assert.deepEqual(red(evaluateCycle(soft({ escalatedAtS: 185.5, tAllPausedS: 190 }))), ['bar:soft_escalated_by_deadline']);
  assert.deepEqual(red(evaluateCycle(soft({ deadlineS: 600, escalatedAtS: 600.4, tAllPausedS: 603 }))), ['bar:soft_deadline_is_3_min', 'bar:soft_escalated_by_deadline'], 'a regressed deadline: both the deadline and the escalation time are RED');
  assert.deepEqual(red(evaluateCycle(soft({ deadlineS: 600 }))), ['bar:soft_deadline_is_3_min']);
  assert.deepEqual(red(evaluateCycle(soft({ deadlineS: 181 }))), [], 'the app\'s deadline tolerance is ±1 s');
  assert.deepEqual(red(evaluateCycle(soft({ deadlineS: 181.5 }))), ['bar:soft_deadline_is_3_min']);
  assert.deepEqual(red(evaluateCycle(soft({ deadlineS: 178.9 }))), ['bar:soft_deadline_is_3_min']);
  assert.deepEqual(red(evaluateCycle(soft({ deadlineS: null }))), ['bar:soft_deadline_is_3_min']);
  assert.deepEqual(red(evaluateCycle(soft({ escalatedAtS: null, tAllPausedS: null }))), ['bar:soft_escalated_by_deadline', 'bar:soft_all_paused_lt_deadline_plus_hard_bar']);
  assert.deepEqual(red(evaluateCycle(soft({ tAllPausedS: 180.4 + 60 }))), ['bar:soft_all_paused_lt_deadline_plus_hard_bar']);
});

test('douce accusés: a missing accusé, an empty roster, or a roster smaller than the fleet (3/3 out of 12) is RED', () => {
  assert.deepEqual(red(evaluateCycle(soft({ pauseAccused: { n: 11, m: 12, via: {} } }))), ['bar:every_member_pause_accused']);
  assert.deepEqual(red(evaluateCycle(soft({ pauseAccused: { n: 3, m: 3, via: {} } }))), ['bar:every_member_pause_accused']);
  assert.deepEqual(red(evaluateCycle(soft({ pauseAccused: undefined }))), ['bar:every_member_pause_accused']);
});

test('lostWorkOf: a marker is lost only when its needle is in NONE of branch / pushed / pause ref; a non-ancestor branch is lost', () => {
  const mk = (found: Record<string, string | null>) => ({ id: 'w1', branchIntact: true, markers: [{ name: 'mark', needle: 'MARK w1 c1', found }] });
  assert.equal(lostWorkOf([mk({ branch: null, pushed: null, ref: 'MARK w1 c1\n' })]).lostCount, 0, 'only in the pause ref');
  assert.equal(lostWorkOf([mk({ branch: null, pushed: 'MARK w1 c1\n', ref: null })]).lostCount, 0, 'only pushed');
  assert.equal(lostWorkOf([mk({ branch: 'MARK w1 c1', pushed: null, ref: null })]).lostCount, 0, 'only in the branch');
  assert.equal(lostWorkOf([mk({ branch: null, pushed: null, ref: null })]).lostCount, 1, 'nowhere');
  assert.equal(lostWorkOf([mk({ branch: 'MARK w9 c9', pushed: 'other', ref: 'MARK w1 c2' })]).lostCount, 1, 'a different cycle/member needle is not a hit');
  const r = lostWorkOf([{ id: 'w2', branchIntact: false, branchDetail: 'rewound', markers: [] }]);
  assert.equal(r.lostCount, 1);
  assert.equal(r.branchesIntact, 0);
});

test('forbiddenRequests: a tool-carrying request inside a window is flagged; outside it, side requests (no tools), other roles and a released worker are not', () => {
  const reqs = [
    { t: 100, role: 'w1', tools: 5 }, { t: 150, role: 'w1', tools: 0 }, { t: 200, role: 'w2', tools: 5 }, { t: 400, role: 'w1', tools: 5 }, { t: 500, role: 'w2', tools: 5 },
  ];
  const hold = forbiddenRequests(reqs, [{ role: '*', from: 120, until: 300, label: 'hold' }]);
  assert.deepEqual(hold.map((h: { t: number }) => h.t), [200]);
  const before = forbiddenRequests(reqs, [{ role: 'w2', from: 0, until: 450 }, { role: 'w1', from: 0, until: 50 }]);
  assert.deepEqual(before.map((h: { t: number }) => h.t), [200], 'w2 asked before its release (450); w1 was released at 50 so its requests are legit');
  assert.equal(forbiddenRequests(reqs, [{ role: 'w1', from: 120, until: null }]).length, 1, 'an open window (never released) flags every later request');
  const lp = forbiddenRequests([{ t: 130, role: 'w3', tools: 1, limitPrompt: true }, { t: 140, role: 'w3', tools: 1 }], [{ role: '*', from: 120, until: 300 }]);
  assert.deepEqual(lp.map((h: { limitPrompt: boolean }) => h.limitPrompt), [true, false], 'the limit-prompt flag is carried so the drive can exempt BY CONTENT, never by a time window');
  const edge = [{ t: 120, role: 'w1', tools: 1 }, { t: 300, role: 'w1', tools: 1 }];
  assert.deepEqual(forbiddenRequests(edge, [{ role: '*', from: 120, until: 300 }]).map((h: { t: number }) => h.t), [120], 'from is inclusive, until is exclusive (a worker released AT t may start AT t)');
});

// fragments of the REAL minified bundle (identifiers change per build; the second test renames them to prove the anchors are name-agnostic and the edits stay same-length)
const FRAGMENTS: Record<string, string> = {
  'skip-snapshot': 'Oe(e,["add","-A","--ignore-errors","--",...m],u,void 0,[1],c)};let g;try{g=await Oe(e,["add","-A","--ignore-errors",`--pathspec-from-file=${h}`,"--pathspec-file-nul"],u)}',
  'skip-kill': 'readTable:()=>{if(!e)return[];const t=[];let n;try{n=S.readdirSync("/proc")}catch{return t}},signal:(t,n)=>{try{return process.kill(t,n),!0}catch{return!1}}}}function y_(e,t){}',
  'slow-detect': 'Ec=!1;const vc=15e3,sx=250;let Zc=!1;async function Xo(e){}',
  'gate-ignores-pause': 'for(const c of s){const u=Ki(e,c);if(u&&u.pausedAt!==null&&u.switchOn){if(!(r!=null&&r.includeReleased)&&u.resumeStartedAt!==null)continue;return rd(u,u.pausedAt)}}',
  'no-confirm-reprise': 'e.prepare("UPDATE pause_members SET reprise_confirmed_at = ? WHERE run_id = ? AND paused_at = ? AND ws_id = ?").run(n,i.run_id)',
  'no-deadline-escalation': 'const l=a.length>0&&o.confirmed===a.length;return l||r>=s?(Fy(t,n.runId,n.pausedAt,r)&&(o.escalated=l?"all-confirmed":"deadline",y.info(`x`)),o.pending=[],{sum:o,dueAt:null}):{sum:o,dueAt:s}',
  'no-auto-pause': 'prepare(`UPDATE runs SET paused_at = ?, pause_mode = \'hard\', pause_auto = ?\n        WHERE id = ? AND paused_at IS NULL`).run(d,wm,sr(f,d),u).changes===1',
};

test('every build-level mutant matches its anchor in a real-bundle fragment — also with renamed identifiers — and changes it WITHOUT changing its length (asar offsets stay valid)', () => {
  assert.deepEqual(Object.keys(FRAGMENTS).sort(), Object.keys(MUTANTS).sort(), 'every mutant has a fragment');
  for (const [name, m] of Object.entries(MUTANTS) as Array<[string, { exercise: string; redden: string[]; edits: Array<{ expect: number }> }]>) {
    assert.ok(['douce', 'dure', 'reprise', 'auto'].includes(m.exercise), `${name} exercise`);
    assert.ok(m.redden.length > 0, `${name} names the check it must redden`);
    const frag = FRAGMENTS[name];
    const r = applyEdits(frag, m.edits as never);
    assert.ok(r.hits.every((h: number) => h >= 1), `${name}: every edit hits the real fragment (${r.hits})`);
    assert.equal(r.out.length, frag.length, `${name}: same length`);
    assert.notEqual(r.out, frag, `${name}: the edit changes something`);
    assert.ok((applyEdits(r.out, m.edits as never).hits as number[]).every((h) => h === 0), `${name}: the mutated text no longer matches its anchor (idempotent)`);
  }
});

test('the regex anchors are name-agnostic: the same mutants still apply when the minifier renames the identifiers (and the pause-kill anchor does not match the resource reaper)', () => {
  const renamed = (name: string) => FRAGMENTS[name].replace(/signal:\(t,n\)=>\{try\{return process\.kill\(t,n\)/, 'signal:(tt,nn)=>{try{return process.kill(tt,nn)').replace(/const vc=15e3,sx=250/, 'const vcc=15e3,sxx=250').replace(/\(Fy\(t,n\.runId,n\.pausedAt,r\)&&\(o\.escalated=l\?/, '(Fyy(tt,nn.runId,nn.pausedAt,rr)&&(oo.escalated=l?').replace('l||r>=s?', 'l||rr>=s?');
  for (const name of ['skip-kill', 'slow-detect', 'no-deadline-escalation']) {
    const frag = renamed(name);
    const r = applyEdits(frag, (MUTANTS as Record<string, { edits: never }>)[name].edits);
    assert.ok(r.hits.every((h: number) => h === 1), `${name} renamed: ${r.hits}`);
    assert.equal(r.out.length, frag.length, `${name} renamed: same length`);
  }
  const reaper = 'readProcStat:e=>{},readCmdline:e=>{},signal:(e,t)=>{try{return process.kill(e,t),!0}catch{return!1}},sleep:e=>new Promise(t=>setTimeout(t,e))';
  assert.deepEqual(applyEdits(reaper, MUTANTS['skip-kill'].edits).hits, [0], 'the resource reaper has its own `signal` and must NOT be patched (readTable anchors the pause-kill deps)');
});

test('the dummy fleet always carries a blocked member and a quota member from 3 workers up, and 10 workers = 5 obey + bg + blocked + 3 quota', () => {
  const kinds = (n: number) => fleetSpec(n).workers.map((w: { kind: string }) => w.kind);
  for (const n of [3, 5, 10]) { assert.ok(kinds(n).includes('blocked'), `${n}: blocked`); assert.ok(kinds(n).includes('quota'), `${n}: quota`); }
  assert.equal(kinds(6).filter((k: string) => k === 'quota').length, 3, '6 workers (the OPS-decided canary size) keep one quota member per cycle');
  assert.ok(kinds(6).includes('bg') && kinds(6).includes('blocked') && kinds(6).includes('obey'));
  const ten = kinds(10);
  assert.equal(ten.length, 10);
  assert.equal(ten.filter((k: string) => k === 'obey').length, 5);
  assert.equal(ten.filter((k: string) => k === 'quota').length, 3);
  assert.deepEqual(KIND_ORDER.slice(0, 3), ['obey', 'blocked', 'quota']);
  assert.throws(() => fleetSpec(11));
  assert.equal(new Set(fleetSpec(10).workers.map((w: { id: string }) => w.id)).size, 10);
});

test('renderTable prints one row per cycle with the verdict (a FAIL row names its red checks)', () => {
  const ok = { exercise: 'dure', cycle: 1, workers: 10, rosterSize: 12, mode: 'hard', tAllPausedS: 12.3, tAllResumedS: 31.4, lostWork: { markers: 40, lostCount: 0, branches: 10, branchesIntact: 10 }, selfRestarts: { members: [] }, repriseAccused: { n: 12, m: 12 }, checks: [{ id: 'bar:x', ok: true, detail: '' }] };
  const bad = { ...ok, cycle: 2, checks: [{ id: 'bar:lost_work_is_zero', ok: false, detail: '' }] };
  const t = renderTable([ok, bad]);
  assert.match(t, /\| dure \| 1 \| 10\/12 \| 12\.3 \| — \| 31\.4 \| 0\/40 \| 10\/10 \| 0 \| 12\/12 \| PASS \|/);
  assert.match(t, /FAIL \(lost_work_is_zero\)/);
  assert.equal(BARS.hardAllPausedS, 60, 'the bar the ticket states');
});
