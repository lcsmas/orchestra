// Pause canary (#258, wave F ledger #281): the drill instruments each have a must-FAIL fixture — a bar crossed, a metric absent, a lost marker, a forbidden request all read RED.
// The same instruments are proven on the PACKAGED app by `pnpm run canary:pause-proof` (build-level mutants); this is the cheap unit layer under it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { BARS, evaluateCycle, lostWorkOf, forbiddenRequests, holdWindows, holdWindowGaps, isMemberTool, isTurnStart, mustFailVerdict, renderTable } from '../../scripts/pause-canary/bars.mjs';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { MUTANTS, applyEdits } from '../../scripts/pause-canary/mutants.mjs';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { fleetSpec, KIND_ORDER } from '../../scripts/pause-canary/ids.mjs';
// @ts-expect-error — plain .mjs harness module, no declaration file
import { keeperSocketOf, assertNoForeignKeeperSockets, isTransientName, liveSnapshot, kindOf as realKindOf, startApi } from '../../scripts/pause-canary/lib.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  'skip-kill': 'readTable:()=>{if(!e)return[];const t=[];let n;try{n=S.readdirSync("/proc")}catch{return t}},signal:(t,n)=>{try{return process.kill(t,n),!0}catch{return!1}}}}function y_(e,t){} async function fU(e,t){const n=V.get(e);if(!n||n.stopping)return{ok:!1,note:"x"};try{return await n.q.stopTask(t),{ok:!0}}catch(r){return{ok:!1}}}',
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
  assert.deepEqual(applyEdits(reaper, MUTANTS['skip-kill'].edits).hits, [0, 0], 'the resource reaper has its own `signal` and must NOT be patched (readTable anchors the pause-kill deps)');
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

test('workspace ids are RANDOM PER RIG, UUID-shaped and unique inside a fleet (two concurrent rigs must never share a ws id: the keeper socket fallback is home-independent)', () => {
  const a = fleetSpec(10), b = fleetSpec(10);
  const ids = (s: { lead: string; ops: string; workers: Array<{ id: string }> }) => [s.lead, s.ops, ...s.workers.map((w) => w.id)];
  assert.equal(new Set(ids(a)).size, 12);
  assert.equal(ids(a).filter((id: string) => ids(b).includes(id)).length, 0, 'two rigs share NO workspace id');
  for (const id of ids(a)) assert.match(id, /^[0-9a-f]{8}-0000-4000-8000-\d{12}$/);
  assert.notEqual(a.prefix, b.prefix);
  assert.equal(fleetSpec(3, 'deadbeef').lead, 'deadbeef-0000-4000-8000-000000000001', 'an explicit prefix is honoured (the seed receives the SAME ids)');
});

test('keeperSocketOf mirrors keeper-client.ts: <= 100 chars stays in the rig, longer falls back to the home-independent /tmp/okeeper-<sha256(wsId)[:16]>', () => {
  const id = 'deadbeef-0000-4000-8000-000000000011';
  const short = keeperSocketOf('/h/x', id);
  assert.equal(short.hashed, false);
  assert.equal(short.path, `/h/x/keepers/${id}.sock`);
  const long = keeperSocketOf('/home/lmas/.cache/pause-canary/h-canary6c-douce-douce', id);
  assert.equal(long.hashed, true);
  assert.equal(long.len, 103 - 36 + id.length + 0, 'the measured 103-char rig path');
  // os.tmpdir(), not a literal /tmp: keeper-client.ts honours TMPDIR (the release gate sets it).
  assert.equal(long.path, path.join(os.tmpdir(), `okeeper-${createHash('sha256').update(id).digest('hex').slice(0, 16)}.sock`));
});

test('pre-flight: a keeper socket ALREADY at a path this rig would use (another rig, same ws id) aborts the rig; absent sockets pass', () => {
  const spec = fleetSpec(3);
  const H = '/home/lmas/.cache/pause-canary/h-unit-preflight-check-for-a-long-rig-label-xx';
  const first = keeperSocketOf(H, spec.workers[0].id);
  assert.equal(first.hashed, true, 'the fixture path is long enough to take the /tmp fallback');
  assert.doesNotThrow(() => assertNoForeignKeeperSockets(H, spec));
  fs.writeFileSync(first.path, '');
  try {
    assert.throws(() => assertNoForeignKeeperSockets(H, spec), /already exist/);
  } finally { fs.rmSync(first.path, { force: true }); }
  assert.doesNotThrow(() => assertNoForeignKeeperSockets(H, spec), 'cleaned up again');
});

