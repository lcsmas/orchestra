import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMemberMemoryReport,
  MAX_RELIQUAT_PROCS,
  reliquatChipTitle,
  reliquatsNote,
  formatReliquatsLine,
  memberViewFrom,
  reliquatTotals,
  reliquatWord,
  rowProcessBytes,
  viewFor,
  type ScopeReading,
} from './member-memory.ts';

const MB = 1024 * 1024;
const proc = (pid: number, role: string, rssMb = 10) => ({ pid, startTicks: pid * 7, rssBytes: rssMb * MB, role });
const reading = (gen: string, currentMb: number | null, procs: ScopeReading['procs'], keeperPid: number | null = 1): ScopeReading => ({ unit: `orchestra-ws-ws-a-${gen}.scope`, gen, currentBytes: currentMb === null ? null : currentMb * MB, procs, keeperPid });

test('M1 memberViewFrom: bytes = the kernel meter SUMMED over the scope generations (a restart with Reliquats keeps the old scope alive); Reliquats = role "reliquat" members of every generation', () => {
  const v = memberViewFrom('ws-a', [
    reading('a', 700, [proc(1, 'keeper'), proc(2, 'cli', 300), proc(3, 'session', 50)]),
    reading('b', 400, [proc(9, 'reliquat', 380), proc(10, 'reliquat', 20)]), // the old generation: no keeper, only leftovers
  ]);
  assert.equal(v.scopes, 2);
  assert.equal(v.bytes, 1100 * MB);
  assert.equal(v.reliquats, 2);
  assert.equal(v.reliquatBytes, 400 * MB);
  assert.deepEqual([v.unreadable, v.unlisted], [0, 0]);
});

test('M2 memberViewFrom: a member with a scope but NO Reliquat reads 0 (listed, none) — not null', () => {
  const v = memberViewFrom('ws-a', [reading('a', 500, [proc(1, 'keeper'), proc(2, 'cli')])]);
  assert.equal(v.reliquats, 0);
  assert.equal(v.reliquatBytes, 0);
});

test('M3 unmeasured is never 0: an unreadable meter / unlistable scope reads null; a partial read is a LOWER BOUND and says so', () => {
  const none = memberViewFrom('ws-a', [reading('a', null, null)]);
  assert.deepEqual([none.bytes, none.reliquats, none.reliquatBytes, none.unreadable, none.unlisted], [null, null, null, 1, 1]);
  const partial = memberViewFrom('ws-a', [reading('a', 300, [proc(1, 'reliquat', 5)]), reading('b', null, null)]);
  assert.equal(partial.bytes, 300 * MB);
  assert.equal(partial.unreadable, 1);
  assert.equal(partial.reliquats, 1);
  assert.equal(partial.unlisted, 1);
  // junk numbers are unmeasured, not summed
  assert.equal(memberViewFrom('ws-a', [{ ...reading('a', 1, []), currentBytes: Number.NaN }]).bytes, null);
  assert.equal(memberViewFrom('ws-a', [{ ...reading('a', 1, []), currentBytes: -5 }]).bytes, null);
});

test('M3b a junk RSS on a Reliquat (NaN) is dropped from the Reliquat bytes, not summed into NaN', () => {
  const v = memberViewFrom('ws-a', [reading('a', 100, [proc(1, 'reliquat', 5), { pid: 2, startTicks: 2, rssBytes: Number.NaN, role: 'reliquat' }])]);
  assert.equal(v.reliquats, 2);
  assert.equal(v.reliquatBytes, 5 * MB);
});

test('M4 buildMemberMemoryReport: heaviest first, unmeasured last, ties by id; untracked sorted', () => {
  const r = buildMemberMemoryReport(
    5,
    [memberViewFrom('ws-c', [reading('a', null, null)]), memberViewFrom('ws-b', [reading('a', 100, [])]), memberViewFrom('ws-a', [reading('a', 100, [])]), memberViewFrom('ws-d', [reading('a', 900, [])])],
    ['ws-z', 'ws-y'],
    null,
  );
  assert.deepEqual(r.tracked.map((m) => m.wsId), ['ws-d', 'ws-a', 'ws-b', 'ws-c']);
  assert.deepEqual(r.untracked, ['ws-y', 'ws-z']);
});

