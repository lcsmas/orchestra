import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GIB, type MemoryGuardSnapshot } from './memory-guard.ts';
import { NO_MEMORY_BANNER, bannerCopy, bannerFingerprint, bannerKey, bannerVisible, dismissedWith, frGo, memoryBannerOf, newerBanner, type MemoryBannerState } from './memory-banner.ts';

// #289 (D5 D-pick3, option B) — the pure half of the memory banner: what it shows, in what words, when « Masquer » stops applying. Named arms are what scripts/memory-banner/mutate-unit.mjs reddens.

const SNAP: MemoryGuardSnapshot = {
  sampled: true, measured: true, availBytes: 5.4 * GIB, readAt: 1, admission: 'held', admissionEnabled: true, pause: 'none', episode: 2, pauseCycle: 0, mayReleaseOneStart: false, heldSince: 1, pauseSince: null,
  admissionBytes: 6 * GIB, criticalBytes: 3 * GIB, releaseMarginBytes: GIB, sampleIntervalMs: 10_000,
};

test('STATE kind: Admission HELD ⇒ held; runs UNDER the memory Pause ⇒ pause (even after the guard let go); the guard below critical with NO run paused ⇒ still held, never a red Pause that paused nothing; open ⇒ none', () => {
  assert.equal(memoryBannerOf(SNAP, { heldStarts: 2, pausedRuns: [] }).kind, 'held');
  assert.equal(memoryBannerOf({ ...SNAP, pause: 'held', pauseCycle: 1, availBytes: 2.3 * GIB }, { heldStarts: 0, pausedRuns: ['lead'] }).kind, 'pause');
  assert.equal(memoryBannerOf({ ...SNAP, pause: 'held', pauseCycle: 1 }, { heldStarts: 2, pausedRuns: [] }).kind, 'held', 'the guard is below critical but every pause switch is OFF / no fleet / the runs are held by a manual pause: no Pause in effect, nothing red to announce');
  assert.equal(memoryBannerOf({ ...SNAP, pause: 'held', pauseCycle: 1, admissionEnabled: false }, { heldStarts: 0, pausedRuns: [] }).kind, 'none', 'and with the Admission toggle OFF there is nothing at all');
  assert.equal(memoryBannerOf({ ...SNAP, pause: 'none', admission: 'open' }, { heldStarts: 0, pausedRuns: ['lead'] }).kind, 'pause', 'runs are still paused after the guard let go: the Pause IS still in effect');
  assert.equal(memoryBannerOf({ ...SNAP, admission: 'open' }, { heldStarts: 0, pausedRuns: [] }).kind, 'none');
});

test('STATE unreadable keeps what the guard holds, a guard that never held shows nothing, toggle OFF holds nothing', () => {
  const unreadable = memoryBannerOf({ ...SNAP, measured: false }, { heldStarts: 2, pausedRuns: [] });
  assert.equal(unreadable.kind, 'held', 'ONE unreadable sample must not blank the banner: the guard keeps its state (and the human keeps their dismissals) until a good reading says otherwise');
  assert.equal(unreadable.availBytes, null, 'the figure is unreadable, never the last good one');
  assert.equal(unreadable.episode, SNAP.episode);
  assert.equal(memoryBannerOf({ ...SNAP, measured: false, admission: 'open' }, { heldStarts: 0, pausedRuns: [] }).kind, 'none', 'a guard that never held, with nothing readable, shows nothing');
  assert.equal(memoryBannerOf({ ...SNAP, admissionEnabled: false }, { heldStarts: 0, pausedRuns: [] }).kind, 'none');
  assert.equal(memoryBannerOf({ ...SNAP, admissionEnabled: false, pause: 'held' }, { heldStarts: 0, pausedRuns: ['lead'] }).kind, 'pause', 'the memory Pause is governed by the runs\' switches, not by the Admission toggle');
  assert.equal(memoryBannerOf({ ...SNAP, measured: false, pause: 'held' }, { heldStarts: 0, pausedRuns: ['lead'] }).availBytes, null, 'a dead meter\'s last good reading is never shown as current');
  assert.deepEqual(memoryBannerOf({ ...SNAP, admission: 'open', episode: 9 }, { heldStarts: 3, pausedRuns: [] }, 4), { ...NO_MEMORY_BANNER, rev: 4 }, 'none is ALWAYS the same state: the figures of an idle guard never read as a change')
});