// a tiny rig census: each entry carries its own `kind` (what lib.mjs `kindOf` derives from the cmdline)
type P = { pid: number; ppid: number; kind: string; cwd: string; cmd: string };
const proc = (pid: number, ppid: number, kind: string, cmd: string, cwd = '/h/rig'): P => ({ pid, ppid, kind, cwd, cmd });
const CENSUS: P[] = [
  proc(100, 1, 'app', '/app/orchestra --ozone-platform=wayland'),
  proc(101, 100, 'app', '/app/orchestra --type=utility'),
  proc(200, 100, 'keeper', '/app/orchestra keeper.js w3', '/h/rig/wt-w3'),            // the keeper is a child of the app
  proc(201, 200, 'claude', '/h/rig/bin/claude --output-format stream-json', '/h/rig/wt-w3'),
  proc(202, 201, 'tool-shell', '/usr/bin/zsh -c sleep 7400', '/h/rig/wt-w3'),
  proc(203, 202, 'tool-sleep', 'sleep 7400', '/h/rig/wt-w3'),
  proc(300, 100, 'other', 'git ls-files --others --exclude-standard', '/h/rig/wt-w5'),    // F3's capture: the APP's own git, ppid = app
  proc(301, 101, 'other', 'git status --porcelain', '/h/rig/wt-w5'),                       // via an Electron utility process
  proc(302, 300, 'other', 'git-remote-helper', '/h/rig/wt-w5'),                            // …and ITS child
  proc(400, 1, 'tool-sleep', 'sleep 7402', '/h/rig/wt-w4'),                                // an ORPHAN: its tree is gone, ppid 1 is outside the rig
  proc(500, 100, 'other', '/app/orchestra cli run confirm pause', '/h/rig/wt-w1'),         // an `orchestra cli` client of the app
  proc(501, 202, 'other', '/app/orchestra cli run confirm pause', '/h/rig/wt-w3'),         // …and one run by a member\'s OWN tool shell (its ancestry reaches the CLI: only the cmd exclusion keeps it out)
  proc(600, 200, 'tool-sleep', 'sleep 1', '/h/rig'),                                       // not in a member worktree
  proc(310, 1, 'app', '/app/orchestra --type=fake-app-helper', '/h/rig/wt-w5'),            // an app-kind process whose cwd IS a member worktree (the app-git arm's helper) — only its kind keeps it out (verifier MA4)
];
const byPid = new Map(CENSUS.map((x) => [x.pid, x]));
const memberOf = (x: P) => /^\/h\/rig\/wt-([a-z0-9]+)/.exec(x.cwd)?.[1] ?? null;
const kindOf = (x: P) => x.kind;
const isTool = (pid: number) => isMemberTool(byPid.get(pid), byPid, kindOf, memberOf);

test('isMemberTool: a member\'s own tree counts (even though its keeper is a child of the app); an orphan counts', () => {
  assert.equal(isTool(203), true, 'sleep ← zsh ← claude ← keeper ← app: stops at the CLI, a tool');
  assert.equal(isTool(202), true, 'the tool shell itself');
  assert.equal(isTool(400), true, 'an orphaned killed command that escaped its tree is exactly what the instrument must see');
});

test('isMemberTool: the APP\'s own git in a member worktree is NOT a member restarting (F3\'s false positive: ppid = app, 31 s after the trap), directly or through an Electron helper or a grandchild', () => {
  assert.equal(isTool(300), false);
  assert.equal(isTool(301), false);
  assert.equal(isTool(302), false);
});

test('isMemberTool: keeper, CLI, the app, an `orchestra cli` client and a process outside any member worktree are never tools', () => {
  for (const pid of [100, 101, 200, 201, 500, 501, 600, 310]) assert.equal(isTool(pid), false, `pid ${pid}`);
});

