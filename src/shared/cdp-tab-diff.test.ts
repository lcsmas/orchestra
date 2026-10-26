// #400 (seat-2 MAJOR): a tab REBUILT in place keeps its id but not its page — the proxy must hear `replaced`, never a bare `changed`.
// Mutants: scripts/mutate-browser-profiles.mjs (the `cdp-tab-diff` block).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffTabs, type DiffTab } from './cdp-tab-diff.ts';
import type { CdpTab } from './cdp-proxy-core.ts';

const tab = (id: string, url = `http://x/${id}`, extra: Partial<CdpTab> = {}): CdpTab => ({ id, url, title: id.toUpperCase(), active: false, openedBy: 'human', ...extra });
const snap = (...rows: Array<[CdpTab, number | undefined]>): Map<string, DiffTab> => new Map(rows.map(([t, view]) => [t.id, { tab: t, view }]));
const shape = (es: ReturnType<typeof diffTabs>) => es.map((e) => `${e.kind}:${e.tab.id}`);

test('nothing changed → no event', () => {
  assert.deepEqual(diffTabs(snap([tab('t1'), 11]), snap([tab('t1'), 11])), []);
});

test('a new id is created, a missing id destroyed (with the tab as it WAS), url/title/active changes are `changed`', () => {
  const prev = snap([tab('t1'), 11], [tab('t2'), 12]);
  const next = snap([tab('t1', 'http://x/moved'), 11], [tab('t3'), 13]);
  const es = diffTabs(prev, next);
  assert.deepEqual(shape(es), ['changed:t1', 'created:t3', 'destroyed:t2']);
  assert.equal(es[0].tab.url, 'http://x/moved');
  assert.equal(es[2].tab.url, 'http://x/t2');
  assert.deepEqual(shape(diffTabs(snap([tab('t1'), 11]), snap([tab('t1', 'http://x/t1', { active: true }), 11]))), ['changed:t1']);
  assert.deepEqual(shape(diffTabs(snap([tab('t1'), 11]), snap([tab('t1', 'http://x/t1', { title: 'other' }), 11]))), ['changed:t1']);
});

test('SAME id on a DIFFERENT view (an in-place rebuild) → ONE `replaced` event carrying the NEW page — never `changed`, never destroyed + created', () => {
  const es = diffTabs(snap([tab('t1', 'http://x/old'), 11]), snap([tab('t1', 'http://x/new'), 42]));
  assert.deepEqual(shape(es), ['replaced:t1']);
  assert.equal(es[0].tab.url, 'http://x/new', 'replaced names the page that took over');
});

test('a rebuild with an UNCHANGED url/title still replaces (the page is new even if it reads the same)', () => {
  assert.deepEqual(shape(diffTabs(snap([tab('t1'), 11]), snap([tab('t1'), 42]))), ['replaced:t1']);
});

test('a profile attach: EVERY tab of the panel is replaced, ids kept; a tab opened meanwhile is only created; a closed one only destroyed', () => {
  const prev = snap([tab('t1'), 11], [tab('t2'), 12], [tab('t3'), 13]);
  const next = snap([tab('t1'), 21], [tab('t2'), 22], [tab('t4'), 24]);
  assert.deepEqual(shape(diffTabs(prev, next)), ['replaced:t1', 'replaced:t2', 'created:t4', 'destroyed:t3']);
});

test('an UNKNOWN view on either side is never read as a replacement (no live contents to compare)', () => {
  assert.deepEqual(shape(diffTabs(snap([tab('t1'), undefined]), snap([tab('t1'), 42]))), []);
  assert.deepEqual(shape(diffTabs(snap([tab('t1'), 11]), snap([tab('t1'), undefined]))), []);
  assert.deepEqual(shape(diffTabs(snap([tab('t1'), undefined]), snap([tab('t1', 'http://x/n'), undefined]))), ['changed:t1']);
});
