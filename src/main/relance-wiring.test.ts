// #427 — source-wiring gate: relance-host.ts / index.ts / pause-reliquats.ts cannot be loaded under `node --test` (store / platform seam), so the WIRING of the Relance is asserted on the
// shipped source. The behaviour behind it is driven for real — the real CLI against the fake API — by scripts/session-budget/relance.mjs. Each arm names the clause it protects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => fs.readFileSync(path.join(here, f), 'utf8');
const live = (src: string, needle: string): boolean => src.split('\n').some((l) => l.includes(needle) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));

test('the app starts the Relance after the liveness sweep and stops it before the bus closes', () => {
  const index = read('index.ts');
  assert.ok(live(index, "import { startRelanceHost, stopRelance } from './relance-host';"));
  assert.ok(live(index, '  startRelanceHost();'));
  assert.ok(index.indexOf('  startBusLiveness();') < index.indexOf('  startRelanceHost();'), 'started after the liveness sweep');
  assert.ok(index.indexOf('  stopRelance();') < index.indexOf('  closeBus();'), 'stopped before closeBus()');
});

test('delivery is a Réveil\'s path: the Admission gate first (HELD ≠ failed), then sdkStartAndDeliver, which resumes a member in Veille', () => {
  const host = read('relance-host.ts');
  assert.match(host, /wakeHeldForMemory\(ws, \(\) => sweepRelanceNow\(productionRelanceDeps\), \{ site: 'relance' \}\)\) return 'held'/);
  assert.match(host, /sdkStartAndDeliver\(wsId, text\)\) \? 'sent' : 'failed'/);
  assert.ok(host.indexOf('wakeHeldForMemory(') < host.indexOf('sdkStartAndDeliver(wsId'), 'gate before the start');
  assert.doesNotMatch(host, /origin:\s*'human'/, 'a host turn is never a HUMAN turn (it must stay refused while paused)');
});

test('the host wires the roster\'s real sources: the bus released read, the run id, pauseRefusal, the wake roster; the kill switch and the fresh per-member read', () => {
  const host = read('relance-host.ts');
  for (const re of [
    /readReleasedReaders\(db, readers\)/,
    /runIdOf: \(ws\) => resolveWaveRunId\(ws\)/,
    /paused: \(ws\) => pauseRefusal\(ws, 'auto'\) !== null/,
    /wakeable: \(ws\) => wakeRosterEntry\(ws\)\.wakeable/,
    /members: \(\) => relanceMembers\(roster\)/,
    /member: \(wsId\) => relanceMember\(roster, wsId\)/,
    /if \(!relanceEnabled\(process\.env\)\) \{/,
    /census: \(wsId\) => censusReliquatsOf\(wsId\)/,
  ]) assert.match(host, re);
});

test('every host stop of a member\'s Reliquats registers its victims BEFORE the first signal (Veille, Pause and scope stop all go through killReliquats)', () => {
  const src = read('pause-reliquats.ts');
  assert.ok(live(src, "import { noteHostStopped } from './relance-stopped.ts';"));
  const at = src.indexOf('noteHostStopped(plan.targets);');
  assert.ok(at > 0, 'registered');
  assert.ok(at < src.indexOf("if (signalOne(t, 'SIGTERM'))"), 'before the first signal');
  // the browser pass (the monitor's 60 s tick, a Pause dure, a Veille) is the other host stop of a Reliquat: registered before ITS first signal too
  const br = read('browser-reliquats.ts');
  assert.ok(live(br, "import { noteHostStopped } from './relance-stopped.ts';"));
  const regAt = br.indexOf('noteHostStopped(order.filter(');
  assert.ok(regAt > 0 && regAt < br.indexOf("if (d.signal(m.pid, 'SIGTERM')) sent.push(m)"), 'registered before the SIGTERM of the group');
  for (const f of ['veille-reliquats-port.ts', 'scope-stop.ts', 'pause-trap-host.ts']) {
    assert.match(read(f), /killReliquats/, `${f} stops Reliquats through killReliquats`);
  }
});

test('the sweep reads the host-stop registry and the pure decision — it holds no exclusion of its own', () => {
  const src = read('relance.ts');
  assert.match(src, /observeReliquats\(tracks\.get\(m\.wsId\), census, now, \(k\) => wasStoppedByHost\(k, now\)\)/);
  assert.match(src, /decideRelance\(m, track, now\)/);
});