// H-1 (verifier n°2): the hold window is PER MEMBER from ITS completion, so a member finished early cannot make a request unseen while the last members still run
const row = (wsId: string, via: string | null, at: number | null) => ({ ws_id: wsId, pause_confirm_via: via, pause_confirmed_at: at });
const MEMBERS = [{ role: 'w1', wsId: 'A' }, { role: 'w2', wsId: 'B' }, { role: 'w3', wsId: 'C' }, { role: 'w4', wsId: 'D' }];
test('holdWindows: a member the HOST took (trap / host-idle) is paused from ITS OWN completion; a self-confirmed one (douce) and an unconfirmed one wait for the run stamp; the run window always stays', () => {
  const rows = [row('A', 'trap', 1000), row('B', 'host-idle', 1100), row('C', 'member', 900), row('D', null, null)];
  const w = holdWindows({ rows, tTrapDone: 2300, tR: 9000, members: MEMBERS });
  assert.deepEqual(w.map((x: { role: string; from: number }) => [x.role, x.from]), [['w1', 1000], ['w2', 1100], ['*', 2300]]);
  assert.ok(w.every((x: { until: number }) => x.until === 9000));
  const legacy = holdWindows({ rows, tTrapDone: 2300, tR: 9000, members: MEMBERS, mode: 'legacy' });
  assert.deepEqual(legacy.map((x: { role: string; from: number }) => [x.role, x.from]), [['*', 2300]], 'the legacy (blind) window is the run stamp only');
  assert.equal(holdWindows({ rows: [row('A', 'trap', 2500)], tTrapDone: 2300, tR: 9000, members: MEMBERS }).length, 1, 'a completion AFTER the run stamp never makes a window LESS strict than the run window');
});

test('H-1 end to end: a request 0.5 s after a member\'s completion and before the run stamp is flagged by the per-member window and MISSED by the legacy one', () => {
  const rows = [row('A', 'trap', 1000), row('B', 'trap', 2300)];
  const reqs = [{ t: 1500, role: 'w1', tools: 1 }];
  const members = [{ role: 'w1', wsId: 'A' }, { role: 'w2', wsId: 'B' }];
  assert.equal(forbiddenRequests(reqs, holdWindows({ rows, tTrapDone: 2300, tR: 9000, members })).length, 1);
  assert.equal(forbiddenRequests(reqs, holdWindows({ rows, tTrapDone: 2300, tR: 9000, members, mode: 'legacy' })).length, 0, 'the old window cannot see it — the verifier n°2 finding');
});

test('isTransientName: tmp / lock / swap names of a live config dir are ignored (liveSnapshot flapped on .claude.json.tmp), real entries are not', () => {
  for (const n of ['.claude.json.tmp', '.claude.json.tmp.1234', '.claude.json.lock', 'x.swp', 'settings.json~', '.orchestra-inherited.json.tmp-9']) assert.equal(isTransientName(n), true, n);
  for (const n of ['settings.json', 'projects', 'skills', '.claude.json', 'CLAUDE.md', 'tmpl', 'timelock-notes']) assert.equal(isTransientName(n), false, n);
});

// review R-M1: `holdWindows` falls back to the run-level (blind) window for a member it cannot build a window for — that must be a RED check, never a silent green
test('holdWindows: a trap / host-idle row whose stamp is missing, NaN, a string or absent never yields a per-member window starting at null (`null < 2300` is true in JS)', () => {
  for (const at of [null, undefined, Number.NaN, '1000' as unknown as number]) {
    const w = holdWindows({ rows: [row('A', 'trap', at as number), row('B', 'host-idle', at as number)], tTrapDone: 2300, tR: 9000, members: MEMBERS });
    assert.deepEqual(w.map((x: { role: string }) => x.role), ['*'], `stamp ${String(at)}`);
  }
  assert.deepEqual(holdWindows({ rows: [], tTrapDone: 2300, tR: 9000, members: MEMBERS }).map((x: { role: string }) => x.role), ['*'], 'no roster row');
});