test('M5 rowProcessBytes: a tracked member = the scope meter + the PTY sessions OUTSIDE the scope; the keeper tree (`sdk`) is inside the scope and is NOT added twice', () => {
  const sessions = [
    { kind: 'sdk', memBytes: 600 * MB },
    { kind: 'run', memBytes: 20 * MB },
  ];
  const v = memberViewFrom('ws-a', [reading('a', 1000, [])]);
  assert.equal(rowProcessBytes(sessions, v), 1020 * MB);
});

test('M6 rowProcessBytes: not tracked / meter unreadable → master\'s plain tree sum, untouched', () => {
  const sessions = [
    { kind: 'sdk', memBytes: 600 * MB },
    { kind: 'run', memBytes: 20 * MB },
  ];
  assert.equal(rowProcessBytes(sessions, undefined), 620 * MB);
  assert.equal(rowProcessBytes(sessions, memberViewFrom('ws-a', [reading('a', null, [])])), 620 * MB);
  // the invariant must not rest on the counters: a view with NO meter never replaces the tree figure, whatever `unreadable` claims
  const noMeter = { wsId: 'ws-a', scopes: 1, bytes: null, unreadable: 0, reliquats: 0, reliquatBytes: 0, unlisted: 0, reliquatProcs: [] };
  assert.equal(rowProcessBytes(sessions, { ...noMeter, keeperInScope: true }), 620 * MB); // the keeper IS in a scope: only the `bytes === null` clause keeps the tree figure
  assert.equal(rowProcessBytes(sessions, { ...noMeter, keeperInScope: false }), 620 * MB); // …and a meter-less view adds nothing when the keeper is outside too
});

test('M7 rowProcessBytes: a PARTIAL scope read (a generation unreadable) is a lower bound — never below the keeper tree it replaces', () => {
  const sessions = [{ kind: 'sdk', memBytes: 600 * MB }];
  const v = memberViewFrom('ws-a', [reading('a', 200, []), reading('b', null, [])]);
  assert.equal(rowProcessBytes(sessions, v), 600 * MB);
  assert.equal(rowProcessBytes(sessions, memberViewFrom('ws-a', [reading('a', 900, []), reading('b', null, [])])), 900 * MB);
});

