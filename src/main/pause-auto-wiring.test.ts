import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #256 — structural pins of the Electron-bound seams (they cannot be imported under node --test). A silent un-wiring is a feature that is dead
// while every logic test stays green: the observer, the tick, the migrate / login hooks, the forced-refresh seam.

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Source with line-leading block comments and full-line `//` comments removed: a call that was merely COMMENTED OUT must not satisfy a pin. */
const read = (f: string): string => fs.readFileSync(path.join(HERE, f), 'utf8').replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/.*$/gm, '');

test('WIRING activity.ts: a recorded limit stop notifies the observer — except #74\'s own failed-wake re-mark', () => {
  const s = read('activity.ts');
  assert.match(s, /export function setUsageLimitStopObserver\(/);
  assert.match(s, /opts: \{ remark\?: boolean \} = \{\}/);
  assert.match(s, /if \(!opts\.remark\) \{\s*try \{\s*usageLimitStopObserver\?\.\(id\);/);
});

test('WIRING prompt-queue.ts: the tick evaluates auto-paused runs FIRST, the compensator re-marks silently, the flusher registers/unregisters the observer, TICK_MS = 20 s', () => {
  const s = read('prompt-queue.ts');
  assert.match(s, /async function resumeUsageLimited\(now: number\): Promise<void> \{[^}]*?await evaluatePausedRuns\(\);\s*const candidates = store\.workspaces/s);
  assert.match(s, /markStoppedOnUsageLimit\(ws\.id, ws\.usageLimitResetsAt \?\? null, \{ remark: true \}\)/);
  assert.match(s, /export function startPromptQueueFlusher\(\): void \{\s*if \(timer\) return;\s*startPauseAuto\(\);/);
  assert.match(s, /export function stopPromptQueueFlusher\(\): void \{\s*stopPauseAuto\(\);/);
  assert.match(s, /const TICK_MS = 20_000;/, 'the rig\'s "one poll tick" is this constant');
  assert.match(s, /usageForAccount\(resolveWorkspaceAccountId\(ws\.accountId, knownIds\)\)/, 'ONE shared usage read for #74 and the Reprise');
});

test('WIRING workspaces.ts: the account migration tells pause-auto AFTER the re-pin', () => {
  const s = read('workspaces.ts');
  const i = s.indexOf('export async function dispatchMigrateAccountRequest(');
  const body = s.slice(i, i + 9000);
  assert.ok(body.indexOf('await store.upsertWorkspace(updated);') >= 0 && body.indexOf('void pauseAutoOnMigrate(id);') > body.indexOf('await store.upsertWorkspace(updated);'));
  assert.match(s, /import \{ pauseAutoOnMigrate \} from '\.\/pause-auto-host';/);
});

test('WIRING api-handlers.ts: a completed re-login tells pause-auto (forced fresh reading + immediate re-evaluation)', () => {
  const s = read('api-handlers.ts');
  assert.match(s, /armLoginWatch\(account, \(\) => \{[\s\S]*?void refreshAccountsNow\(\);[\s\S]*?void pauseAutoOnLogin\(accountId\);\s*\}\);/);
  assert.match(s, /import \{ pauseAutoOnLogin \} from '\.\/pause-auto-host';/);
});

test('WIRING account-usage.ts: an OLDER overlapping fetch never replaces a newer reading of the same dir (both write sites)', () => {
  const s = read('account-usage.ts');
  assert.match(s, /function setIfNewer\(id: string, entry: CacheEntry\): void \{\s*const prev = cache\.get\(id\);\s*if \(prev && prev\.dir === entry\.dir && prev\.status\.fetchedAt > entry\.status\.fetchedAt\) return;\s*cache\.set\(id, entry\);/);
  assert.equal((s.match(/setIfNewer\(to(Fetch|Probe)\[i\]\.id,/g) ?? []).length, 2);
});

test('WIRING account-usage.ts: `force` bypasses the 180 s cache for BOTH the OAuth and the API-key branch, and refreshAccountsNow passes it', () => {
  const s = read('account-usage.ts');
  assert.equal((s.match(/&& !force\.has\(acc\.id\)/g) ?? []).length, 2);
  assert.match(s, /export async function refreshAccountsNow\(opts: \{ force\?: readonly string\[\] \} = \{\}\)/);
  assert.match(s, /refreshStale\(Date\.now\(\), new Set\(opts\.force \?\? \[\]\)\)/);
  assert.match(read('usage.ts'), /export async function refreshUsageNow\(\)/);
});

test('WIRING api-handlers.ts: a replaced API key / base URL is a new credential too (forced fresh reading for the paused runs waiting on it)', () => {
  const s = read('api-handlers.ts');
  assert.match(s, /saveAccountApiKey: async \(accountId, key\) => \{\s*await setAccountApiKey\(accountId, key\);\s*void refreshAccountsNow\(\);\s*void pauseAutoOnLogin\(accountId\);/);
  assert.match(s, /saveAccountBaseUrl: async \(accountId, url\) => \{\s*await setAccountBaseUrl\(accountId, url\);\s*void refreshAccountsNow\(\);\s*void pauseAutoOnLogin\(accountId\);/);
});

test('WIRING usage.ts: an OLDER overlapping default-login fetch never replaces a newer snapshot; the host binds storeReady + resetStreak', () => {
  assert.match(read('usage.ts'), /if \(!lastSnapshot \|\| snapshot\.fetchedAt >= lastSnapshot\.fetchedAt\) \{\s*lastSnapshot = snapshot;/);
  const host = read('pause-auto-host.ts');
  assert.match(host, /resetStreak: \(runId\) => void reprises\.delete\(runId\),\s*storeReady: \(\) => store\.loadedFromDisk,/);
});

test('WIRING #74\'s markers are LEFT by a Reprise: nothing in the host binding clears a usage_limit marker', () => {
  assert.ok(!/clearStopReason|clearLimitMarker/.test(read('pause-auto-host.ts')) && !/clearLimitMarker|clearStopReason/.test(read('pause-auto.ts')));
});

test('WIRING #255: the host binds the REAL beginReprise, the carrier lookup includes a RELEASED member, and a human re-assert adopts an auto pause', () => {
  const host = read('pause-auto-host.ts');
  assert.match(host, /import \{ beginReprise \} from '\.\/bus-pause\.ts';/);
  assert.match(host, /const realDeps: PauseAutoDeps = \{[\s\S]*?\n  beginReprise,\n/);
  assert.ok(!/stubBeginReprise/.test(read('pause-auto.ts')) && !/stubBeginReprise/.test(host));
  assert.match(read('pause-auto.ts'), /pausedCarrierForWorkspace\(db, ws, deps\.getWorkspace, \{ includeReleased: true \}\)/);
  assert.match(read('bus-pause.ts'), /return 'escalated';\s*\}\s*db\.prepare\('UPDATE runs SET pause_auto = NULL WHERE id = \? AND paused_at IS NOT NULL'\)\.run\(runId\);\s*return 'already-paused';/);
  assert.match(read('bus-pause.ts'), /if \(wrote\.changes === 0\) \{\s*db\.prepare\('UPDATE runs SET pause_auto = NULL WHERE id = \? AND paused_at IS NOT NULL'\)\.run\(runId\);\s*return 'already-paused';/);
});

test('WIRING pause-auto.ts is Electron-free (importable under node --test like bus-pause.ts); the host binding holds the real store / pollers', () => {
  const core = read('pause-auto.ts');
  for (const bad of ['./store', './platform', 'electron', './account-usage', './usage', './activity', './logger']) {
    assert.ok(!new RegExp(`from '${bad.replace(/[./]/g, '\\$&')}(\\.ts)?'`).test(core), `pause-auto.ts must not import ${bad}`);
  }
  const host = read('pause-auto-host.ts');
  for (const need of ["from './store.ts'", "from './bus.ts'", "from './account-usage.ts'", "from './usage.ts'", "from './activity.ts'"]) assert.ok(host.includes(need), need);
  assert.match(host, /forceRefresh: async \(ids\) => \{/);
});