test('STATE fields: the guard\'s thresholds, episode, cycle and the host facts are carried', () => {
  const b = memoryBannerOf({ ...SNAP, pause: 'held', pauseCycle: 3, episode: 5, availBytes: 2.3 * GIB }, { heldStarts: 4, pausedRuns: ['lead', 'ops'] }, 9);
  assert.deepEqual(b, { kind: 'pause', episode: 5, pauseCycle: 3, availBytes: 2.3 * GIB, admissionBytes: 6 * GIB, criticalBytes: 3 * GIB, releaseMarginBytes: GIB, heldStarts: 4, pausedRuns: ['lead', 'ops'], rev: 9 });
});

test('DISMISS: « Masquer » hides exactly that banner — it REAPPEARS on an escalation (held → Pause), on a new Pause cycle and on the next episode; it never shows for kind none', () => {
  const held = memoryBannerOf(SNAP, { heldStarts: 0, pausedRuns: [] });
  const key = bannerKey(held);
  assert.equal(bannerVisible(held, []), true);
  assert.equal(bannerVisible(held, [key]), false, 'dismissed');
  assert.equal(bannerVisible({ ...held, heldStarts: 9, availBytes: 5.0 * GIB }, [key]), false, 'counts and readings moving do not bring it back');
  const pause = memoryBannerOf({ ...SNAP, pause: 'held', pauseCycle: 1 }, { heldStarts: 0, pausedRuns: ['lead'] });
  assert.equal(bannerVisible(pause, [key]), true, 'escalation: held → Pause shows again');
  const pk = bannerKey(pause);
  assert.equal(bannerVisible(pause, [key, pk]), false);
  assert.equal(bannerVisible({ ...pause, pauseCycle: 2 }, [key, pk]), true, 'a new Pause cycle shows again');
  assert.equal(bannerVisible({ ...held, episode: 3 }, [key, pk]), true, 'the next episode shows again');
  assert.equal(bannerVisible(held, [key, pk]), false, 'a Pause that lifts back to held does not undo the dismissal of the held banner (a de-escalation is not news)');
  assert.equal(bannerVisible(NO_MEMORY_BANNER, []), false);
  assert.equal(bannerVisible(null, []), false);
});

test('DISMISS keys: « Masquer » adds the key of the banner on screen once; nothing to hide for none / null', () => {
  const held = memoryBannerOf(SNAP, { heldStarts: 0, pausedRuns: [] });
  const pause = memoryBannerOf({ ...SNAP, pause: 'held', pauseCycle: 1 }, { heldStarts: 0, pausedRuns: ['lead'] });
  const one = dismissedWith([], held);
  assert.deepEqual(one, [bannerKey(held)]);
  assert.deepEqual(dismissedWith(one, held), one, 'idempotent');
  assert.deepEqual(dismissedWith(one, pause), [bannerKey(held), bannerKey(pause)], 'the keys accumulate until a recovery clears them');
  assert.deepEqual(dismissedWith(one, NO_MEMORY_BANNER), one);
  assert.deepEqual(dismissedWith(one, null), one);
});

test('DISMISS red covers the episode: « Masquer » on the RED banner alone also hides that episode\'s amber one (the Pause lifting back to held is a de-escalation); another episode and a later red are unaffected', () => {
  const held = memoryBannerOf(SNAP, { heldStarts: 0, pausedRuns: [] });
  const red = memoryBannerOf({ ...SNAP, pause: 'held', pauseCycle: 1 }, { heldStarts: 0, pausedRuns: ['lead'] });
  const afterRed = dismissedWith([], red);
  assert.deepEqual(afterRed, [bannerKey(red), bannerKey(held)], 'both keys of the episode');
  assert.equal(bannerVisible(red, afterRed), false);
  assert.equal(bannerVisible(held, afterRed), false, 'amber (not hidden first) → red → Masquer → Pause lifts at 6.5 GB, still held: the amber banner does NOT come back');
  assert.equal(bannerVisible({ ...held, episode: SNAP.episode + 1 }, afterRed), true, 'the next episode shows again');
  assert.equal(bannerVisible({ ...red, pauseCycle: 2 }, afterRed), true, 'a new Pause cycle shows again');
  const afterAmber = dismissedWith([], held);
  assert.equal(bannerVisible(red, afterAmber), true, 'hiding the amber one never hides a later red');
  assert.deepEqual(dismissedWith(afterRed, red), afterRed, 'idempotent');
});

test('KEY: held keys on the episode only, the Pause on episode + cycle', () => {
  assert.equal(bannerKey({ kind: 'held', episode: 4, pauseCycle: 9 }), '4:held:0');
  assert.equal(bannerKey({ kind: 'pause', episode: 4, pauseCycle: 9 }), '4:pause:9');
});

