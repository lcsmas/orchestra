import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WatcherSnapshot } from './resilient-watch.ts';
import { degradedKey, degradedLabels, degradedOf, fmtDuration, formatWatchersLines, newerWatchers, watchersStripCopy, type WatchersStatus } from './watcher-status.ts';

// #330 — what bus-status and the app say about the watchers. Asserts the WORDS an operator reads: which watcher, since when, which error, what keeps working; and that a healthy app prints one calm line.

const T0 = Date.parse('2026-10-08T12:53:48Z');
const snap = (name: string, label: string, over: Partial<WatcherSnapshot> = {}): WatcherSnapshot => ({
  name,
  label,
  dir: `/d/${name}`,
  state: 'ok',
  since: T0,
  lastError: null,
  attempts: 0,
  recoveries: 0,
  fallback: '60 s sweep',
  ...over,
});
const down = (name: string, label: string, code = 'EMFILE', over: Partial<WatcherSnapshot> = {}): WatcherSnapshot =>
  snap(name, label, { state: 'degraded', lastError: { code, message: `${code}: too many open files, watch '/d/${name}'` }, attempts: 3, ...over });
const status = (watchers: WatcherSnapshot[], at = T0 + 192_000, rev = 0): WatchersStatus => ({ at, rev, watchers });

test('all ok → ONE calm line; nothing registered → says so (never silent)', () => {
  assert.deepEqual(formatWatchersLines(status([snap('a', 'A'), snap('b', 'B')]), T0), ['watchers: 2 ok']);
  assert.deepEqual(formatWatchersLines(status([]), T0), ['watchers: none armed']);
});

test('degraded: summary line names the labels and the system limit; one line per degraded watcher with since, age, error, attempts, fallback', () => {
  const s = status([snap('events-spool', 'Agent activity'), down('bus-wake', 'Réveils'), down('pause-ui', 'Pause view', 'EMFILE', { fallback: "the UI's own writes and pull" })]);
  const lines = formatWatchersLines(s, T0 + 192_000);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'watchers: 1/3 ok · 2 DEGRADED — Réveils, Pause view (system watch limit reached); the app re-arms by itself');
  assert.match(lines[1], /^ {2}bus-wake DEGRADED since 12:53:48Z \(3m12s\) — system watch limit reached \(EMFILE\)/);
  assert.match(lines[1], /EMFILE: too many open files, watch '\/d\/bus-wake'/);
  assert.match(lines[1], /3 attempts · \/d\/bus-wake · meanwhile: 60 s sweep$/);
  assert.match(lines[2], /meanwhile: the UI's own writes and pull$/);
});

test('a non-limit degradation (ENOENT) does not claim the system limit', () => {
  const lines = formatWatchersLines(status([down('inbox-tray', 'Inbox', 'ENOENT')]), T0 + 5000);
  assert.doesNotMatch(lines.join('\n'), /system watch limit/);
  assert.match(lines[1], /directory missing \(ENOENT\)/);
});

test('degradedOf / degradedLabels / degradedKey', () => {
  const s = status([snap('a', 'A'), down('b', 'Réveils'), down('c', 'Réveils'), down('d', 'Inbox')]);
  assert.deepEqual(
    degradedOf(s).map((w) => w.name),
    ['b', 'c', 'd'],
  );
  assert.deepEqual(degradedLabels(s), ['Réveils', 'Inbox'], 'deduplicated, in order');
  assert.equal(degradedKey(status([snap('a', 'A')])), '');
  assert.equal(degradedKey(null), '');
  // the edge key changes on degrade, on recovery, and when a SECOND degradation starts, not on an unchanged re-read
  const k1 = degradedKey(status([down('b', 'B', 'EMFILE', { since: 10 })]));
  assert.notEqual(k1, degradedKey(status([down('b', 'B', 'ESTALE', { since: 10 })])), 'a change of CAUSE within one degradation changes the strip\'s words, so it is a transition (review m3)');
  assert.equal(k1, degradedKey(status([down('b', 'B', 'EMFILE', { since: 10, attempts: 9 })])), 'attempts counting up is not a transition');
  assert.notEqual(k1, degradedKey(status([down('b', 'B', 'EMFILE', { since: 99 })])), 'a new degradation of the same watcher is');
  assert.notEqual(k1, '');
});

test('strip copy (D-Q8 A): null when healthy; otherwise the plain labels of what lags, the cause (the system limit named), the promise to retry, and one tooltip line per watcher', () => {
  assert.equal(watchersStripCopy(status([snap('a', 'A')]), T0), null);
  assert.equal(watchersStripCopy(null, T0), null);
  const c = watchersStripCopy(status([down('bus-wake', 'Réveils'), down('pause-ui', 'Vue Pause'), snap('inbox-tray', 'Inbox')]), T0 + 192_000)!;
  assert.equal(c.title, 'Mises à jour en retard');
  assert.equal(c.body, 'Réveils, Vue Pause — limite de surveillance de fichiers atteinte. Nouvel essai automatique.');
  assert.equal(c.lines.length, 2, 'only the degraded ones');
  const local = [new Date(T0).getHours(), new Date(T0).getMinutes(), new Date(T0).getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
  assert.equal(c.lines[0], `Réveils · depuis ${local} (3m12s) · system watch limit reached (EMFILE) · en attendant : 60 s sweep`, 'a person reads LOCAL time; bus-status keeps UTC');
  assert.doesNotMatch(c.lines[0], /Z /);
  const other = watchersStripCopy(status([down('inbox-tray', 'Inbox', 'ENOENT')]), T0)!;
  assert.match(other.body, /surveillance de fichiers interrompue/, 'a non-limit cause does not claim the system limit');
  assert.doesNotMatch(other.body, /limite/);
});

test('newerWatchers: ordered by the registry\'s rev, NEVER by the wall clock — a clock stepped back between two readings must not freeze the strip (#330 review M1)', () => {
  const older = status([], 100, 1);
  const newer = status([down('a', 'A')], 200, 2);
  assert.equal(newerWatchers(newer, older), newer, 'a late-answered older pull is dropped');
  assert.equal(newerWatchers(older, newer), newer);
  assert.equal(newerWatchers(null, older), older);
  assert.equal(newerWatchers(undefined, older), older);
  const same = status([], 200, 2);
  assert.equal(newerWatchers(newer, same), same, 'same rev: the incoming one');
  // the clock stepped back two hours between the degradation (rev 5) and the all-clear (rev 6): the all-clear must still win
  const degraded = status([down('a', 'A')], 1_000_000, 5);
  const allClear = status([], 1_000_000 - 2 * 3600_000, 6);
  assert.equal(newerWatchers(degraded, allClear), allClear, 'a later rev wins whatever `at` says');
  assert.equal(newerWatchers(allClear, degraded), allClear, 'and an earlier rev loses whatever `at` says');
});

test('fmtDuration', () => {
  assert.equal(fmtDuration(0), '0s');
  assert.equal(fmtDuration(59_400), '59s');
  assert.equal(fmtDuration(192_000), '3m12s');
  assert.equal(fmtDuration(3_660_000), '1h01m');
  assert.equal(fmtDuration(-5), '0s');
});