test('M8 formatReliquatsLine: nothing tracked → « Reliquats not tracked » with the reason; unsupported host names its reason', () => {
  const none = buildMemberMemoryReport(1, [], ['ws-a'], null);
  assert.match(formatReliquatsLine(none, (id) => id), /^reliquats: Reliquats not tracked — no live member has a scope \(e\.g\. memory_cap OFF/);
  const unsup = buildMemberMemoryReport(1, [], ['ws-a'], 'no systemd user manager');
  assert.equal(formatReliquatsLine(unsup, (id) => id), 'reliquats: Reliquats not tracked — no systemd user manager');
});

test('M9 formatReliquatsLine: counts per member with labels + bytes; members tracked; the untracked remainder is named; lower bound when a scope could not be listed', () => {
  const r = buildMemberMemoryReport(
    1,
    [memberViewFrom('ws-a', [reading('a', 900, [proc(1, 'keeper'), proc(2, 'reliquat', 600), proc(3, 'reliquat', 10)])]), memberViewFrom('ws-b', [reading('a', 300, [proc(4, 'cli')])])],
    ['ws-c', 'ws-d'],
    null,
  );
  assert.equal(formatReliquatsLine(r, (id) => id.toUpperCase()), 'reliquats: 2 live — WS-A ×2 · 610 MB RSS · 2 members tracked · Reliquats not tracked for 2 members (no scope)');
  const zero = buildMemberMemoryReport(1, [memberViewFrom('ws-b', [reading('a', 300, [proc(4, 'cli')])])], [], null);
  assert.equal(formatReliquatsLine(zero, (id) => id), 'reliquats: 0 live · 1 member tracked');
  const blind = buildMemberMemoryReport(1, [memberViewFrom('ws-a', [reading('a', 300, [proc(2, 'reliquat', 5)]), reading('b', 100, null)])], [], null);
  assert.equal(formatReliquatsLine(blind, (id) => id), 'reliquats: 1 live (lower bound) — ws-a ×1 · 5 MB RSS · 1 member tracked · 1 member could not be fully read — figures incomplete');
});

test('M10 reliquatTotals / viewFor / reliquatWord', () => {
  const r = buildMemberMemoryReport(1, [memberViewFrom('ws-a', [reading('a', 1, [proc(1, 'reliquat', 7), proc(2, 'reliquat', 3)])]), memberViewFrom('ws-b', [reading('a', 1, [proc(3, 'reliquat', 1)])])], [], null);
  assert.deepEqual(reliquatTotals(r), { count: 3, bytes: 11 * MB, members: 2, anyUnlisted: false });
  assert.equal(viewFor(r, 'ws-a')?.reliquats, 2);
  assert.equal(viewFor(r, 'nope'), undefined);
  assert.equal(viewFor(null, 'ws-a'), undefined);
  assert.deepEqual([reliquatWord(1), reliquatWord(0), reliquatWord(3)], ['1 Reliquat', '0 Reliquats', '3 Reliquats']);
});

test('M11 strayScopes: scopes of workspaces we did not ask about are COUNTED and said, never read — and the « not tracked » line does not blame a cause when one exists', () => {
  const none = buildMemberMemoryReport(1, [], ['ws-a'], null, 1);
  assert.equal(formatReliquatsLine(none, (id) => id), 'reliquats: Reliquats not tracked — no live member has a scope (e.g. memory_cap OFF for its run, a session started before it was ON, a human workspace) · 1 scope of workspaces not in the store was not read');
  const some = buildMemberMemoryReport(1, [memberViewFrom('ws-a', [reading('a', 300, [proc(4, 'cli')])])], [], null, 2);
  assert.match(formatReliquatsLine(some, (id) => id), / · 2 scopes of workspaces not in the store were not read$/);
  assert.doesNotMatch(formatReliquatsLine(buildMemberMemoryReport(1, [], [], null, 0), (id) => id), /not in the store/);
  assert.doesNotMatch(formatReliquatsLine(buildMemberMemoryReport(1, [], [], null, null), (id) => id), /not in the store/);
});

test('M12 a Reliquat size is labelled RSS: it is a per-process sum, not the member\'s bill (shared pages are counted once in the bill and once per process here)', () => {
  const r = buildMemberMemoryReport(1, [memberViewFrom('ws-a', [reading('a', 144, [proc(1, 'reliquat', 100), proc(2, 'reliquat', 95)])])], [], null);
  assert.match(formatReliquatsLine(r, (id) => id), /ws-a ×2 · 195 MB RSS/);
});

test('M13 reliquatProcs: the heaviest Reliquats first (≤ 8, pid + comm only), ties by pid; a missing comm reads « ? »; none / unlisted → []', () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ pid: 100 + i, startTicks: i, rssBytes: (i + 1) * MB, role: 'reliquat', comm: `p${i}` }));
  const v = memberViewFrom('ws-a', [reading('a', 500, [{ pid: 1, startTicks: 1, rssBytes: 999 * MB, role: 'cli', comm: 'node' }, ...many, proc(7, 'reliquat', 6)])]);
  assert.equal(v.reliquats, 12);
  assert.equal(v.reliquatProcs.length, MAX_RELIQUAT_PROCS);
  assert.deepEqual(v.reliquatProcs.slice(0, 3).map((p) => [p.pid, p.comm, p.rssBytes / MB]), [[110, 'p10', 11], [109, 'p9', 10], [108, 'p8', 9]]);
  assert.equal(memberViewFrom('ws-a', [reading('a', 1, [proc(5, 'reliquat', 3)])]).reliquatProcs[0].comm, '?');
  assert.deepEqual(memberViewFrom('ws-a', [reading('a', 1, [proc(5, 'cli')])]).reliquatProcs, []);
  assert.deepEqual(memberViewFrom('ws-a', [reading('a', null, null)]).reliquatProcs, []);
});

