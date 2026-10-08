import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WatcherSnapshot } from './resilient-watch.ts';
import { degradedKey, degradedLabels, degradedOf, fmtDuration, formatWatchersLines, watchersWarning, type WatchersStatus } from './watcher-status.ts';

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
const status = (watchers: WatcherSnapshot[], at = T0 + 192_000): WatchersStatus => ({ at, watchers });

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
  assert.equal(k1, degradedKey(status([down('b', 'B', 'EMFILE', { since: 10, attempts: 9 })])), 'attempts counting up is not a transition');
  assert.notEqual(k1, degradedKey(status([down('b', 'B', 'EMFILE', { since: 99 })])), 'a new degradation of the same watcher is');
  assert.notEqual(k1, '');
});

test('watchersWarning: null when healthy; names what lags and promises the retry', () => {
  assert.equal(watchersWarning(status([snap('a', 'A')])), null);
  assert.equal(watchersWarning(null), null);
  const w = watchersWarning(status([down('bus-wake', 'Réveils'), down('pause-ui', 'Pause view')]));
  assert.match(w!, /^Réveils, Pause view may lag/);
  assert.match(w!, /system watch limit reached/);
  assert.match(w!, /retrying automatically/);
});

test('fmtDuration', () => {
  assert.equal(fmtDuration(0), '0s');
  assert.equal(fmtDuration(59_400), '59s');
  assert.equal(fmtDuration(192_000), '3m12s');
  assert.equal(fmtDuration(3_660_000), '1h01m');
  assert.equal(fmtDuration(-5), '0s');
});
