// #326 — source-wiring gate: hibernation.ts / index.ts / the host cannot be loaded under `node --test` (store / pty / Electron), so the WIRING of Veille-and-Reliquats is asserted on the shipped source.
// The behaviour behind it is driven for real — real sweeper, stub CLI, real orphan processes in a fake scope — by scripts/e2e-hibernate-wake.mjs `reliquat_*`. Each arm names the clause it protects
// (in-place mutants: scripts/veille-reliquats-mutants.list.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (f: string): string => fs.readFileSync(path.join(here, f), 'utf8');
const live = (src: string, needle: string): boolean => src.split('\n').some((l) => l.includes(needle) && !l.trimStart().startsWith('//') && !l.trimStart().startsWith('*'));
const fnBody = (src: string, head: string): string => {
  const from = src.indexOf(head);
  assert.ok(from >= 0, `control: found ${head}`);
  return src.slice(from, src.indexOf('\n}\n', from));
};

test('the app registers the production Reliquat port BEFORE the first sweep (a sweep without a port is today\'s Veille)', () => {
  const index = read('index.ts');
  assert.ok(live(index, '  setVeilleReliquatPort(productionVeilleReliquatPort());'));
  assert.ok(index.indexOf('setVeilleReliquatPort(productionVeilleReliquatPort())') < index.indexOf('  startHibernationSweeper();'), 'registered first, then the sweeper starts');
  assert.ok(live(index, "import { productionVeilleReliquatPort } from './veille-reliquats-host.ts';"));
});

