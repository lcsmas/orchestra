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
  assert.ok(live(index, "import { startVagueEndormieHost, stopVagueEndormie } from './vague-endormie-host';"));
  assert.ok(live(index, '  startVagueEndormieHost({ heldStart: livenessSilencedByAdmission });'), 'Admission\'s held-start predicate is injected from index.ts (the only importer of Admission here)');
  assert.ok(index.indexOf('  startRelanceHost();') < index.indexOf('  startVagueEndormieHost({'));
  assert.ok(index.indexOf('  stopVagueEndormie();') < index.indexOf('  closeBus();'), 'stopped before closeBus()');
});

test('the coordinator\'s Relance goes through THE Relance delivery (Admission, then sdkStartAndDeliver) — the same function as a member\'s Relance, with its own Admission site', () => {
  const host = read('vague-endormie-host.ts');
  assert.match(host, /deliver: \(coordinatorId, text\) => deliverRelance\(coordinatorId, text, 'relance-vague', \(\) => sweepVaguesNow\(productionVagueDeps\)\)/);
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