test('holdWindowGaps: a missing row, an unknown/absent confirm route, or a trap/host-idle row without a finite stamp is a GAP (RED); self-confirmed and an optional absent coordinator are not', () => {
  const ok = [row('A', 'trap', 1000), row('B', 'host-idle', 1100), row('C', 'member', 900)];
  assert.deepEqual(holdWindowGaps({ rows: ok, members: MEMBERS.slice(0, 3), bilans: { A: 500 } }), []);
  assert.equal(holdWindowGaps({ rows: ok, members: MEMBERS, bilans: { A: 500 } }).length, 1, 'D has no roster row');
  assert.match(holdWindowGaps({ rows: ok, members: MEMBERS, bilans: { A: 500 } })[0], /w4: no roster row/);
  assert.equal(holdWindowGaps({ rows: ok, members: [...MEMBERS.slice(0, 3), { role: 'ops', wsId: 'Z', optional: true }], bilans: { A: 500 } }).length, 0, 'an optional coordinator row may be absent');
  for (const at of [null, undefined, Number.NaN, '1000' as unknown as number]) assert.equal(holdWindowGaps({ rows: [row('A', 'trap', at as number)], members: [MEMBERS[0]] }).length, 1, `trap stamp ${String(at)}`);
  assert.equal(holdWindowGaps({ rows: [row('A', 'host-idle', null)], members: [MEMBERS[0]] }).length, 1, 'host-idle without a stamp');
  assert.equal(holdWindowGaps({ rows: [row('A', 'bogus', 1000)], members: [MEMBERS[0]] }).length, 1, 'an unknown confirm route (with a stamp) is still a gap');
  assert.equal(holdWindowGaps({ rows: [row('A', null, null)], members: [MEMBERS[0]] }).length, 1, 'an unconfirmed row');
  assert.equal(holdWindowGaps({ rows: [row('A', 'member', null)], members: [MEMBERS[0]] }).length, 0, 'a self-confirmed (douce) row waits for the run stamp BY DESIGN — no gap');
});

// review MINOR 2: the APP is the process whose FIRST token is the orchestra binary — a member's tool shell that merely mentions `orchestra ` is a TOOL, and so is its child
test('kindOf: the app (and its helpers) is the orchestra binary; a member\'s shell that mentions `orchestra send` is NOT the app, so its long-lived child still counts as a tool', () => {
  assert.equal(realKindOf({ cmd: '/x/apps/src-1/orchestra --ozone-platform=wayland' }), 'app');
  assert.equal(realKindOf({ cmd: '/x/apps/src-1/orchestra --type=utility --utility-sub-type=node.mojom.NodeService' }), 'app');
  assert.equal(realKindOf({ cmd: '/x/apps/src-1/orchestra --type=fake-app-helper -c git ls-files' }), 'app');
  assert.equal(realKindOf({ cmd: '/x/apps/src-1/orchestra cli run confirm pause' }) === 'app', false, 'an `orchestra cli` client is not the app');
  assert.equal(realKindOf({ cmd: '/usr/bin/bash -c orchestra send --to x hi; sleep 7400' }) === 'app', false);
  assert.equal(realKindOf({ cmd: 'bash -c /usr/local/bin/orchestra check; sleep 7400' }) === 'app', false);
  const c: P[] = [
    proc(10, 1, realKindOf({ cmd: '/x/orchestra --ozone-platform=wayland' }), '/x/orchestra --ozone-platform=wayland'),
    proc(20, 10, 'keeper', '/x/orchestra keeper.js w3', '/h/rig/wt-w3'),
    proc(21, 20, 'claude', '/h/rig/bin/claude --output-format stream-json', '/h/rig/wt-w3'),
    proc(22, 21, realKindOf({ cmd: '/usr/bin/bash -c orchestra send --to x hi; sleep 7400' }), '/usr/bin/bash -c orchestra send --to x hi; sleep 7400', '/h/rig/wt-w3'),
    proc(23, 22, realKindOf({ cmd: 'sleep 7400' }), 'sleep 7400', '/h/rig/wt-w3'),
  ];
  const m = new Map(c.map((x) => [x.pid, x]));
  assert.equal(isMemberTool(m.get(23), m, (x: P) => realKindOf(x), memberOf), true, 'sleep ← shell("orchestra send…") ← claude: a member tool (a loose `orchestra ` match hid it)');
});