test('the sweep reads the Reliquat wait from the Garde mémoire store AT EVERY PASS (hot) — not a module constant — and the pure rule decides (judgeVeille → shouldHibernate)', () => {
  const hib = read('hibernation.ts');
  const sweep = fnBody(hib, 'export async function sweepHibernation()');
  assert.match(sweep, /const reliquatDelayMs = store\.getMemoryGuardSettings\(\)\.reliquatWaitMin \* 60_000;/);
  assert.match(sweep, /verdict = await judgeVeille\(ws, signals, \{\s*port: veillePort,\s*strip: stripControl,/, 'the registered port IS what the verdict consults');
  assert.ok(sweep.indexOf('store.getMemoryGuardSettings()') < sweep.indexOf('for (const ws of store.workspaces)'), 'read once per pass, before the loop');
  assert.doesNotMatch(hib, /^const .*RELIQUAT.*= /m, 'no cached copy of the setting at module level');
  const judge = read('veille-reliquats.ts');
  assert.match(judge, /shouldHibernate\(ws, \{ \.\.\.signals, liveReliquats: 0 \}\)/);
  assert.doesNotMatch(judge, /\b(30|45|60) \* 60|MIN_RELIQUAT|DEFAULT_RELIQUAT/, 'the judge holds no threshold of its own');
});

test('the stop and the census reuse the Pause\'s pieces: killReliquats / judgeReliquat / memberScopeDeps over a scope read through memberScopes — no hard-coded cgroup path, no raw signal', () => {
  const port = read('veille-reliquats-port.ts');
  assert.ok(live(port, "import { killReliquats } from './pause-reliquats.ts';"));
  assert.ok(live(port, "import { memberScopeDeps } from './pause-reliquats-scope.ts';"));
  assert.match(port, /judgeReliquat\(m\.pid, m\.startTicks, scope, listing, protect, kill\.read\)\.ok/);
  assert.match(port, /await killReliquats\(wsId, deps, kill, \{ keeperPid, cliPid, startedBeforeMs, \.\.\.\(ctx\?\.stillWanted \? \{ stillPaused: ctx\.stillWanted \} : \{\}\), \.\.\.\(ctx\?\.stillWantedAfterSignal \? \{ stillPausedAfterSignal: ctx\.stillWantedAfterSignal \} : \{\}\) \}\)/);
  assert.doesNotMatch(port, /process\.kill\(|\/sys\/fs\/cgroup|\.signal\(/, 'the port never signals anything itself');
  assert.match(port, /if \(scopes\.length === 0\) return countBrowsers\(wsId\);/, 'browsers only for a member with NO tracked scope (R10)');
  assert.match(port, /if \(scopes\.length === 0\) return stopBrowsers\(wsId, ctx\);/, 'and the scope-less stop never needs the keeper / CLI identity');
  assert.match(port, /return scoped \?\? stopBrowsers\(wsId, ctx\);/);
});

test('the production host: the notice goes to the member\'s INBOX (never a bus row — that would wake it out of its Veille), the browser stop ignores the idle window, the session identity is the Pause\'s', () => {
  const host = read('veille-reliquats-host.ts');
  assert.ok(live(host, "import { appendInboxBlock } from './inbox-write.ts';"));
  assert.ok(live(host, "import { cliOfMember } from './pause-trap-host.ts';"));
  assert.doesNotMatch(host, /from '\.\/bus(\.ts|')|busSend|\bsend\(/, 'no bus import: a status row wakes its recipient');
  assert.match(host, /stopBrowsers: \(wsId, ctx\) => stopBrowserReliquatsOf\(wsId, \{ ignoreWindow: true, \.\.\.\(ctx\?\.stillWanted \? \{ stillWanted: ctx\.stillWanted \} : \{\}\), \.\.\.\(ctx\?\.stillWantedAfterSignal \? \{ stillWantedAfterSignal: ctx\.stillWantedAfterSignal \} : \{\}\) \}\)/);
  assert.match(host, /cliOf: cliOfMember,/);
  const th = read('pause-trap-host.ts');
  assert.match(th, /export async function cliOfMember\(m: \{ wsId: string \}\)/);
  assert.match(th, /cliOf: \(m\) => cliOfMember\(m\),/, 'the Pause trap and the Veille resolve the member\'s session through ONE function');
});

test('the browser census and the monitor\'s pass select a browser Reliquat through the SAME scan (they can never disagree on what one is)', () => {
  const br = read('browser-reliquats.ts');
  assert.equal((br.match(/scanOrphan\(/g) ?? []).length, 3, 'defined once, used by browserPass and by browserOrphansOf');
  const rm = read('resource-monitor.ts');
  assert.match(rm, /export async function countBrowserReliquatsOf\(/);
  assert.match(rm, /return browserOrphansOf\(b\.deps, await \(table \? table\(\) : censusProcTable\(\)\), wsId\)\.filter\(\(o\) => o\.client === 'no'\)\.length;/, 'only what a pass would STOP counts: a connected client spares it');
});

test('the Reliquat wait is a Garde mémoire setting with its own normalisation (#323 owns the UI, not this ticket)', () => {
  const g = read('../shared/memory-guard.ts');
  assert.match(g, /reliquatWaitMin: number;/);
  assert.match(g, /DEFAULT_RELIQUAT_WAIT_MIN = 30/);
  assert.match(g, /patch\.reliquatWaitMin \?\? current\.reliquatWaitMin/);
  assert.doesNotMatch(read('../renderer/components/ResourcesView.tsx'), /reliquatWaitMin/, 'no renderer change in #326 (D4)');
});

test('the Consigne and the Veille notice list killed Reliquats through ONE renderer (reliquatKilledItemLines)', () => {
  const pr = read('../shared/pause-reliquats.ts');
  assert.match(pr, /export function reliquatKilledItemLines\(/);
  assert.match(pr, /out\.push\(\.\.\.reliquatKilledItemLines\(done, n, strip\)\);/);
  assert.match(read('../shared/veille-reliquats.ts'), /\.\.\.reliquatKilledItemLines\(done, n, strip, 'see the Orchestra log'\)/);
});

test('the sweep marks a member BUSY before its verdict and drops the mark in a finally; a wake / delete during the verdict drops the Veille; a stop is re-judged on FRESH state', () => {
  const sweep = fnBody(read('hibernation.ts'), 'export async function sweepHibernation()');
  assert.ok(sweep.indexOf('veilleBusy.add(ws.id);') > sweep.indexOf('if (veilleBusy.has(ws.id)) continue;') && sweep.indexOf('veilleBusy.add(ws.id);') < sweep.indexOf('judgeVeille(ws, signals,'), 'checked, marked, THEN judged');
  assert.match(sweep, /if \(\(wakeEpoch\.get\(ws\.id\) \?\? 0\) !== epochBefore \|\| isBeingDeleted\(ws\.id\)\) \{/);
  assert.ok(sweep.indexOf('const epochBefore = wakeEpoch.get(ws.id) ?? 0;') < sweep.indexOf('judgeVeille(ws, signals,'), 'the wake epoch is snapshotted BEFORE the verdict awaits');
  assert.match(sweep, /decided again on FRESH state, WHATEVER the verdict awaited[^]*?const again = judgedFresh\(0\);[^]*?if \(!again\) \{/);
  // #326-fu m1: ONE fresh judgement serves the post-verdict re-check AND the stop itself (before the first signal and before every signal round, through `stillEligible`)
  const fresh = sweep.slice(sweep.indexOf('const judgedFresh = (liveReliquats: number, heldNow: boolean = isAdmissionHolding(getMemoryGuardSnapshot())): boolean => {'), sweep.indexOf('let verdict: Awaited<ReturnType<typeof judgeVeille>>;'));
  assert.ok(fresh.length > 100, 'judgedFresh is defined before the verdict is awaited');
  for (const re of [/\(liveReliquats === 0 \|\| isFleetMember\(fresh\)\) &&/, /hasLivePty: isRunning\(ws\.id\),/, /hasLiveRunPty: isRunning\(`\$\{ws\.id\}:run`\),/, /hasLiveBackgroundTask: sdkHasBackgroundTasks\(ws\.id\),/, /now: Date\.now\(\),/, /store\.getWorkspace\(ws\.id\)/, /lastActivityAt: idleClockOf\(fresh\),/, /monotonicIdleMs: monotonicIdleOf\(ws\.id\),/, /isActive: getActiveWorkspaceId\(\) === ws\.id,/, /hasLiveSdk: sdkSessionLive\(ws\.id\),/, /heldNow: boolean = isAdmissionHolding\(getMemoryGuardSnapshot\(\)\)/, /admissionHeld: heldNow,/, /^\s*liveReliquats,$/m]) assert.match(fresh, re, String(re));
  assert.match(sweep, /stillEligible: \(n\) => judgedFresh\(n\),/, 'the stop is handed the fresh judgement');
  assert.match(sweep, /stillEligibleAfterSignal: \(n\) => judgedFresh\(n, signals\.admissionHeld\),/, 'once a signal is out the hold is what it was when the verdict began (F2, R10)');
  assert.match(sweep, /thresholdMs,\s*\n\s*monotonicIdleMs: monotonicIdleOf\(ws\.id\),\s*\n\s*admissionHeld,/, 'the monotonic idle time is a signal of every member\'s verdict (#326-fu m2)');
  assert.doesNotMatch(sweep, /if \(verdict\.stopped\) \{/, 'the re-check is not conditional on a stop: a census awaits too');
  assert.match(sweep, /stillWanted: \(\) => \(wakeEpoch\.get\(ws\.id\) \?\? 0\) === epochBefore && !isBeingDeleted\(ws\.id\),/, 'the stop is told when the member woke / is being deleted');
  assert.match(sweep, /const liveSdkNow = sdkSessionLive\(ws\.id\);\s*const livePtyNow = isRunning\(ws\.id\);\s*if \(!liveSdkNow && !livePtyNow\) continue;/, 'liveness read AGAIN after the verdict');
});

test('the #288 mutant gate derives its baseline rig-arm count from the rig\'s own ARMS — a hard-coded number aborted the whole gate the day the rig gained arms (#326-fu review F1)', () => {
  const scripts = path.join(here, '..', '..', 'scripts');
  const gate = fs.readFileSync(path.join(scripts, 'fast-veille-mutants.mjs'), 'utf8');
  const rig = fs.readFileSync(path.join(scripts, 'e2e-fast-veille.mjs'), 'utf8');
  assert.doesNotMatch(gate, /baseRig\.pass !== \d+/, 'no literal arm count');
  assert.ok(gate.includes("const RIG_ARM_COUNT = (/const ARMS = \\[([^\\]]*)\\]/.exec(fs.readFileSync(path.join(HERE, 'e2e-fast-veille.mjs'), 'utf8'))?.[1].match(/'[^']+'/g) ?? []).length;"), 'derived from the rig');
  assert.ok(gate.includes('baseRig.pass !== RIG_ARM_COUNT || baseRig.total !== RIG_ARM_COUNT'), 'every declared arm must pass AND be counted');
  const declared = (/const ARMS = \[([^\]]*)\]/.exec(rig)?.[1].match(/'[^']+'/g) ?? []).length;
  assert.ok(declared >= 23, `the rig declares its arms in one literal (${declared} found; the three #326-fu arms included)`);
});
