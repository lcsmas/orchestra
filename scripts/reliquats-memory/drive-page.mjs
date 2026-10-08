#!/usr/bin/env node
// #328 rig helper: drives the REAL src/main/resources.ts `sampleResources()` (the Resources page's sampler; only pty/events/statfs/platform stubbed, via scripts/rss-page-size/register-resources-stubs.mjs)
// in a scratch home where a REAL keeper runs in a REAL scope, and prints ONE `PAGE-JSON {…}` line: what the IPC snapshot carries and what the page's own grouping makes of it.
// Env: RIG_REPO (tree under test), WS (the member's workspace id). Run only by scripts/e2e-reliquats-memory.mjs (arm page_snapshot).
import path from 'node:path';

const ROOT = path.resolve(process.env.RIG_REPO);
const WS = process.env.WS;
const home = process.env.ORCHESTRA_HOME;
const realHome = process.env.RIG_REAL_HOME;
if (!home || !realHome || !home.startsWith(path.join(realHome, '.cache') + path.sep)) { console.error(`SAFETY: refusing ORCHESTRA_HOME ${home}`); process.exit(2); }
const { initPlatform } = await import(`${ROOT}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-page-snapshot', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => home, getLogsDir: () => `${home}/logs`, getAppVersion: () => '0.0.0-page-snapshot', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const R = await import(`${ROOT}/src/main/resources.ts`);
const S = await import(`${ROOT}/src/shared/resources.ts`);
globalThis.__PTY = []; // no PTY sessions: the member is keeper-hosted (a `<wsId>:sdk` row)
const snap = await R.sampleResources();
const sdk = snap.sessions.find((s) => s.ptyId === `${WS}:sdk`) ?? null;
const rows = S.groupSessionsByWorkspace(snap.sessions, snap.containers, snap.members).rows;
const row = rows.find((r) => r.key === WS) ?? null;
const view = snap.members?.tracked?.find((m) => m.wsId === WS) ?? null;
console.log(`PAGE-JSON ${JSON.stringify({ hasMembers: !!snap.members, view, sdkMemBytes: sdk?.memBytes ?? null, row: row ? { memBytes: row.memBytes, reliquats: row.reliquats, scopeOnly: row.scopeOnly ?? null } : null, untracked: snap.members?.untracked ?? null })}`);
process.exit(0);
