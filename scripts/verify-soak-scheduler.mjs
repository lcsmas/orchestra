#!/usr/bin/env node
// Driven proof for the soak scheduler (C5 #212): the REAL src/main/soak-scheduler.ts — repo resolution, the identity probe, the spawn, the
// campaign env, the state file, the log lines — over a FAKE campaign script (no bwrap, no `claude`, no sessions), with only the machine reading
// injected. Each arm names the clause it exercises. Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/verify-soak-scheduler.mjs
// Last line: `SOAK-SCHEDULER-RIG: PASS|FAIL` (wrapped by src/main/soak-scheduler.test.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'session-budget-test', 'sched-rig-'));
fs.mkdirSync(path.dirname(TMP), { recursive: true });
const HOME = path.join(TMP, 'orch-home');
const REPO = path.join(TMP, 'repo');
fs.mkdirSync(HOME, { recursive: true });
process.env.ORCHESTRA_HOME = HOME;
// A REAL credential in the app's env must never reach the campaign (zero tokens): plant some and prove they stay behind.
Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-ant-RIG-REAL-KEY', ANTHROPIC_AUTH_TOKEN: 'rig-token', CLAUDE_CODE_OAUTH_TOKEN: 'rig-oauth', GITHUB_TOKEN: 'rig-gh' });
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'rig-live-claude-config'); // a stand-in for the invoker's live dir: passed ONLY so the campaign's scratch guard refuses it
delete process.env.ORCHESTRA_SOAK; delete process.env.ORCHESTRA_SOAK_REPO;

let failures = 0;
const check = (name, cond, detail) => { if (cond) console.log(`  ✓ ${name}`); else { failures++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${detail}` : ''}`); } };

// ── a fake Orchestra checkout with a fake campaign script ────────────────────────────────────────────────────────────────────
fs.mkdirSync(path.join(REPO, 'scripts', 'session-budget'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'package.json'), JSON.stringify({ name: 'orchestra' }));
fs.writeFileSync(path.join(REPO, 'fake-mode.json'), JSON.stringify({ mode: 'pass', codeId: 'id-1', cli: '2.1.999 (Claude Code)' }));
fs.writeFileSync(path.join(REPO, 'scripts', 'session-budget', 'soak-campaign.mjs'), `
import fs from 'node:fs'; import path from 'node:path';
const here = path.dirname(new URL(import.meta.url).pathname); const repo = path.resolve(here, '..', '..');
const mode = JSON.parse(fs.readFileSync(path.join(repo, 'fake-mode.json'), 'utf8'));
const argv = process.argv.slice(2);
if (argv.includes('--identity')) { console.log(JSON.stringify({ codeId: mode.codeId, gitSha: 'abc', cli: mode.cli })); process.exit(0); }
const n = fs.existsSync(path.join(repo, 'invocations.jsonl')) ? fs.readFileSync(path.join(repo, 'invocations.jsonl'), 'utf8').split('\\n').filter(Boolean).length : 0;
fs.appendFileSync(path.join(repo, 'invocations.jsonl'), JSON.stringify({ n, argv, env: process.env, cwd: process.cwd() }) + '\\n');
const out = argv[argv.indexOf('--out-dir') + 1]; fs.mkdirSync(out, { recursive: true });
const rep = path.join(out, 'soak-fake-' + n + '-sched');
const finish = (term, rc, verdicts) => { fs.writeFileSync(rep + '.json', JSON.stringify({ terminator: term, verdicts })); fs.writeFileSync(rep + '.md', term);
  console.log('report: ' + rep + '.json · ' + rep + '.md'); console.log('SOAK-CAMPAIGN: ' + term); process.exit(rc); };
if (mode.mode === 'pass') finish('PASS', 0, []);
if (mode.mode === 'fail') finish('FAIL', 1, [{ id: 'soak.memory.slopeMBPerMin.s3', ok: false, kind: 'budget' }, { id: 'soak.wedge.session.s5', ok: false, kind: 'budget' }, { id: 'soak.wedge.wedgedTurns', ok: true, kind: 'budget' }]);
if (mode.mode === 'hang') { process.on('SIGTERM', () => finish('ABORTED', 4, [])); setTimeout(() => finish('BROKE', 1, []), 60000); }
`);

