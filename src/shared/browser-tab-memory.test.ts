import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appMemoryExcludingTabs,
  attributeBrowserTabMemory,
  browserBytesFor,
  browserChipText,
  browserChipTitle,
  browserOf,
  formatBrowserTabsLine,
  type BrowserTabProc,
} from './browser-tab-memory.ts';

const MB = 1024 * 1024;
const tab = (wsId: string, tabId: string, pid: number | null): BrowserTabProc => ({ wsId, tabId, pid });
const mem = (o: Record<number, number>): Map<number, number> => new Map(Object.entries(o).map(([k, v]) => [Number(k), v]));
const ws = (v: ReturnType<typeof attributeBrowserTabMemory>, id: string) => v.byWorkspace.find((w) => w.wsId === id);

test('T1 one tab: its renderer process is the workspace figure, and the pid is billed', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', 100)], mem({ 100: 300 * MB }));
  assert.deepEqual(ws(v, 'A'), { wsId: 'A', tabs: 1, bytes: 300 * MB, unmeasured: 0, shared: 0 });
  assert.deepEqual(v.attributedPids, [100]);
});

test('T2 a heavy page in A raises A and no other workspace (the ticket promise)', () => {
  const tabs = [tab('A', 't1', 100), tab('B', 't1', 200)];
  const before = attributeBrowserTabMemory(tabs, mem({ 100: 80 * MB, 200: 80 * MB }));
  const after = attributeBrowserTabMemory(tabs, mem({ 100: 780 * MB, 200: 80 * MB }));
  assert.equal(ws(after, 'A')!.bytes! - ws(before, 'A')!.bytes!, 700 * MB);
  assert.equal(ws(after, 'B')!.bytes, ws(before, 'B')!.bytes);
});

test('T3 several tabs of one workspace add up, each its own process', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', 100), tab('A', 't2', 101)], mem({ 100: 100, 101: 250 }));
  assert.equal(ws(v, 'A')!.bytes, 350);
  assert.equal(ws(v, 'A')!.tabs, 2);
});

test('T4 two tabs of ONE workspace sharing a pid: the process counts once, not twice', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', 100), tab('A', 't2', 100)], mem({ 100: 301 }));
  assert.equal(ws(v, 'A')!.bytes, 301);
  assert.equal(ws(v, 'A')!.shared, 0, 'same-workspace sharing is exact, not an estimate');
  assert.deepEqual(v.attributedPids, [100]);
});

test('T5 a pid shared across workspaces is SPLIT: the shares sum to the process, each side marked shared', () => {
  const v = attributeBrowserTabMemory([tab('B', 't1', 100), tab('A', 't1', 100)], mem({ 100: 101 }));
  assert.equal(ws(v, 'A')!.bytes, 51, 'remainder byte goes to the first (wsId order)');
  assert.equal(ws(v, 'B')!.bytes, 50);
  assert.equal(ws(v, 'A')!.bytes! + ws(v, 'B')!.bytes!, 101);
  assert.equal(ws(v, 'A')!.shared, 1);
  assert.equal(ws(v, 'B')!.shared, 1);
});

test('T6 a three-way split keeps every byte: 100 / 3 tabs = 34 + 33 + 33', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', 7), tab('B', 't1', 7), tab('C', 't1', 7)], mem({ 7: 100 }));
  assert.deepEqual(v.byWorkspace.map((w) => w.bytes), [34, 33, 33]);
});

test('T7 a split pid next to an exclusive one: the exclusive tab keeps its whole process', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', 7), tab('B', 't1', 7), tab('A', 't2', 8)], mem({ 7: 200, 8: 50 }));
  assert.equal(ws(v, 'A')!.bytes, 150);
  assert.equal(ws(v, 'B')!.bytes, 100);
  assert.equal(ws(v, 'A')!.shared, 1, 'only the tab on pid 7 is shared');
});

test('T8 a tab with no live pid is unmeasured — bytes null, never 0', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', null)], mem({}));
  assert.deepEqual(ws(v, 'A'), { wsId: 'A', tabs: 1, bytes: null, unmeasured: 1, shared: 0 });
  assert.deepEqual(v.attributedPids, []);
});

test('T9 a measured tab plus an unmeasured one: the figure is the measured part, the other is counted', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', 100), tab('A', 't2', null)], mem({ 100: 42 }));
  assert.deepEqual(ws(v, 'A'), { wsId: 'A', tabs: 2, bytes: 42, unmeasured: 1, shared: 0 });
});

test('T10 a pid absent from the process table is unmeasured (the process exited between the two reads)', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', 999)], mem({ 100: 1 }));
  assert.equal(ws(v, 'A')!.bytes, null);
  assert.equal(ws(v, 'A')!.unmeasured, 1);
});

