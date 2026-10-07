import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #289 — structural pins of the Electron-bound seams of the memory alert (they cannot be imported under node --test): a silent un-wiring is a feature that is dead while every logic test stays green.
// The behaviour behind each seam is driven by src/main/memory-alert.test.ts (real bus + REAL guard) and scripts/e2e-memory-alert.mjs (real built CLI reads the row).

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Source with line-leading block comments and full-line `//` comments removed: a call that was merely COMMENTED OUT must not satisfy a pin. */
const read = (f: string): string => fs.readFileSync(path.join(HERE, f), 'utf8').replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/.*$/gm, '');

test('CONTROL: the sources are the real files', () => {
  assert.match(read('memory-alert-host.ts'), /export function startMemoryAlert\(\): void \{/);
  assert.match(read('memory-alert.ts'), /export function createMemoryAlert\(/);
});

test('WIRING host (FI-2.5): SUBSCRIBE to the guard FIRST, then reconcile from the snapshot — never snapshot-then-subscribe (an edge in between is lost)', () => {
  const body = read('memory-alert-host.ts');
  const start = body.slice(body.indexOf('export function startMemoryAlert(): void {'));
  const sub = start.indexOf('subscribeMemoryGuard(');
  const rec = start.indexOf('alert.reconcile(getMemoryGuardSnapshot());');
  assert.ok(sub > 0 && rec > sub, 'subscribe, then reconcile');
  assert.match(start, /unsubscribe = subscribeMemoryGuard\(\(e\) => alert\.onEdge\(e\)\);/, 'every guard edge reaches the alert');
  assert.match(body, /timer|h\.unref\?\.\(\);/, 'the settle timer never keeps the process alive');
});

test('WIRING host: the real store / bus / guard snapshot, the Admission queue count, Veille by `hibernatedAt`, and the unattributed-container field (0 until #293)', () => {
  const s = read('memory-alert-host.ts');
  assert.match(s, /getWorkspace: \(id\) => store\.getWorkspace\(id\),/);
  assert.match(s, /storeReady: \(\) => store\.loadedFromDisk,/);
  assert.match(s, /snapshot: getMemoryGuardSnapshot,/);
  assert.match(s, /heldStarts: \(\) => listHeldStarts\(\)\.length,/);
  assert.match(s, /veilleSince: \(at\) => store\.workspaces\.filter\(\(w\) => !w\.archived && !!w\.parentId && \(w\.hibernatedAt \?\? 0\) >= at\)\.length,/);
  assert.match(s, /unattributedContainers: \(\) => getContainerAccounting\(\)\.unattributed\.count,/, '#293 FI-3.4: the number comes from the last monitor tick\'s accounting');
  assert.match(s, /unattributedDaemonsDown: \(\) => getContainerAccounting\(\)\.daemonsDown,/, 'a partial Docker outage reaches the row (the count is then a lower bound)');
  assert.match(s, /unattributedDocker: \(\) => getContainerAccounting\(\)\.docker,/, 'the row gets the accounting STATE: unreachable / failed / never sampled is NOT "0 unattributed", and each says its own reason');
  assert.match(s, /import \{ getContainerAccounting \} from '\.\/container-accounting\.ts';/);
});

test('WIRING index.ts: the alert starts AFTER the memory Pause (store loaded, live tree registered) and stops BEFORE it at shutdown', () => {
  const s = read('index.ts');
  const pause = s.indexOf('startMemoryPause();');
  const alert = s.indexOf('startMemoryAlert();');
  assert.ok(pause > 0 && alert > pause, 'start order: memory Pause, then the alert');
  assert.equal(s.split('startMemoryAlert();').length - 1, 1, 'started exactly once');
  const shut = s.slice(s.indexOf('function shutdownSubsystems(): void {'));
  const body = shut.slice(0, shut.indexOf('\n}\n'));
  assert.ok(body.indexOf('stopMemoryAlert();') > 0 && body.indexOf('stopMemoryAlert();') < body.indexOf('stopMemoryPause();'), 'stopped inside shutdownSubsystems, before the memory Pause');
  assert.match(s, /import \{ startMemoryAlert, stopMemoryAlert \} from '\.\/memory-alert-host';/);
});

test('WIRING memory-alert.ts is Electron-free (importable under node --test like pause-memory.ts); it writes exactly ONE `escalation` row per LEAD, only from the host, only after marking the episode told', () => {
  const core = read('memory-alert.ts');
  for (const bad of ['./store', './platform', 'electron', './memory-guard', './logger', './admission']) {
    assert.ok(!new RegExp(`from '${bad.replace(/[./]/g, '\\$&')}(\\.ts)?'`).test(core), `memory-alert.ts must not import ${bad}`);
  }
  assert.match(core, /for \(const r of to\) \{\s*try \{\s*send\(db, \{ runId: r\.runId, sender: ALERT_SENDER, recipient: r\.coordinator, kind: 'escalation', body \}\);/);
  assert.ok(core.indexOf('t.sent = true;') > 0 && core.indexOf('t.sent = true;') < core.indexOf('send(db, {'), 'marked told BEFORE the writes: a throw half-way never writes the episode twice');
  assert.match(core, /if \(r\.flags\.delivery !== true\) continue;/, 'a run without the delivery mechanism has nobody who can read a bus row');
  assert.ok(core.indexOf('r.flags.delivery !== true') < core.indexOf('topmostRunIds(db, deps, [...readers.keys()])'), 'readers are filtered BEFORE the topmost is taken');
  assert.equal((core.match(/\bsend\(/g) ?? []).length, 1, 'the ONE send site');
});