test('M14 reliquatsNote (the page\'s dim line): nothing for a healthy page; « not tracked » with the honest cause when no member has a scope; the untracked remainder; stray scopes; a host reason wins', () => {
  assert.equal(reliquatsNote(null), null);
  assert.equal(reliquatsNote(buildMemberMemoryReport(1, [], [], null, 0)), null, 'no live member: nothing to say');
  const tr = memberViewFrom('ws-a', [reading('a', 1, [])]);
  assert.equal(reliquatsNote(buildMemberMemoryReport(1, [tr], [], null, 0)), null, 'every live member tracked: no line');
  assert.match(reliquatsNote(buildMemberMemoryReport(1, [], ['ws-x'], null, 0)) ?? '', /^Reliquats not tracked — no live member has a scope \(e\.g\. memory_cap OFF/);
  assert.equal(reliquatsNote(buildMemberMemoryReport(1, [], ['ws-x'], 'not linux (darwin)', 0)), 'Reliquats not tracked — not linux (darwin)');
  assert.equal(reliquatsNote(buildMemberMemoryReport(1, [tr], ['a', 'b', 'c'], null, 0)), 'Reliquats not tracked for 3 members (no scope)');
  assert.equal(reliquatsNote(buildMemberMemoryReport(1, [tr], [], null, 2)), '2 scopes of workspaces not in the store were not read');
});

test('M15 reliquatChipTitle: count, RSS (labelled) and what a Reliquat is; « at least » when a scope could not be listed', () => {
  assert.equal(reliquatChipTitle({ count: 3, bytes: 610 * MB, partial: false }), '3 Reliquats · 610 MB RSS — processes this workspace launched that outlived its session or left its process tree');
  assert.match(reliquatChipTitle({ count: 1, bytes: 5 * MB, partial: true }), /^1 Reliquat \(at least — a scope could not be listed\) · 5 MB RSS/);
});

test('M16 keeperInScope + rowProcessBytes: when NO scope of the member holds its keeper (a live keeper running unscoped next to an older generation\'s leftovers) the keeper tree and the scope bill are DISJOINT and ADD — never the stale scope in place of the live tree', () => {
  const sessions = [{ kind: 'sdk', memBytes: 600 * MB }];
  const stale = memberViewFrom('ws-a', [reading('a', 50, [proc(9, 'reliquat', 40)], null)]);
  assert.equal(stale.keeperInScope, false);
  assert.equal(rowProcessBytes(sessions, stale), 650 * MB);
  const live = memberViewFrom('ws-a', [reading('a', 700, [proc(1, 'keeper')], 1)]);
  assert.equal(live.keeperInScope, true);
  assert.equal(rowProcessBytes(sessions, live), 700 * MB);
  // one generation holds the keeper, an older one does not: the keeper IS in a scope
  assert.equal(memberViewFrom('ws-a', [reading('a', 700, [proc(1, 'keeper')], 1), reading('b', 50, [proc(9, 'reliquat')], null)]).keeperInScope, true);
});

test('M18 billing what escaped the scope: the row ADDS the keeper tree\'s RSS that is in none of the member\'s scopes (a browser main in its own systemd scope — #328 review F1); a partial read never goes below the whole tree', () => {
  const sessions = [{ kind: 'sdk', memBytes: 600 * MB }];
  const v = memberViewFrom('ws-a', [reading('a', 300, [proc(1, 'keeper')], 1)], [{ rssBytes: 83 * MB }, { rssBytes: 7 * MB }]);
  assert.deepEqual([v.outsideBytes, v.outsideCount], [90 * MB, 2]);
  assert.equal(rowProcessBytes(sessions, v), 390 * MB); // bill 300 + escaped 90
  assert.equal(rowProcessBytes(sessions, memberViewFrom('ws-a', [reading('a', 300, [proc(1, 'keeper')], 1)])), 300 * MB); // nothing escaped = master of FI-1: the bill alone
  const partial = memberViewFrom('ws-a', [reading('a', 100, [proc(1, 'keeper')], 1), reading('b', null, null, null)], [{ rssBytes: 50 * MB }]);
  assert.equal(rowProcessBytes(sessions, partial), 600 * MB, 'bill 100 + escaped 50 < the keeper tree 600: never below it');
  const partialBig = memberViewFrom('ws-a', [reading('a', 100, [proc(1, 'keeper')], 1), reading('b', null, null, null)], [{ rssBytes: 550 * MB }]);
  assert.equal(rowProcessBytes(sessions, partialBig), 650 * MB, 'a lower bound that already exceeds the tree keeps the escaped bytes');
  // a keeper OUTSIDE every scope: the whole tree is in `all`, the escaped figure must not be added again
  const keeperless = memberViewFrom('ws-a', [reading('a', 50, [proc(9, 'reliquat', 40)], null)], [{ rssBytes: 500 * MB }]);
  assert.equal(rowProcessBytes(sessions, keeperless), 650 * MB);
  // junk RSS is dropped, not summed
  assert.equal(memberViewFrom('ws-a', [reading('a', 1, [], 1)], [{ rssBytes: Number.NaN }, { rssBytes: 5 * MB }]).outsideBytes, 5 * MB);
});

test('C1 (#323) memberViewFrom.cap: the limit, bill, working set and peak of the scope that HOLDS THE KEEPER — what the kernel really enforces on the live session', () => {
  const live = { ...reading('k2', 2100, [], 7), maxBytes: 6144 * MB, workingSetBytes: 1600 * MB, peakBytes: 2400 * MB };
  const v = memberViewFrom('ws-a', [live]);
  assert.deepEqual(v.cap, { unit: live.unit, hardBytes: 6144 * MB, billBytes: 2100 * MB, workingSetBytes: 1600 * MB, peakBytes: 2400 * MB, scopes: 1 });
});

test('C3 (#323-fu, review m2) capNote: a tracked member whose KEEPER scope reads `max` is « not-applied » — and only then; a numeric cap, an unreadable limit, an older generation, an unreadable meter and a keeper in no scope are all NOT', () => {
  const live = { ...reading('k2', 900, [], 9), maxBytes: null, limitApplied: false } as ScopeReading;
  assert.equal(memberViewFrom('ws-a', [live]).capNote, 'not-applied');
  assert.equal(memberViewFrom('ws-a', [live]).cap, null, 'still no bar');
  assert.equal(memberViewFrom('ws-a', [{ ...live, maxBytes: 3072 * MB, limitApplied: true }]).capNote, null, 'a capped member has its bar, not the note');
  assert.equal(memberViewFrom('ws-a', [{ ...live, limitApplied: null }]).capNote, null, 'an UNREADABLE limit is unknown, never claimed as « not applied »');
  assert.equal(memberViewFrom('ws-a', [{ ...live, limitApplied: undefined }]).capNote, null, 'a reading from an older producer says nothing');
  assert.equal(memberViewFrom('ws-a', [{ ...live, currentBytes: null }]).capNote, null, 'unreadable meter: the scope is not really read');
  assert.equal(memberViewFrom('ws-a', [{ ...live, keeperPid: null }]).capNote, null, 'a scope that only carries leftovers is not the session');
  const old = { ...reading('k1', 4000, [], null), maxBytes: 6144 * MB, limitApplied: true } as ScopeReading;
  assert.equal(memberViewFrom('ws-a', [old, live]).capNote, 'not-applied', "the LIVE session's scope decides, not the leftover generation's limit");
  assert.equal(memberViewFrom('ws-a', [{ ...old, limitApplied: false }, { ...live, maxBytes: 3072 * MB, limitApplied: true }]).capNote, null, 'and a leftover generation without a limit does not flag the member');
  assert.equal(memberViewFrom('ws-a', []).capNote, null);
  const noKeeperField = { ...live, keeperPid: undefined } as unknown as ScopeReading; // a reading from a producer that forgot the field: undefined is NOT a keeper
  assert.equal(memberViewFrom('ws-a', [noKeeperField]).capNote, null);
  assert.equal(memberViewFrom('ws-a', [{ ...noKeeperField, maxBytes: 6144 * MB, limitApplied: true }]).cap, null, 'nor a cap');
});

test('C2 (#323) cap is the keeper\'s scope, never an older generation kept alive by Reliquats; a keeper in no scope has no cap; no limit / junk / unreadable meter ⇒ null, never 0', () => {
  const old = { ...reading('k1', 4000, [], null), maxBytes: 6144 * MB, workingSetBytes: 3000 * MB, peakBytes: 5000 * MB };
  const live = { ...reading('k2', 900, [], 9), maxBytes: 3072 * MB, workingSetBytes: 700 * MB, peakBytes: 900 * MB };
  assert.equal(memberViewFrom('ws-a', [old, live]).cap?.hardBytes, 3072 * MB, 'the live session\'s limit, not the leftover generation\'s');
  assert.equal(memberViewFrom('ws-a', [old]).cap, null, 'only an older generation: the keeper is outside every scope');
  assert.equal(memberViewFrom('ws-a', [{ ...live, maxBytes: null }]).cap, null, 'no limit applied ⇒ nothing to compare against');
  assert.equal(memberViewFrom('ws-a', [{ ...live, maxBytes: 0 }]).cap, null, 'a 0 limit is not a cap');
  assert.equal(memberViewFrom('ws-a', [{ ...live, maxBytes: Number.NaN }]).cap, null);
  assert.equal(memberViewFrom('ws-a', [{ ...live, currentBytes: null }]).cap, null, 'unreadable meter ⇒ unmeasured, not 0 of 3 GB');
  assert.equal(memberViewFrom('ws-a', [{ ...live, workingSetBytes: null }]).cap?.workingSetBytes, null, 'an unreadable working set stays null (the bar then shows the bill only)');
  assert.equal(memberViewFrom('ws-a', [{ ...live, peakBytes: undefined }]).cap?.peakBytes, null);
  assert.equal(memberViewFrom('ws-a', [{ ...live, workingSetBytes: Number.NaN }]).cap?.workingSetBytes, null, 'a junk working set is unknown, never NaN');
  assert.equal(memberViewFrom('ws-a', [{ ...live, workingSetBytes: -5 }]).cap?.workingSetBytes, null, 'a negative one too');
  assert.equal(memberViewFrom('ws-a', [{ ...live, peakBytes: Number.POSITIVE_INFINITY }]).cap?.peakBytes, null);
});

test('#332 × #323: the cap view\'s bill is the cgroup that carries the cap (capCurrentBytes) while the member\'s MEM figure stays the scope total; absent / junk capCurrentBytes falls back to the scope\'s', () => {
  const live = { ...reading('k2', 2100, [], 7), maxBytes: 6144 * MB, capCurrentBytes: 1500 * MB, workingSetBytes: 1100 * MB, peakBytes: 1800 * MB };
  const v = memberViewFrom('ws-a', [live]);
  assert.equal(v.cap?.billBytes, 1500 * MB, 'the bar compares the TOOLS\' memory.current with the hard level');
  assert.equal(v.bytes, 2100 * MB, 'the MEM column still counts the whole scope (keeper + CLI + tools)');
  assert.equal(memberViewFrom('ws-a', [{ ...live, capCurrentBytes: null }]).cap?.billBytes, 2100 * MB, 'no leaf reading: the scope\'s figure');
  assert.equal(memberViewFrom('ws-a', [{ ...live, capCurrentBytes: Number.NaN }]).cap?.billBytes, 2100 * MB, 'junk: the scope\'s figure, never NaN');
  const { capCurrentBytes: _omit, ...older } = live;
  assert.equal(memberViewFrom('ws-a', [older]).cap?.billBytes, 2100 * MB, 'an older reader without the field');
});

// ─── #343: the keeper leaf's margin in the member view and on the bus-status line ────────────────────────────────────────────────────────────

import { formatRoomLine, type MemberMemoryReport, type ScopeReading } from './member-memory.ts';

const G = 1024 ** 3;
const readingRoom = (over: Partial<ScopeReading> = {}): ScopeReading => ({ unit: 'u.scope', gen: 'g', currentBytes: 2 * G, procs: [], keeperPid: 1, maxBytes: 6 * G, capCurrentBytes: 1 * G, workingSetBytes: 1 * G, peakBytes: null, limitApplied: true, backstopBytes: 7 * G, keeperLeaf: { currentBytes: 0.5 * G, workingSetBytes: 0.4 * G, oomKills: 0 }, scopeEpisodes: 0, ...over });

test('#343 M1: the view carries the keeper-leaf room — k\'s working set against backstop − hard — for the scope that HOLDS the keeper only', () => {
  const v = memberViewFrom('w1', [readingRoom()]);
  assert.equal(v.room?.pct, 40);
  assert.equal(v.room?.roomBytes, 1 * G);
  const older = memberViewFrom('w1', [readingRoom({ keeperPid: null, keeperLeaf: { currentBytes: 5 * G, workingSetBytes: 5 * G, oomKills: 0 } }), readingRoom()]);
  assert.equal(older.room?.kBytes, 0.4 * G, 'an older generation kept alive by Reliquats is not the session\'s margin');
  assert.equal(memberViewFrom('w1', [readingRoom({ keeperPid: null })]).room, null, 'no scope holds the keeper ⇒ no margin');
});

test('#343 M2: no backstop / no tool cap / no keeper leaf / junk ⇒ NO margin (never a fabricated figure)', () => {
  assert.equal(memberViewFrom('w', [readingRoom({ backstopBytes: null })]).room, null);
  assert.equal(memberViewFrom('w', [readingRoom({ maxBytes: null })]).room, null);
  assert.equal(memberViewFrom('w', [readingRoom({ keeperLeaf: null })]).room, null);
  assert.equal(memberViewFrom('w', [readingRoom({ keeperLeaf: undefined })]).room, null);
  assert.equal(memberViewFrom('w', [readingRoom({ backstopBytes: Number.NaN })]).room, null);
});

const report = (views: ReturnType<typeof memberViewFrom>[]): MemberMemoryReport => ({ at: 1, tracked: views, untracked: [], unsupported: null, strayScopes: null });

test('#343 M3: the bus-status line names the closest member, its k, the room and the percent, and counts the backstop events', () => {
  const a = memberViewFrom('wa', [readingRoom()]);
  const b = memberViewFrom('wb', [readingRoom({ keeperLeaf: { currentBytes: 0.95 * G, workingSetBytes: 0.9 * G, oomKills: 1 }, scopeEpisodes: 2 })]);
  const line = formatRoomLine(report([a, b]), (id) => `feat-${id}`);
  assert.match(line, /^memory room: 2 members measured · least room: feat-wb — keeper\+CLI 922 MB of 1\.0 GB room \(90 %\) — close · scope backstop events: 2$/); // the larger of k kills (1) and scope episodes (2): one episode bumps both counters
  assert.match(formatRoomLine(report([memberViewFrom('wc', [readingRoom({ keeperLeaf: { currentBytes: 1.2 * G, workingSetBytes: 1.1 * G, oomKills: 0 } })])]), (i) => i), /ABOVE the room: a full tool leaf would open a scope-level OOM/);
});

test('#343 M4: nothing tracked / nothing stateable says so — one line, never silence', () => {
  assert.equal(formatRoomLine(report([]), (i) => i), 'memory room: no member has a scope — nothing to measure');
  assert.match(formatRoomLine(report([memberViewFrom('wd', [readingRoom({ backstopBytes: null })])]), (i) => i), /^memory room: 1 tracked member, no margin stateable/);
  const approx = formatRoomLine(report([memberViewFrom('we', [readingRoom({ keeperLeaf: { currentBytes: 0.5 * G, workingSetBytes: null, oomKills: 0 } })])]), (i) => i);
  assert.match(approx, /\(upper bound: cache not separable\)/);
});

// ─── #343 gap 2: an unprotected member never looks capped ────────────────────────────────────────────────────────────────────────────────────

test('#343 G2-a: the keeper says UNPROTECTED while w/memory.max is numeric ⇒ NO bar (cap null), the dim note says unprotected — the sysfs alone would have drawn a healthy cap', () => {
  const healthy = memberViewFrom('w1', [readingRoom({ capState: 'active' })]);
  assert.ok(healthy.cap, 'control: an active member has its bar');
  assert.equal(healthy.capNote, null);
  const unprotected = memberViewFrom('w1', [readingRoom({ capState: 'unprotected' })]);
  assert.equal(unprotected.cap, null, 'tools run in the unlimited keeper leaf: the cap is not holding, no bar');
  assert.equal(unprotected.capNote, 'unprotected');
  const notApplied = memberViewFrom('w1', [readingRoom({ capState: 'not-applied' })]);
  assert.equal(notApplied.cap, null);
  assert.equal(notApplied.capNote, 'unprotected', 'the limit did not fully take (swap escape open / wrapper cannot run): not protected either');
});

test('#343 G2-b: only the scope that HOLDS the keeper speaks for the member; an unknown state changes nothing; « no limit at all » keeps its own, more specific note', () => {
  assert.equal(memberViewFrom('w1', [readingRoom({ capState: undefined })]).capNote, null, 'unknown ≠ unprotected');
  assert.equal(memberViewFrom('w1', [readingRoom({ capState: null })]).capNote, null);
  const older = memberViewFrom('w1', [readingRoom({ keeperPid: null, capState: 'unprotected' }), readingRoom({ capState: 'active' })]);
  assert.ok(older.cap && older.capNote === null, 'an older generation kept alive by Reliquats does not make the live session unprotected');
  const noLimit = memberViewFrom('w1', [readingRoom({ limitApplied: false, maxBytes: null, capState: 'unprotected' })]);
  assert.equal(noLimit.capNote, 'not-applied', 'the sysfs says NO limit at all: the more specific note wins');
  assert.equal(memberViewFrom('w1', [readingRoom({ currentBytes: null, capState: 'unprotected' })]).capNote, null, 'an unreadable meter is unknown, not a verdict');
});

test('#343 G2-c: the SessionGroup carries the new note (and the room) to the row', async () => {
  const { groupSessionsByWorkspace } = await import('./resources.ts');
  const v = memberViewFrom('w1', [readingRoom({ capState: 'unprotected' })]);
  const { rows } = groupSessionsByWorkspace([{ ptyId: 'w1:sdk', workspaceId: 'w1', kind: 'sdk', cpuPct: 1, memBytes: 10, procCount: 1, remote: false } as never], undefined as never, { at: 1, tracked: [v], untracked: [], unsupported: null, strayScopes: null });
  assert.equal(rows.find((r) => r.key === 'w1')?.capNote, 'unprotected');
  assert.ok(rows.find((r) => r.key === 'w1')?.room, 'the margin rides along');
});