test('T11 a pid that also hosts a non-tab page is NOT billed to the workspace', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', 100)], mem({ 100: 900 * MB }), new Set([100]));
  assert.equal(ws(v, 'A')!.bytes, null);
  assert.equal(ws(v, 'A')!.unmeasured, 1);
  assert.deepEqual(v.attributedPids, [], 'an unbilled pid stays in the app total');
});

test('T12 junk pids and junk figures are unmeasured, not a number', () => {
  const tabs = [tab('A', 't1', 0), tab('A', 't2', -5), tab('A', 't3', 1.5), tab('A', 't4', Number.NaN), tab('A', 't5', 5), tab('A', 't6', 6)];
  // the table HAS rows at the junk pids (0 / -5 / 1.5): a guard that only trusts « in the table » would bill them
  const v = attributeBrowserTabMemory(tabs, new Map([[0, 123], [-5, 123], [1.5, 123], [5, Number.NaN], [6, -1]]));
  assert.equal(ws(v, 'A')!.bytes, null);
  assert.equal(ws(v, 'A')!.unmeasured, 6);
});

test('T13 an explicit zero-byte reading is a measurement of 0, distinct from unmeasured', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', 5)], mem({ 5: 0 }));
  assert.equal(ws(v, 'A')!.bytes, 0);
  assert.equal(ws(v, 'A')!.unmeasured, 0);
});

test('T14 no tabs: an empty view', () => {
  assert.deepEqual(attributeBrowserTabMemory([], mem({ 1: 1 })), { byWorkspace: [], attributedPids: [] });
});

test('T15 the result does not depend on input order', () => {
  const tabs = [tab('B', 't1', 7), tab('A', 't2', 8), tab('A', 't1', 7), tab('C', 't1', 7)];
  const a = attributeBrowserTabMemory(tabs, mem({ 7: 100, 8: 9 }));
  const b = attributeBrowserTabMemory([...tabs].reverse(), mem({ 7: 100, 8: 9 }));
  const norm = (v: typeof a) => v.byWorkspace.map((w) => ({ ...w })).sort((x, y) => (x.wsId < y.wsId ? -1 : 1));
  assert.deepEqual(norm(a), norm(b));
});

test('T16 no double count: Σ workspace figures = Σ distinct billed processes', () => {
  const tabs = [tab('A', 't1', 1), tab('A', 't2', 2), tab('B', 't1', 2), tab('B', 't2', 3), tab('C', 't1', 3), tab('C', 't2', 3)];
  const m = mem({ 1: 1000, 2: 777, 3: 1001 });
  const v = attributeBrowserTabMemory(tabs, m);
  assert.equal(v.byWorkspace.reduce((n, w) => n + (w.bytes ?? 0), 0), 1000 + 777 + 1001);
});

test('B1 browserBytesFor / browserOf: folded bytes, 0 and null for no tab', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', 1)], mem({ 1: 5 }));
  assert.equal(browserBytesFor(v, 'A'), 5);
  assert.equal(browserBytesFor(v, 'Z'), 0);
  assert.equal(browserBytesFor(null, 'A'), 0);
  assert.equal(browserOf(v, 'A')!.tabs, 1);
  assert.equal(browserOf(v, 'Z'), null);
  assert.equal(browserOf(undefined, 'A'), null);
  const unmeasured = attributeBrowserTabMemory([tab('A', 't1', null)], mem({}));
  assert.equal(browserBytesFor(unmeasured, 'A'), 0);
  assert.equal(browserOf(unmeasured, 'A')!.bytes, null, 'the row still says the tab exists, with no figure');
});

test('B2 the App tile leaves out the renderers already billed to a workspace, and counts the rest', () => {
  const app = [{ pid: 1, memBytes: 500 }, { pid: 100, memBytes: 300 }, { pid: 101, memBytes: 40 }];
  const v = attributeBrowserTabMemory([tab('A', 't1', 100)], mem({ 100: 300 }));
  assert.equal(appMemoryExcludingTabs(app, v), 540);
  assert.equal(appMemoryExcludingTabs(app, null), 840);
  assert.equal(appMemoryExcludingTabs(app, undefined), 840);
});

test('B3 agent tile + app tile never count a billed process twice', () => {
  const app = [{ pid: 1, memBytes: 500 }, { pid: 100, memBytes: 300 }];
  const v = attributeBrowserTabMemory([tab('A', 't1', 100)], mem({ 100: 300 }));
  assert.equal(browserBytesFor(v, 'A') + appMemoryExcludingTabs(app, v), 800, 'the 300 is in exactly one of the two tiles');
});

