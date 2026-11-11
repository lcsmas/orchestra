// #428 — source-wiring gate: vague-endormie-host.ts / index.ts / hooks-server.ts cannot be loaded under `node --test` (store / platform seam), so the WIRING of the asleep-vague mechanism is asserted on
// the shipped source. The behaviour behind it is driven for real — the real CLI against the fake API — by scripts/session-budget/vague-endormie.mjs. Each arm names the clause it protects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => fs.readFileSync(path.join(here, f), 'utf8');
const live = (src: string, needle: string): boolean => src.split('\n').some((l) => l.includes(needle) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));

test('the app starts the asleep-vague sweep after the Relance and stops it before the bus closes', () => {
  const index = read('index.ts');
  assert.ok(live(index, "import { registerVagueMarksIpc, startVagueEndormieHost, stopVagueEndormie } from './vague-endormie-host';"));
  assert.ok(live(index, '  startVagueEndormieHost({ heldStart: livenessSilencedByAdmission });'), 'Admission\'s held-start predicate is injected from index.ts (the only importer of Admission here)');
  assert.ok(index.indexOf('  startRelanceHost();') < index.indexOf('  startVagueEndormieHost({'));
  assert.ok(index.indexOf('  stopVagueEndormie();') < index.indexOf('  closeBus();'), 'stopped before closeBus()');
});

test('the coordinator\'s Relance goes through THE Relance delivery (Admission, then sdkStartAndDeliver) — the same function as a member\'s Relance, with its own Admission site', () => {
  const host = read('vague-endormie-host.ts');
  assert.match(host, /deliver: \(coordinatorId, text, retry\) => deliverRelance\(coordinatorId, text, 'relance-vague', retry \?\? \(\(\) => sweepVaguesNow\(productionVagueDeps\)\)\)/);
  const rel = read('relance-host.ts');
  assert.match(rel, /export async function deliverRelance\(wsId: string, text: string, site: string, retry: \(\) => Promise<unknown>\)/);
  assert.match(rel, /wakeHeldForMemory\(ws, retry, \{ site \}\)\) return 'held'/);
  assert.match(rel, /deliverRelance\(wsId, text, 'relance', \(\) => sweepRelanceNow\(productionRelanceDeps\)\)/);
  assert.ok(rel.indexOf('wakeHeldForMemory(') < rel.indexOf('sdkStartAndDeliver(wsId'), 'gate before the start');
  assert.doesNotMatch(host, /origin:\s*'human'/, 'a host turn is never a HUMAN turn (it must stay refused while paused)');
});