test('PUSH: the fingerprint ignores the revision only; a newer revision wins, an older one never rolls the banner back', () => {
  const a = memoryBannerOf(SNAP, { heldStarts: 1, pausedRuns: [] }, 1);
  assert.equal(bannerFingerprint(a), bannerFingerprint({ ...a, rev: 7 }));
  assert.notEqual(bannerFingerprint(a), bannerFingerprint({ ...a, heldStarts: 2 }));
  assert.equal(newerBanner(a, { ...a, rev: 2 }).rev, 2);
  assert.equal(newerBanner({ ...a, rev: 5 }, a).rev, 5, 'an older pull answered late is dropped');
  assert.equal(newerBanner(null, a).rev, 1);
});

test('FRENCH go: a comma, one decimal, whole figures without it', () => {
  assert.equal(frGo(5.4 * GIB), '5,4 Go');
  assert.equal(frGo(6 * GIB), '6 Go');
  assert.equal(frGo(2.34 * GIB), '2,3 Go');
  assert.equal(frGo(7 * GIB), '7 Go');
  assert.equal(frGo(0), '0 Go');
  assert.equal(frGo(5.46 * GIB), '5,5 Go', 'ROUNDS, never floors');
  assert.equal(frGo(5.44 * GIB), '5,4 Go');
  assert.equal(frGo(2.96 * GIB), '3 Go', 'a figure that rounds to a whole number prints without a decimal');
});

test('COPY held (mockup B1, D5-approved): headline + detail, the held-start count and the reopen threshold with its margin', () => {
  const c = bannerCopy(memoryBannerOf(SNAP, { heldStarts: 2, pausedRuns: [] }))!;
  assert.equal(c.tone, 'warn');
  assert.equal(c.title, "Mémoire basse — 5,4 Go disponibles (seuil 6 Go). Les démarrages automatiques d'agents sont retenus ; les agents inactifs passent en Veille.");
  assert.equal(c.sub, "2 démarrages retenus · relâchés dès 7 Go, coordinateurs d'abord, un par un.");
  assert.match(bannerCopy(memoryBannerOf(SNAP, { heldStarts: 1, pausedRuns: [] }))!.sub, /^1 démarrage retenu · /, 'singular');
  assert.match(bannerCopy(memoryBannerOf(SNAP, { heldStarts: 0, pausedRuns: [] }))!.sub, /^0 démarrage retenu · /, 'the drawn pattern with N = 0 (no wording outside the approved mockup)');
});

test('COPY Pause (mockup B2, D5-approved): the critical threshold, the paused runs, the automatic Reprise threshold and the manual-pause promise', () => {
  const b = memoryBannerOf({ ...SNAP, pause: 'held', pauseCycle: 1, availBytes: 2.3 * GIB }, { heldStarts: 0, pausedRuns: ['lead', 'ops'] });
  const c = bannerCopy(b)!;
  assert.equal(c.tone, 'crit');
  assert.equal(c.title, 'Pause mémoire — 2,3 Go disponibles (seuil critique 3 Go). 2 runs en pause : lead, ops.');
  assert.equal(c.sub, "Reprise automatique dès 6 Go · une pause manuelle n'est jamais levée par la garde.");
  assert.match(bannerCopy({ ...b, pausedRuns: ['lead'] })!.title, /1 run en pause : lead\./, 'singular');
  assert.match(bannerCopy({ ...b, pausedRuns: ['a', 'b', 'c'] })!.title, /3 runs en pause : a, b, c\./, 'three names are listed whole');
  assert.match(bannerCopy({ ...b, pausedRuns: ['a', 'b', 'c', 'd'] })!.title, /4 runs en pause : a, b, c \+1\./, 'the 4th is counted, not listed');
  assert.match(bannerCopy({ ...b, pausedRuns: ['a', 'b', 'c', 'd', 'e'] })!.title, /5 runs en pause : a, b, c \+2\./, 'a long list is cut');
  assert.match(bannerCopy({ ...b, availBytes: null })!.title, /^Pause mémoire — mesure illisible \(seuil critique 3 Go\)\./);
  assert.match(bannerCopy(memoryBannerOf({ ...SNAP, measured: false }, { heldStarts: 1, pausedRuns: [] }))!.title, /^Mémoire basse — mesure illisible \(seuil 6 Go\)\./, 'the held banner says the reading is unreadable while the guard still holds');
});

test('COPY none: nothing to say', () => {
  assert.equal(bannerCopy(NO_MEMORY_BANNER as MemoryBannerState), null);
});