test('F1 chip text and tooltip: count, figure, not-measured and shared notes', () => {
  assert.equal(browserChipText({ wsId: 'A', tabs: 1, bytes: 300 * MB, unmeasured: 0, shared: 0 }), '1 tab · 300 MB');
  assert.equal(browserChipText({ wsId: 'A', tabs: 3, bytes: 2 * 1024 * MB, unmeasured: 0, shared: 0 }), '3 tabs · 2.0 GB');
  assert.equal(browserChipText({ wsId: 'A', tabs: 2, bytes: null, unmeasured: 2, shared: 0 }), '2 tabs');
  assert.match(browserChipTitle({ wsId: 'A', tabs: 2, bytes: null, unmeasured: 2, shared: 0 }), /not measured/);
  assert.match(browserChipTitle({ wsId: 'A', tabs: 2, bytes: 5 * MB, unmeasured: 1, shared: 0 }), /1 not measured/);
  assert.match(browserChipTitle({ wsId: 'A', tabs: 1, bytes: 5 * MB, unmeasured: 0, shared: 1 }), /estimate/);
  assert.doesNotMatch(browserChipTitle({ wsId: 'A', tabs: 1, bytes: 5 * MB, unmeasured: 0, shared: 0 }), /estimate|not measured/);
});

test('F2 the bus-status line: none / per workspace / not measured / shared / more than five', () => {
  assert.equal(formatBrowserTabsLine(null), 'browser tabs: none open');
  assert.equal(formatBrowserTabsLine({ byWorkspace: [], attributedPids: [] }), 'browser tabs: none open');
  const v = attributeBrowserTabMemory([tab('A', 't1', 1), tab('A', 't2', 2), tab('B', 't1', 3), tab('C', 't1', null)], mem({ 1: 300 * MB, 2: 100 * MB, 3: 50 * MB }));
  const line = formatBrowserTabsLine(v, (id) => `feat-${id}`);
  assert.equal(line, 'browser tabs: 4 in 3 workspaces (feat-A ×2 · 400 MB, feat-B ×1 · 50 MB, feat-C ×1 · not measured) · 450 MB total, counted in each workspace\'s memory');
  const shared = formatBrowserTabsLine(attributeBrowserTabMemory([tab('A', 't1', 1), tab('B', 't1', 1)], mem({ 1: 200 * MB })));
  assert.match(shared, /A ×1 · 100 MB ~, B ×1 · 100 MB ~/);
  assert.match(shared, /~ = renderer shared across workspaces/);
  const many = attributeBrowserTabMemory(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((w, i) => tab(w, 't1', i + 1)), mem({ 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7 }));
  assert.match(formatBrowserTabsLine(many), /, \+2 more\)/);
  const partial = formatBrowserTabsLine(attributeBrowserTabMemory([tab('A', 't1', 1), tab('A', 't2', null)], mem({ 1: 10 * MB })));
  assert.match(partial, /A ×2 · 10 MB \(\+1 not measured\)/);
});

// ── the Resources page's grouping (#394) ────────────────────────────────────
import { groupSessionsByWorkspace, groupSnapshot, type SessionResourceStat } from './resources.ts';
import { accountingView as cAccountingView, buildAccounting as cBuildAccounting } from './container-accounting.ts';
import { buildMemberMemoryReport, memberViewFrom } from './member-memory.ts';

const sess = (over: Partial<SessionResourceStat>): SessionResourceStat => ({ ptyId: 'A:sdk', workspaceId: 'A', kind: 'sdk', remote: false, cpuPct: 1, memBytes: 100 * MB, procCount: 3, processes: [], ...over });
const rowOf = (g: ReturnType<typeof groupSessionsByWorkspace>, k: string) => g.rows.find((r) => r.key === k);

test('R1 a workspace row adds its tab renderers to its memory — and no other row moves (the ticket promise through the page\'s grouping)', () => {
  const sessions = [sess({}), sess({ ptyId: 'B:sdk', workspaceId: 'B' })];
  const light = groupSessionsByWorkspace(sessions, null, null, attributeBrowserTabMemory([tab('A', 't1', 1)], mem({ 1: 80 * MB })));
  const heavy = groupSessionsByWorkspace(sessions, null, null, attributeBrowserTabMemory([tab('A', 't1', 1)], mem({ 1: 780 * MB })));
  assert.equal(rowOf(heavy, 'A')!.memBytes - rowOf(light, 'A')!.memBytes, 700 * MB);
  assert.equal(rowOf(heavy, 'B')!.memBytes, rowOf(light, 'B')!.memBytes);
  assert.equal(rowOf(heavy, 'B')!.memBytes, 100 * MB, 'B is its sessions only');
  assert.equal(rowOf(heavy, 'A')!.memBytes, 100 * MB + 780 * MB);
  assert.equal(rowOf(heavy, 'A')!.sessions[0].memBytes, 100 * MB, 'the process figure itself is not inflated');
});