test('the host wires the roster\'s real sources: run id, bus released / waiting reads, held runs, pauseRefusal, Admission\'s held start, the idle clock; the kill switch of the Relance family', () => {
  const host = read('vague-endormie-host.ts');
  for (const re of [
    /runIdOf: \(ws\) => resolveWaveRunId\(ws\)/,
    /released: \(readers\) => readReleasedReaders\(busOrThrow\(\), readers\)/,
    /busWaiting: \(readers\) => readWaitingReaders\(busOrThrow\(\), readers\)/,
    /heldRuns: \(\) => heldRunIds\(busOrThrow\(\)\)/,
    /paused: \(ws\) => pauseRefusal\(ws, 'auto'\) !== null/,
    /heldStart: \(ws\) => heldStartOf\(ws\.id\)/,
    /heldStartOf = opts\.heldStart;/,
    /lastActivityAt: \(ws\) => idleClockOf\(ws\)/,
    /seenThisRun: \(ws\) => seenThisRun\(ws\.id\)/,
    /backgroundTask: \(ws\) => sdkHasBackgroundTasks\(ws\.id\)/,
    /wakeable: \(ws\) => wakeRosterEntry\(ws\)\.wakeable/,
    /rosterTrusted: \(\) => store\.loadedFromDisk/,
    /persist: createVagueFileStore\(\(\) => path\.join\(orchestraHome\(\), 'vague-endormie\.json'\)\)/,
    /vagues: \(\) => vagueFacts\(roster\)/,
    /vague: \(runId\) => vagueFactsOf\(roster, runId\)/,
    /census: \(wsId\) => censusReliquatsOf\(wsId\)/,
    /if \(!relanceEnabled\(process\.env\)\) \{/,
  ]) assert.match(host, re);
});

test('bus-status carries the asleep vagues and the CLI prints them', () => {
  const hooks = read('hooks-server.ts');
  assert.ok(live(hooks, "import { asleepVagues } from './vague-endormie.ts';"));
  assert.ok(live(hooks, '              asleepVagues: asleepVagues(),'));
  const cli = fs.readFileSync(path.join(here, '..', 'cli', 'index.ts'), 'utf8');
  assert.match(cli, /formatAsleepVaguesLines\(res\.asleepVagues as AsleepVagueView\[\], Date\.now\(\), shownRunId\)/);
});

test('the sweep holds no exclusion of its own: it folds the facts through the pure stepVague and builds the text with the Relance primitive', () => {
  const src = read('vague-endormie.ts');
  assert.match(src, /stepVague\(prev, f, census, now, bounds\)/);
  assert.match(src, /buildVagueAsleepRelance\(fresh, verdict\.since, verdict\.unfinished, verdict\.processes, bounds\.processMs\)/);
  assert.match(read('../shared/vague-endormie.ts'), /import \{ buildRelance, /, 'the coordinator\'s Relance is the #427 primitive, not a second shape');
});

// ── #429: the human step — host, IPC, preload, store, Sidebar, Settings. Each arm names the clause it protects. ───────────

const rootOf = (f: string): string => fs.readFileSync(path.join(here, '..', '..', f), 'utf8');

test('#429 the delays are LIVE settings read at every pass (never cached), a write asks the sweep for a pass at once; the human is told through the platform notification, a click focuses the coordinator', () => {
  const host = read('vague-endormie-host.ts');
  assert.match(host, /bounds: \(\) => delaysToMs\(getVagueDelays\(\)\)/, 'read per pass');
  assert.match(host, /setVagueDelaysChangedHook\(\(\) => void sweepVaguesNow\(productionVagueDeps\)\)/, 'a Settings write is judged at once');
  assert.match(host, /platform\.notify\(\{ wsId: n\.coordinatorId, kind: 'needsInput', title, body \}\)/, 'the toast focuses the coordinator\'s workspace on click (electron.ts: workspace:focus)');
  assert.match(host, /onMarks: \(\) => broadcastVagueMarks\(\)/);
  assert.match(host, /platform\.broadcast\(VAGUE_MARKS_PUSH_CHANNEL, stamped\(\)\)/);
  const set = read('vague-delays-setting.ts');
  assert.match(set, /if \(error\) return \{ ok: false, error \};/, 'an invalid value returns BEFORE any write');
  assert.match(set, /\n    onChanged\(\);\n/, 'a write asks the sweep for a pass');
  assert.match(set, /vagueDelaysError\(next\)/, 'the write validates');
  assert.ok(set.indexOf('vagueDelaysError(next)') < set.indexOf('store.setVagueDelays('), 'validated BEFORE the write');
});

test('#429 the IPC: pull + Relancer registered ONCE at module scope; the Relancer goes through relanceVagueNow (which refuses a coordinator without a parent); the channels are the ones the preload speaks', () => {
  const index = read('index.ts');
  assert.ok(live(index, 'registerVagueMarksIpc(); // #429'), 'registered at module scope');
  const host = read('vague-endormie-host.ts');
  assert.match(host, /ipcMain\.handle\(VAGUE_RELANCE_CHANNEL, async \(_e, runId: unknown\): Promise<RelanceNowResult> => \(typeof runId === 'string' \? relanceVagueNow\(productionVagueDeps, runId\) : 'not-asleep'\)\)/);
  assert.match(host, /ipcMain\.handle\(VAGUE_MARKS_PULL_CHANNEL, \(\): VagueMarks => stamped\(\)\)/);
  assert.match(host, /VAGUE_MARKS_PUSH_CHANNEL = 'vague:update'/);
  assert.match(host, /VAGUE_MARKS_PULL_CHANNEL = 'vague:marks'/);
  assert.match(host, /VAGUE_RELANCE_CHANNEL = 'vague:relance'/);
  const pre = rootOf('src/preload/index.ts');
  assert.match(pre, /vagueMarks: \(\) => ipcRenderer\.invoke\('vague:marks'\)/);
  assert.match(pre, /ipcRenderer\.on\('vague:update', listener\)/);
  assert.match(pre, /relanceVague: \(runId\) => ipcRenderer\.invoke\('vague:relance', runId\)/);
  const api = rootOf('src/main/api-handlers.ts');
  assert.match(api, /setVagueDelays: 'settings:setVagueDelays'/);
  assert.match(api, /\| 'relanceVague'/, 'the Relancer is not reachable as a « served read »');
});

test('#429 NOTHING is sent to the LEAD\'s conversation by the human step: the manual Relancer refuses a coordinator without a parent BEFORE any delivery, and the human step itself never calls deliver', () => {
  const sweep = read('vague-endormie.ts');
  const fn = sweep.slice(sweep.indexOf('export async function relanceVagueNow'), sweep.indexOf('/** A pass that is guaranteed to run:'));
  assert.ok(fn.indexOf('!fresh.coordinatorHasParent') > 0 && fn.indexOf('!fresh.coordinatorHasParent') < fn.indexOf('deps.deliver('), 'parent check precedes the delivery');
  const human = sweep.slice(sweep.indexOf('// The HUMAN step (#429)'), sweep.indexOf('if (verdict.nudge === \'not-wakeable\')'));
  assert.doesNotMatch(human, /deps\.deliver|sdkSend|sendBus/, 'the human step has no send path');
  const marks = rootOf('src/shared/vague-human.ts');
  assert.doesNotMatch(marks, /deliver|sdkSend|sendBus/);
});

test('#429 the renderer: marks loaded at boot (survives a restart / a reload), replaced by the push, drawn on the coordinator row and dimmed on the members in BOTH sidebar render paths; the Settings dialog is reachable', () => {
  const st = rootOf('src/renderer/store.ts');
  assert.match(st, /window\.orchestra\.vagueMarks\(\)/, 'boot pull');
  assert.match(st, /window\.orchestra\.onVagueMarks\(\(marks\) => \{\s*useStore\.setState\(\(st\) => \(\{ vagueMarks: newerVagueMarks\(st\.vagueMarks, marks\) \}\)\);/, 'replace on push');
  const sb = rootOf('src/renderer/components/Sidebar.tsx');
  const count = (needle: string): number => sb.split(needle).length - 1;
  assert.equal(count('${vagueDimClass(vagueMarks, w.id)}'), 2, 'the pinned tree and the repo tree both dim members');
  assert.equal(count('<VagueRowBadge wsId={w.id} />'), 2);
  assert.equal(count('<VagueRowNote wsId={w.id} />'), 2);
  assert.ok(sb.includes('{isCollapsed && <VagueFoldHint hidden={hidden} />}') && sb.includes('{isCollapsed && <VagueFoldHint hidden={hiddenKids} />}'), 'a folded ancestor carries the hint in both render paths');
  assert.ok(sb.includes('aria-label="Réglages de la vague endormie"'), 'the header button is French');
  assert.ok(sb.includes('const vagueMarks = useStore((s) => s.vagueMarks);'));
  assert.ok(sb.includes('{vagueSettingsOpen && <VagueEndormieSettings onClose={() => setVagueSettingsOpen(false)} />}'));
  assert.ok(rootOf('src/renderer/main.tsx').includes("import './vague-endormie.css';"));
  const note = rootOf('src/renderer/components/VagueMark.tsx');
  assert.match(note, /mark\.canRelance && \(/, 'the Relancer is rendered only where a Relance can go');
  assert.match(note, /disabled=\{working\}/, 'disabled while a delivery is in flight');
  assert.match(note, /aria-label=\{relancerLabel\(mark\)\}/, 'the name says which coordinator');
  assert.match(note, /role="status" aria-live="polite"/, 'the answer is a live region that stays mounted');
  assert.match(note, /e\.stopPropagation\(\)/, 'a click on the button is not a click on the row (it must not select the sleeping workspace)');
});