// ── the app side: fake platform (only what the scheduler reads) + a clock 3 h into the app's life ───────────────────────────────
const { initPlatform } = await import('../src/main/platform/index.ts');
let focused = false, idleSec = 7200;
initPlatform({
  kind: 'headless-soak-rig', broadcast: () => {}, broadcastPtyData: () => true, canBroadcast: () => true, isFocused: () => focused, hasAttachedUi: () => false,
  getSystemIdleSeconds: () => idleSec, notify: () => {}, openExternal: async () => {}, showItemInFolder: () => {}, openPath: async () => '',
  openAccountLoginUrl: () => {}, closeAccountLogin: () => {}, getUserDataDir: () => HOME, getLogsDir: () => path.join(HOME, 'logs'), getAppVersion: () => '0.0.0-rig',
  getAppMetrics: () => [], isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => String(b),
});
const { initLogger } = await import('../src/main/logger.ts');
initLogger();
// Import the modules BEFORE skewing the clock: hibernation-activity stamps `appStartedAt` at load, so the skew below makes the app "3 h old".
const { soakTickWith } = await import('../src/main/soak-scheduler.ts');
const { isSoakRunning } = await import('../src/main/soak-tick.ts');
const realNow = Date.now.bind(Date);
let skewMs = 3 * 3600_000;
Date.now = () => realNow() + skewMs; // the app has been up 3 h; later arms advance it past the identity cache / min-interval
const machine = () => ({ memAvailKB: 20 * 1048576, load1: 3 });
const tick = () => soakTickWith({ machine });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const t0 = realNow(); while (realNow() - t0 < ms) { if (f()) return true; await sleep(100); } return false; };
const state = () => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'soak', 'state.json'), 'utf8')); } catch { return null; } };
const invocations = () => { try { return fs.readFileSync(path.join(REPO, 'invocations.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const logText = () => fs.readFileSync(path.join(HOME, 'logs', 'orchestra.log'), 'utf8');
const setMode = (m) => fs.writeFileSync(path.join(REPO, 'fake-mode.json'), JSON.stringify(m));
const writeConfig = (c) => { fs.mkdirSync(path.join(HOME, 'soak'), { recursive: true }); fs.writeFileSync(path.join(HOME, 'soak', 'config.json'), JSON.stringify(c)); };

// A. nothing to run: no checkout known, a non-Orchestra dir, the env kill switch
console.log('A. disabled / no checkout');
let d = await tick();
check('no configured repo and none registered → skip, nothing spawned', d.run === false && invocations().length === 0, JSON.stringify(d));
writeConfig({ repo: TMP, node: process.execPath }); // TMP has no scripts/session-budget/soak-campaign.mjs
d = await tick();
check('a repo without the campaign script / package name is not an Orchestra checkout → skip', d.run === false && invocations().length === 0, JSON.stringify(d));
writeConfig({ repo: REPO, node: process.execPath });
process.env.ORCHESTRA_SOAK = '0';
d = await tick();
check('ORCHESTRA_SOAK=0 disables it even with a good checkout', d.run === false && d.skip === 'disabled' && invocations().length === 0, JSON.stringify(d));
delete process.env.ORCHESTRA_SOAK;

// B. the real launch: argv, cwd, ENV ALLOWLIST (zero tokens), state, log
console.log('B. a changed, idle, uncovered checkout launches ONE real child (PASS)');
d = await tick();
check('decision = run, 10 sessions on a 20 GB idle machine', d.run === true && d.sessions === 10, JSON.stringify(d));
check('a second tick while it runs starts nothing', (await tick()).run === false || invocations().length <= 1);
check('the child finished and the state recorded a completed PASS for the code it ran', await until(() => state()?.lastCompleted?.terminator === 'PASS'), JSON.stringify(state()));
let inv = invocations();
check('exactly one campaign process was spawned', inv.length === 1, `${inv.length}`);
const a = inv[0];
check('argv is exactly the scheduled campaign', JSON.stringify(a.argv) === JSON.stringify(['--sessions', '10', '--duration', '3600s', '--turn-interval', '30s', '--sample', '30s', '--out-dir', path.join(HOME, 'soak', 'reports'), '--label', 'sched', '--parent-pid', String(process.pid)]), JSON.stringify(a.argv));
check('it runs from the checkout', fs.realpathSync(a.cwd) === fs.realpathSync(REPO), a.cwd);
check('ZERO TOKENS: no API key / token / OAuth / GitHub credential reached the campaign', !JSON.stringify(a.env).includes('sk-ant') && !['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'GITHUB_TOKEN'].some((k) => k in a.env), Object.keys(a.env).join(','));
check('the env is exactly the allowlist (+ ORCHESTRA_HOME / CLAUDE_CONFIG_DIR, passed only for the scratch guard)', JSON.stringify(Object.keys(a.env).sort()) === JSON.stringify(['CLAUDE_CONFIG_DIR', 'HOME', 'LANG', 'ORCHESTRA_HOME', 'PATH', 'TERM']) && a.env.CLAUDE_CONFIG_DIR === process.env.CLAUDE_CONFIG_DIR && a.env.ORCHESTRA_HOME === HOME && a.env.HOME === os.homedir(), Object.keys(a.env).sort().join(','));
check('the state carries the launch-time identity', state().lastCompleted.codeId === 'id-1' && state().lastCompleted.cliVersion === '2.1.999 (Claude Code)', JSON.stringify(state().lastCompleted));
check('start and PASS are INFO lines in the [soak] scope; no WARN', /\[INFO\] \[soak\] starting a 10-session campaign \(60 min, fake API, zero tokens\)/.test(logText()) && /\[INFO\] \[soak\] campaign PASS/.test(logText()) && !/\[WARN\] \[soak\]/.test(logText()));

// C. the change gate, driven through the real identity probe
console.log('C. change gate');
skewMs += 7 * 3600_000; // past the min-interval and the identity cache
check('same code + CLI, 7 h later → NOT run again', (await tick()).run === false && invocations().length === 1);
setMode({ mode: 'fail', codeId: 'id-2', cli: '2.1.999 (Claude Code)' });
skewMs += 6 * 60_000; // past the 5 min identity cache
d = await tick();
check('a code change → runs again', d.run === true && /code changed \(id-1 → id-2\)/.test(d.reason), JSON.stringify(d));

// D. a breach is one WARN line naming the broken budgets and the report
console.log('D. breach');
check('the FAIL run completed and advanced the gate', await until(() => state()?.lastCompleted?.terminator === 'FAIL' && state().lastCompleted.codeId === 'id-2'), JSON.stringify(state()));
const warns = logText().split('\n').filter((l) => /\[WARN\] \[soak\]/.test(l));
check('exactly ONE [soak] WARN, naming both broken budgets (not the passing one) and the report', warns.length === 1 && /campaign BREACH — 2 budget\(s\) broken \(soak\.memory\.slopeMBPerMin\.s3, soak\.wedge\.session\.s5\)/.test(warns[0]) && !/wedgedTurns/.test(warns[0]) && /soak-fake-1-sched\.json/.test(warns[0]), warns.join(' || '));

// E. yield to the user, and an aborted campaign does not advance the gate
console.log('E. yield');
setMode({ mode: 'hang', codeId: 'id-3', cli: '2.1.999 (Claude Code)' });
skewMs += 7 * 3600_000;
d = await tick();
check('a new change launches the (hanging) campaign', d.run === true, JSON.stringify(d));
check('it is running', await until(() => isSoakRunning() && invocations().length === 3), `${invocations().length}`);
focused = true; // the user comes back
await tick();
check('the tick asked it to stop; the child exited ABORTED', await until(() => !isSoakRunning() && state()?.lastAttempt?.outcome === 'aborted'), JSON.stringify(state()));
check('an aborted campaign does NOT advance the gate (lastCompleted still id-2)', state().lastCompleted.codeId === 'id-2', JSON.stringify(state().lastCompleted));
check('the yield is logged', /\[INFO\] \[soak\] campaign yields to the user: the Orchestra window is focused/.test(logText()));
focused = false;

// F. user active at the start: nothing spawned
console.log('F. the user is here');
skewMs += 2 * 3600_000; idleSec = 30;
const before = invocations().length;
d = await tick();
check('user input 30 s ago → skip user-active, nothing spawned', d.run === false && d.skip === 'user-active' && invocations().length === before, JSON.stringify(d));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
console.log(`SOAK-SCHEDULER-RIG: ${failures ? 'FAIL' : 'PASS'}`);
process.exit(failures ? 1 : 0);