test('R2 the row carries its tabs block (chip data); a workspace without a tab, and a call without the view, carry none and keep the old figure', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', 1), tab('A', 't2', null)], mem({ 1: 50 * MB }));
  const g = groupSessionsByWorkspace([sess({}), sess({ ptyId: 'B:sdk', workspaceId: 'B' })], null, null, v);
  assert.deepEqual(rowOf(g, 'A')!.browser, { wsId: 'A', tabs: 2, bytes: 50 * MB, unmeasured: 1, shared: 0 });
  assert.equal(rowOf(g, 'B')!.browser, null);
  assert.equal(new Set(g.rows.map((r) => r.key)).size, g.rows.length, 'ONE row per workspace — a workspace with a session never also gets a browser-only row');
  const none = groupSessionsByWorkspace([sess({})]);
  assert.equal(none.rows[0].memBytes, 100 * MB);
  assert.equal(none.rows[0].browser, null);
  assert.equal(groupSessionsByWorkspace([sess({})], null, null, { byWorkspace: [], attributedPids: [] }).rows[0].memBytes, 100 * MB);
});

test('R3 a workspace whose only footprint is its tabs gets a browser-only row (memory = tabs, no cpu/procs); unmeasured tabs make a row with no figure, 0 bytes', () => {
  const g = groupSessionsByWorkspace([sess({})], null, null, attributeBrowserTabMemory([tab('Z', 't1', 9), tab('Y', 't1', null)], mem({ 9: 64 * MB })));
  const z = rowOf(g, 'Z')!;
  assert.equal(z.browserOnly, true);
  assert.equal(z.memBytes, 64 * MB);
  assert.equal(z.cpuPct, 0);
  assert.equal(z.procCount, 0);
  assert.deepEqual(z.sessions, []);
  assert.equal(z.containerOnly, false);
  assert.equal(rowOf(g, 'Y')!.memBytes, 0);
  assert.equal(rowOf(g, 'Y')!.browser!.bytes, null);
  assert.equal(rowOf(g, 'A')!.browserOnly, false);
});

test('R4 browser-only row + containers: the containers fold into the SAME row, never a second container-only row', () => {
  const containers = cAccountingView(cBuildAccounting([{ wsId: 'Z', bytes: 30 * MB }], [], 1));
  const g = groupSessionsByWorkspace([], containers, null, attributeBrowserTabMemory([tab('Z', 't1', 9)], mem({ 9: 64 * MB })));
  const z = g.rows.filter((r) => r.key === 'Z');
  assert.equal(z.length, 1);
  assert.deepEqual([z[0].browserOnly, z[0].containerOnly, z[0].memBytes], [true, false, 94 * MB]);
  assert.equal(z[0].containers?.bytes, 30 * MB, 'the container chip data rides on the same row');
});

test('R5 a scope-only row (session gone, Reliquats left) also adds its tabs; a sandbox (remote) row bills its tabs too — they are local app memory', () => {
  const v = attributeBrowserTabMemory([tab('gone', 't1', 3), tab('R', 't1', 4)], mem({ 3: 10 * MB, 4: 7 * MB }));
  const members = buildMemberMemoryReport(1, [memberViewFrom('gone', [{ unit: 'u', gen: 'k', currentBytes: 1500 * MB, procs: [{ pid: 9, startTicks: 9, rssBytes: 1400 * MB, role: 'reliquat', comm: 'chrome' } as never], keeperPid: 1 }])], [], null);
  const g = groupSessionsByWorkspace([sess({ ptyId: 'R:sdk', workspaceId: 'R', remote: true, memBytes: 0, procCount: 0 })], null, members, v);
  const gone = rowOf(g, 'gone')!;
  assert.deepEqual([gone.scopeOnly, gone.browserOnly ?? false, gone.memBytes], [true, false, 1500 * MB + 10 * MB]);
  assert.equal(gone.browser!.tabs, 1);
  const remote = rowOf(g, 'R')!;
  assert.equal(remote.remote, true);
  assert.equal(remote.memBytes, 7 * MB);
  assert.equal(remote.browser!.tabs, 1);
});

test('R6 groupSnapshot — the page\'s ONE call — reads the snapshot\'s browserTabs', () => {
  const v = attributeBrowserTabMemory([tab('A', 't1', 1)], mem({ 1: 5 * MB }));
  assert.equal(groupSnapshot({ sessions: [sess({})], browserTabs: v }).rows[0].memBytes, 105 * MB);
  assert.equal(groupSnapshot({ sessions: [sess({})] }).rows[0].memBytes, 100 * MB);
});