test('liveSnapshot: a live config dir\'s own transient files (.claude.json.tmp, *.lock) do not change the snapshot (H-2 flap); a real entry does', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pcsnap-'));
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
    const a = liveSnapshot(home);
    assert.equal(a['.claude'].n, 1);
    fs.writeFileSync(path.join(home, '.claude', '.claude.json.tmp'), '');
    fs.writeFileSync(path.join(home, '.claude', 'x.lock'), '');
    assert.deepEqual(liveSnapshot(home), a, 'transient names are ignored');
    fs.writeFileSync(path.join(home, '.claude', 'projects'), '');
    assert.equal(liveSnapshot(home)['.claude'].n, 2, 'a real new entry is seen');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('mustFailVerdict: the named instrument RED counts only when the fleet reached mid-work AND the arm\'s own premise checks are green; a RED premise is RIG-BROKE, a green named check is MUTANT-SURVIVED', () => {
  assert.equal(mustFailVerdict({ reached: true, premiseRed: [], hit: ['bar:no_self_restart'] }), 'AS-EXPECTED (RED)');
  assert.equal(mustFailVerdict({ reached: true, premiseRed: [{ id: 'inject_lands_in_the_blind_window' }], hit: ['bar:no_self_restart'] }), 'RIG-BROKE', 'premise RED + named RED: the arm proves nothing');
  assert.equal(mustFailVerdict({ reached: false, premiseRed: [], hit: ['bar:no_self_restart'] }), 'RIG-BROKE');
  assert.equal(mustFailVerdict({ reached: true, premiseRed: [], hit: [] }), 'MUTANT-SURVIVED');
});

// verifier n°2 F1: the Bilan→confirmation GAP (0.4–1.0 s per member) is where #282's task-notification turn starts — the window opens at the Bilan for NEW turns
test('holdWindows (member mode): the window opens at the member\'s Bilan for NEW turns only, then all requests from its confirmation; a host-idle row (Bilan AFTER its early confirmation) and a missing Bilan add no gap window', () => {
  const rows = [row('A', 'trap', 1600), row('B', 'host-idle', 100), row('C', 'member', 900), row('D', 'trap', 1700)];
  const w = holdWindows({ rows, bilans: { A: 1000, B: 1200, C: 800 }, tTrapDone: 2300, tR: 9000, members: MEMBERS });
  assert.deepEqual(w.map((x: { role: string; from: number; until: number; turnStartOnly?: boolean }) => [x.role, x.from, x.until, x.turnStartOnly === true]),
    [['w1', 1600, 9000, false], ['w1', 1000, 1600, true], ['w2', 100, 9000, false], ['w4', 1700, 9000, false], ['*', 2300, 9000, false]]);
  assert.equal(holdWindows({ rows, bilans: { A: 1000 }, tTrapDone: 2300, tR: 9000, members: MEMBERS, mode: 'confirm' }).some((x: { label: string }) => x.label === 'bilan-gap'), false, 'confirm mode = the previous design: no gap window');
  assert.equal(holdWindows({ rows, bilans: { A: 1000 }, tTrapDone: 2300, tR: 9000, members: MEMBERS, mode: 'legacy' }).length, 1, 'legacy = run stamp only');
});

test('F1 end to end with the verifier\'s numbers (w4 Bilan +1012 ms, confirmed +1583 ms, the CLI-started request at +1577 ms = 6 ms before the confirmation): member mode flags it, the previous (confirm) design and the run window are blind; a continuation (tool_result) in the gap is legit', () => {
  const rows = [row('A', 'trap', 1583), row('B', 'trap', 2300)];
  const members = [{ role: 'w4', wsId: 'A' }, { role: 'w5', wsId: 'B' }];
  const bilans = { A: 1012, B: 1900 };
  const newTurn = [{ t: 1577, role: 'w4', tools: 1, turnStart: true }];
  const cont = [{ t: 1300, role: 'w4', tools: 1, turnStart: false }];
  const flagged = (reqs: unknown[], mode: string) => forbiddenRequests(reqs, holdWindows({ rows, bilans, tTrapDone: 2300, tR: 9000, members, mode })).length;
  assert.equal(flagged(newTurn, 'member'), 1, 'seen');
  assert.equal(forbiddenRequests(newTurn, holdWindows({ rows, bilans, tTrapDone: 2300, tR: 9000, members }))[0].window, 'bilan-gap');
  assert.equal(flagged(newTurn, 'confirm'), 0, 'the previous design is blind to it (the verifier\'s false negative)');
  assert.equal(flagged(newTurn, 'legacy'), 0);
  assert.equal(flagged(cont, 'member'), 0, 'a continuation already in flight at the Bilan may finish');
  assert.equal(forbiddenRequests([{ t: 1600, role: 'w4', tools: 1, turnStart: false }], holdWindows({ rows, bilans, tTrapDone: 2300, tR: 9000, members })).length, 1, 'from the confirmation on, EVERY tool-carrying request is flagged');
});

test('holdWindowGaps (member mode): a trap-taken worker with no Bilan record is a gap; confirm/legacy modes, optional coordinators and host-idle rows are not', () => {
  const rows = [row('A', 'trap', 1600), row('B', 'host-idle', 100)];
  const mk = (mode: string, bilans: Record<string, number>, members = MEMBERS.slice(0, 2)) => holdWindowGaps({ rows, members, bilans, mode });
  assert.deepEqual(mk('member', { A: 1000 }), [], 'trap row with its Bilan: ok; host-idle needs none');
  assert.match(mk('member', {})[0], /w1: trap row without a Bilan record/);
  assert.deepEqual(mk('confirm', {}), []);
  assert.deepEqual(mk('legacy', {}), []);
  assert.deepEqual(mk('member', {}, [{ role: 'ops', wsId: 'A', optional: true } as never, MEMBERS[1]]), [], 'an optional coordinator needs no Bilan');
});

// the strings below are the REAL ones of a member transcript (`tool_result` rejection + "[Request interrupted by user for tool use]" + the prompt + hook_success attachments are MERGED into one user message by the CLI)
test('isTurnStart: a genuine continuation is not a turn start; a request after a host interrupt (merged rejection tool_result + interrupt text + prompt), a CLI-started UserPromptSubmit turn and a plain prompt are', () => {
  const t = (o: object) => isTurnStart({ tools: 1, lastRole: 'user', lastToolResult: false, tailText: '', ...o });
  assert.equal(t({ lastToolResult: true, tailText: '(Bash completed with no output)\n<total_tokens>15000000 tokens left</total_tokens>' }), false, 'a real tool result + the token reminder = a continuation in flight');
  assert.equal(t({ lastToolResult: true, tailText: "The user doesn't want to proceed with this tool use. The tool use was rejected\n[Request interrupted by user for tool use]\nSCN:late go\n<total_tokens>x</total_tokens>" }), true, 'after the interrupt the CLI merges it all into one message with a tool_result: still a NEW turn');
  assert.equal(t({ lastToolResult: true, tailText: 'sleep done\nUserPromptSubmit hook success: [orchestra] 33 other agent(s) are running' }), true, 'the #282 blip: a CLI-started turn carries the UserPromptSubmit hook output');
  assert.equal(t({ lastToolResult: true, tailText: "The user doesn't want to proceed with this tool use." }), true, 'the rejection alone marks a post-interrupt request');
  assert.equal(t({ lastToolResult: false, tailText: 'SCN:late go' }), true, 'a plain user prompt');
  assert.equal(isTurnStart({ tools: 0, lastRole: 'user', lastToolResult: false, tailText: 'SCN:late go' }), false, 'a side request (no tools) is never a turn');
  assert.equal(isTurnStart({ tools: 1, lastRole: 'assistant', lastToolResult: false, tailText: '' }), false);
});

// the fake API classifies REAL CLI request shapes: the CLI appends a trailing `system` message (token reminder) to every request, so the LAST message is never the one that says what the request is
test('startApi.turnStart on the CLI\'s real shapes (trailing system message): a post-interrupt merged prompt, a CLI-started hook turn and a plain prompt are turn starts; a real tool result is a continuation', async () => {
  const api = await startApi({ decide: async () => ({ text: 'ok' }), usageHeaders: {} });
  const sys = { role: 'system', content: [{ type: 'text', text: '<total_tokens>15000000 tokens left</total_tokens>' }] };
  const asst = { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] };
  const post = (messages: unknown[]) => fetch(`${api.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify({ model: 'm', tools: [{ name: 'Bash' }], messages }) }).then((r) => r.text());
  try {
    await post([{ role: 'user', content: [{ type: 'text', text: 'SCN:work c1' }, { type: 'text', text: 'SessionStart:startup hook success: [orchestra]' }] }, sys]);                                  // 0 first prompt
    await post([asst, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'SETUP-OK' }, { type: 'text', text: '<total_tokens>1</total_tokens>' }] }, sys]);                   // 1 genuine continuation
    await post([asst, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: "The user doesn't want to proceed with this tool use." }, { type: 'text', text: '[Request interrupted by user for tool use]' }, { type: 'text', text: 'SCN:late go' }] }, sys]);   // 2 after a host interrupt
    await post([asst, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'slept' }, { type: 'text', text: 'UserPromptSubmit hook success: [orchestra] 33 other agent(s)' }] }, sys]);   // 3 CLI-started (#282 blip)
    await post([{ role: 'assistant', content: [{ type: 'text', text: 'done' }] }, { role: 'user', content: 'SCN:late go' }, sys]);                                                                    // 4 plain prompt to an idle member
    assert.deepEqual(api.requests.map((r: { turnStart: boolean }) => r.turnStart), [true, false, true, true, true]);
    assert.deepEqual(api.requests.map((r: { latePrompt: boolean }) => r.latePrompt), [false, false, true, false, true]);
  } finally { await api.stop(); }
});
