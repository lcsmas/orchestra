// #438-fu (reviewer MINOR 3) — BEHAVIOURAL arm of the #199 clause: the REAL `applyAgentEvent` (activity.ts, the funnel every lifecycle event crosses) is driven with a
// spool where a Bash `pretool` is stranded (its `posttool` + the turn's `stop` lost) and a NEW turn then starts (`submit`): the in-flight list the liveness roster reads MUST be empty afterwards.
//   node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/pause-canary/submit-clear-behaviour.mjs   → prints `SUBMIT-CLEAR CLEAN|DIRTY`
// Positive control in the same run: BEFORE the submit the list holds the stranded call (the instrument sees a non-empty list). A mutant that drops the clear from the shipped arm goes DIRTY (liveness-small-runs.mjs).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'submit-clear-'));
process.env.ORCHESTRA_HOME = home;
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-submit-clear', broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => home, getLogsDir: () => `${home}/logs`, getAppVersion: () => '0.0.0-submit-clear', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
const { applyAgentEvent } = await import(`${REPO}/src/main/activity.ts`);
const { getInFlightTools } = await import(`${REPO}/src/main/hibernation-activity.ts`);
const WS = 'ws-submit-clear-behaviour';
let verdict = 'DIRTY', detail = '';
try {
  applyAgentEvent(WS, 'submit', undefined);                                  // turn A begins
  applyAgentEvent(WS, 'pretool', 'Bash', undefined, undefined, 'toolu_stranded');   // a Bash starts … its posttool and the turn's stop are LOST
  const before = getInFlightTools(WS).map((t) => t.tool);
  applyAgentEvent(WS, 'submit', undefined);                                  // turn B begins (a coalesced wake): the boundary must clear the phantom
  const after = getInFlightTools(WS).map((t) => t.tool);
  const armed = before.length === 1 && before[0] === 'Bash';
  verdict = armed && after.length === 0 ? 'CLEAN' : 'DIRTY';
  detail = `in-flight before the new turn: [${before}] (positive control: must hold the stranded Bash) · after: [${after}] (must be empty)`;
} catch (e) { detail = `ERROR ${String(e?.stack ?? e).slice(0, 400)}`; }
fs.rmSync(home, { recursive: true, force: true });
console.log(`SUBMIT-CLEAR ${verdict} — ${detail}`);
process.exit(0);
