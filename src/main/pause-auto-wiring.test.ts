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
  // #287: `only` = an Admission release re-running ONE held member's nudge — it skips the whole-tick re-evaluation; the ordinary tick (`only` undefined) still evaluates auto-paused runs FIRST.
  assert.match(s, /async function resumeUsageLimited\(now: number, only\?: string\): Promise<void> \{[^}]*?if \(only === undefined\) await evaluatePausedRuns\(\);[^\n]*\n\s*const candidates = store\.workspaces/s);
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

test('WIRING account-usage.ts: a plain refresh ISSUED BEFORE a forced one never replaces the forced reading — by issue sequence, only against forced entries (no forced refresh ⇒ replace-always, as before)', () => {
  const s = read('account-usage.ts');
  assert.match(s, /function setUnlessSuperseded\(id: string, entry: CacheEntry, seq: number\): void \{\s*const prev = cache\.get\(id\);\s*if \(prev && prev\.dir === entry\.dir && prev\.forcedSeq !== undefined && prev\.forcedSeq > seq\) return;\s*cache\.set\(id, entry\);/);
  assert.equal((s.match(/setUnlessSuperseded\(to(Fetch|Probe)\[i\]\.id,/g) ?? []).length, 2);
  assert.equal((s.match(/\.\.\.\(force\.has\(to(Fetch|Probe)\[i\]\.id\) \? \{ forcedSeq: seq \} : \{\}\)/g) ?? []).length, 2);
  assert.match(s, /const seq = \+\+refreshSeq;/);
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

test('WIRING usage.ts: an OLDER-issued poll never replaces a FORCED poll\'s snapshot (issue sequence; forcedSeq stays 0 without a forced poll); the host binds storeReady + resetStreak', () => {
  const u = read('usage.ts');
  assert.match(u, /async function poll\(forced = false\): Promise<void> \{\s*const seq = \+\+pollSeq;/);
  assert.match(u, /if \(seq > forcedSeq\) \{\s*if \(forced\) forcedSeq = seq;\s*lastSnapshot = snapshot;/);
  assert.match(u, /export async function refreshUsageNow\(\): Promise<void> \{\s*await poll\(true\)/);
  const host = read('pause-auto-host.ts');
  assert.match(host, /resetStreak: \(runId\) => void reprises\.delete\(runId\),/);
  assert.match(host, /storeReady: \(\) => store\.loadedFromDisk,/);
});

test('WIRING markers (m1): the host clears a member\'s #74 marker once its `reprise` row was sent — after the Reprises of the tick, before #74\'s candidates; nothing clears at Reprise itself', () => {
  const host = read('pause-auto-host.ts');
  assert.match(host, /\.then\(async \(entries\) => \{\s*await clearRepriseDeliveredMarkers\(realDeps\)/);
  assert.match(host, /clearLimitMarker: \(wsId\) => clearStopReason\(wsId\),/);
  assert.match(host, /limitMarkedWorkspaces: \(\) =>\s*store\.workspaces\.filter\(\(w\) => !w\.archived && w\.lastStopReason === 'usage_limit'\)/);
  assert.match(host, /repriseCursor: \{ get: \(\) => repriseSeq, set: \(seq\) => void \(repriseSeq = seq\) \},/);
  assert.ok(!/clearStopReason|clearLimitMarker/.test(read('pause-auto.ts').replace(/clearLimitMarker: \(wsId: string\) => Promise<void>;|await deps\.clearLimitMarker\(m\.id\);/g, '')), 'the core only clears through clearRepriseDeliveredMarkers');
});

test('WIRING wake guard (M1/N1): the fresh auto Pause needs the frozen wake switch ON in EVERY run of the carrier\'s subtree; a marker is cleared only for a row whose run has wake ON, kind reprise', () => {
  const core = read('pause-auto.ts');
  assert.match(core, /const off = wakeOffAddressees\(db, deps, carrier\);\s*if \(off\.length > 0\) \{\s*if \(deps\.once\(`no-wake:\$\{carrier\}`\)\) deps\.log\.warn\(/);
  assert.match(core, /return 'no-wake';\s*\}/);
  assert.match(core, /if \(getRun\(db, r\.run_id\)\?\.flags\.wake !== true\) continue;/);
  assert.match(core, /FROM messages WHERE sequence > \? AND sequence <= \? AND kind = 'reprise' AND recipient IS NOT NULL/);
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

test('WIRING one enumeration (R3-1): the wake guard asks #255\'s OWN plan — seedRoster and repriseAddressees both read planRoster; the guard reads repriseAddressees minus ghosts, and re-checks at the Reprise', () => {
  const rep = read('pause-reprise.ts');
  assert.match(rep, /for \(const i of planRoster\(db, carrierRunId, pausedAt, subtreeRunIds, extra\)\) \{\s*upsertRosterMember\(/);
  assert.match(rep, /return planRoster\(db, carrierRunId, pausedAt \?\? 0, subtreeRunIds\)\s*\.filter\(\(i\) => i\.role === 'coordinator'\)/);
  const core = read('pause-auto.ts');
  assert.match(core, /return repriseAddressees\(db, carrier, runSubtreeIds\(db, carrier\), pausedAt\)\s*\.filter\(\(a\) => \{\s*const w = deps\.getWorkspace\(a\.wsId\);\s*return !!w && !w\.archived;\s*\}\)\s*\.filter\(\(a\) => getRun\(db, a\.runId\)\?\.flags\.wake !== true\);/);
  assert.match(core, /const off = wakeOffAddressees\(db, deps, run\.runId, run\.pausedAt\);\s*if \(off\.length > 0\) \{[\s\S]*?escalateNoWake\(db, deps, run, cur\.pauseAuto, off\);[\s\S]*?why: 'no-wake-addressee'/);
  assert.ok(!/runSubtreeIds\(db, carrier\)\.some/.test(core), 'no second (bus-only) enumeration');
  assert.match(read('pause-auto-host.ts'), /once: \(key\) => \(onceKeys\.has\(key\) \? false : \(onceKeys\.add\(key\), true\)\),/);
});

test('WIRING hold (R4): the escalation + the `pause_auto.held` record are ONE transaction (no latch before the write); the target walks ancestors only; `run status` reads the hold through the CLI dep', () => {
  const core = read('pause-auto.ts');
  assert.match(core, /db\.transaction\(\(\) => \{\s*if \(target\.kind === 'coordinator'\) send\(db, \{ runId: target\.runId, sender: 'host', recipient: target\.coordinator, kind: 'escalation', body \}\);\s*else openGate\(db, run\.runId, target\.asker, body, HUMAN_GATE_RECIPIENT\);/);
  assert.match(core, /if \(upd\.changes !== 1\) throw new Error\('the auto pause changed meanwhile'\);/);
  assert.match(core, /for \(const id of ancestors\) \{/);
  assert.ok(!/deps\.once\(`no-wake-reprise/.test(core), 'no in-memory latch for the hold');
  assert.match(read('../cli/index.ts'), /autoHeld: \(d, id\) => \{\s*const r = d\.prepare\('SELECT paused_at, pause_auto FROM runs WHERE id = \?'\)/);
  assert.match(read('../cli/run-status.ts'), /const held = pause && deps\.autoHeld \? deps\.autoHeld\(db, pause\.runId\) : null;/);
});
