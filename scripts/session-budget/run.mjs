#!/usr/bin/env node
// Session-budget suite driver (#208):  node scripts/session-budget/run.mjs [--arm <name>|all] [--json]
//
// Session arms (each = a fresh process: REAL agent-sdk.ts session path → real keeper → real `claude` CLI, in a
// generated heavy fixture, against the LOCAL FAKE Anthropic API — zero tokens, D6 — inside net+pid namespaces,
// with PRODUCTION env: none of the CLI's traffic-disabling knobs):
//   normal             shipped code; MUST PASS every budget in src/shared/session-budget.ts.
//   boot-context-read  the shipped code with the #176 boot-time getContextUsage() re-added at load time
//                      (mutants.mjs); MUST FAIL naming session.beforeFirstReply.countTokensRequests with a
//                      large burst — the proof the suite can see the defect it exists for.
// #210 (child processes / memory / zero survivors after delete) — EVERY session arm also judges the process+memory budgets
// (SESSION_BUDGETS.processes); these arms tear the session down through the REAL delete path (delete-teardown.mjs):
//   delete-cli / delete-ui                     the socket route / the renderer IPC handler; MUST PASS (zero survivors).
//   procs-extra-child, mem-keeper-ballast      keeper-bundle mutants: a helper process / 300 MB; MUST FAIL naming the tree.
//   delete-cli-skips-stop, …-skips-tree-sweep,
//   delete-ui-skips-stop                        source mutants of the delete path; MUST FAIL naming the survivors.
//   delete-cli-wake-race                       a wake fired mid-delete must be REFUSED by the launch tombstone (MUST PASS + saw the
//                                              refusal); …-no-tombstone relaunches a NEW tree (MUST FAIL); delete-cli-late-relaunch
//                                              (a process 1.5 s after the sweep) and delete-cli-hangs (the stop never returns) MUST FAIL.
// Self-test arms (host-dependent checks of the instruments themselves, kept out of `pnpm run test`):
//   slow-startup         a slow MCP server delays the main request ~3 s (refused startup calls get retried): MUST PASS.
//   traffic-knob-in-env  a buildSdkEnv edit hands the CLI DISABLE_TELEMETRY: MUST be VOID naming instrument.productionEnv
//                        (judged from the CLI's /proc environ, not the runner's own env).
//   app-egress-new-host  an ensureSession edit fetch()es a new host: MUST FAIL naming that host in startupEgressAttempts
//                        (the app process's traffic goes through the recording proxy too).
//   census-selftest    the pid-namespace census is exactly the runner's tree.
//   smoke-flag-path    the optional real-API smoke's flag path, real CLI vs the fake API.
// Exit: 0 all arms as expected · 1 an arm broke expectation or the run raised · 3 an arm was VOID (nothing measured:
// the subject never mounted, or egress could not be contained).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBuilt, runSessionArm, runSelfTest, detectContainment } from './harness.mjs';
import fs from 'node:fs';
import { formatRequestSummary, sessionBudgetTerminator } from '../../src/shared/session-budget.ts';
import { PROCS_ARMS, judgeProcsArm, passArmProblems } from './procs-arms.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const JSON_OUT = args.includes('--json');
const WANT = opt('arm', 'all');

/** `minBurst` is a LITERAL (the fixture carries 50 rules): a must-FAIL that broke on 1 count_tokens would not prove "large". */
const ARMS = {
  normal: { kind: 'session', mutant: null, expect: 'pass' },
  'boot-context-read': { kind: 'session', mutant: 'boot-context-read', expect: 'fail', mustBreak: 'session.beforeFirstReply.countTokensRequests', minBurst: 50 },
  // A slow-but-healthy startup (a slow MCP server, as npx-launched ones are): the main request waits ~3 s and the CLI retries a refused call once. MUST PASS.
  'slow-startup': { kind: 'session', mutant: null, expect: 'pass', profile: { mcpInitDelayMs: 1200 }, mustExercise: { host: 'api.anthropic.com:443', min: 4 } },
  'traffic-knob-in-env': { kind: 'session', mutant: 'traffic-knob-in-sdk-env', expect: 'void', mustVoid: 'instrument.productionEnv', mustName: 'DISABLE_TELEMETRY' },
  'app-egress-new-host': { kind: 'session', mutant: 'app-fetch-new-host', expect: 'fail', mustBreak: 'session.beforeFirstReply.startupEgressAttempts.telemetry.example.invalid:443', minBurst: 1 },
  ...PROCS_ARMS,
  'census-selftest': { kind: 'selftest', mode: 'census' },
  'smoke-flag-path': { kind: 'selftest', mode: 'smoke' },
};
if (WANT !== 'all' && !ARMS[WANT]) { console.error(`unknown arm: ${WANT} (have: ${Object.keys(ARMS).join(', ')})`); process.exit(2); }

const say = (s = '') => { if (!JSON_OUT) console.log(s); };
// SESSION_BUDGET_SKIP_BUILD=1: use the prebuilt dist-electron/keeper.js. The unit test that drives this file must not rebuild it
// while src/keeper/keeper.test.ts runs in parallel and spawns that same file (a build briefly leaves it 0 bytes).
const KEEPER = path.join(REPO, 'dist-electron', 'keeper.js');
const build = process.env.SESSION_BUDGET_SKIP_BUILD === '1' && fs.existsSync(KEEPER)
  ? { path: KEEPER, mtimeMs: fs.statSync(KEEPER).mtimeMs }
  : process.env.SESSION_BUDGET_SKIP_BUILD === '1' ? { path: KEEPER, mtimeMs: 0 } : ensureBuilt(REPO);
const containment = detectContainment();
say(`session-budget: keeper bundle rebuilt (${new Date(build.mtimeMs).toISOString()}) · containment=${containment.name}${process.env.SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT === '1' ? ' (WEAK containment explicitly allowed by SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT=1)' : ''}`);

let bad = 0, voided = 0;
for (const [name, spec] of Object.entries(ARMS)) {
  if (WANT !== 'all' && WANT !== name) continue;
  if (spec.kind === 'selftest' && containment.name !== 'netns+pidns' && process.env.SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT === '1') {
    // Explicit weak-containment opt-out: these instrument checks need net+pid namespaces, so they are SKIPPED — loudly, never counted as a pass.
    console.log(JSON_OUT ? JSON.stringify({ arm: name, skipped: true }) : `== arm ${name}: SKIPPED — needs net+pid namespaces (weak containment explicitly allowed; the instrument is unchecked on this host)`);
    continue;
  }
  const res = spec.kind === 'selftest'
    ? await runSelfTest({ repo: REPO, mode: spec.mode, containment })
    : await runSessionArm({ repo: REPO, arm: name, mutant: spec.mutant, profile: spec.profile, teardown: spec.teardown, deleteOpts: spec.deleteOpts, containment });
  if (res.reaped) say(`   (reaped ${res.reaped} leftover scratch process(es) — containment ${containment.name} did not contain the keeper)`);
  if (res.void) { voided++; console.log(JSON_OUT ? JSON.stringify({ arm: name, void: true, error: res.error }) : `== arm ${name}: VOID — ${res.error}`); continue; }

  if (spec.kind === 'selftest') {
    const ok = !res.error && res.ok === true;
    if (!ok) bad++;
    if (JSON_OUT) { console.log(JSON.stringify({ arm: name, ok, ...res })); continue; }
    say(`== arm ${name} (self-test): ${ok ? 'AS EXPECTED' : 'UNEXPECTED'} — ${ok ? JSON.stringify({ ...res, selftest: undefined, ok: undefined, root: undefined, rc: undefined, reaped: undefined }) : (res.why ?? res.error)}`);
    continue;
  }

  // F4: a run that raised (setup/teardown/agent error, harness failure) is RUN BROKE — never a pass, whatever the counts say.
  const runError = res.error ?? res.report?.error;
  if (runError || !res.report) {
    bad++; console.log(JSON_OUT ? JSON.stringify({ arm: name, ok: false, error: runError }) : `== arm ${name}: RUN BROKE — ${runError}\n   scratch kept at ${res.root}`);
    continue;
  }
  const { report, judgement } = res;
  const broke = judgement.verdicts.filter((v) => v.kind === 'budget' && !v.ok);
  let asExpected;
  let why = '';
  if (spec.expect === 'void') {
    // A must-VOID arm: the run is EXPECTED to be judged VOID, by the named instrument, naming the named knob.
    const named = judgement.verdicts.find((v) => v.kind === 'instrument' && !v.ok && v.id === spec.mustVoid && v.message.includes(spec.mustName));
    asExpected = judgement.void && !!named;
    why = named ? named.message : `expected ${spec.mustVoid} to VOID naming ${spec.mustName} but it did not (void=${judgement.void})`;
  } else if (judgement.void) { asExpected = false; why = `VOID — ${judgement.verdicts.filter((v) => v.kind === 'instrument' && !v.ok).map((v) => v.message).join(' | ')}`; voided++; }
  else if (spec.expect === 'pass') {
    asExpected = judgement.ok; why = judgement.ok ? 'every budget held' : broke.map((v) => v.message).join(' | ');
    // Positive control: a slow-but-healthy arm that never saw the retry proves nothing about the allowance it exists to protect.
    const seen = report.startupEgress?.[spec.mustExercise?.host] ?? 0;
    if (asExpected && spec.mustExercise && seen < spec.mustExercise.min) { asExpected = false; why = `held, but the arm did not exercise the retry path (saw ${seen} startup attempts at ${spec.mustExercise.host}, need ≥ ${spec.mustExercise.min}) — it proves nothing`; }
    { const pr = asExpected ? passArmProblems(spec, report) : null; if (pr) { asExpected = false; why = pr; } } // #210 positive controls
  }
  else if (spec.checks) {
    // #210 must-FAIL arms: named budgets, literal actuals, named tree text, and the budgets that must stay green.
    const r = judgeProcsArm(spec, judgement);
    asExpected = r.ok;
    why = r.why;
  }
  else {
    const named = broke.find((v) => v.id === spec.mustBreak);
    asExpected = !!named && (named.actual ?? 0) >= spec.minBurst;
    why = named ? named.message : `expected ${spec.mustBreak} to break but it held`;
    if (named && !asExpected) why += ` — burst below ${spec.minBurst}, not the large #176 shape`;
  }
  if (!asExpected && (spec.expect === 'void' || !judgement.void)) bad++;
  if (JSON_OUT) { console.log(JSON.stringify({ arm: name, expect: spec.expect, asExpected, why, report, judgement })); continue; }
  const p = report.processes;
  say(`== arm ${name} (expect ${spec.expect.toUpperCase()}): ${asExpected ? 'AS EXPECTED' : 'UNEXPECTED'} — ${why}`);
  for (const l of formatRequestSummary(report)) say(`   ${l}`);
  const side = report.requestLog?.filter((r) => r.type === 'model' && !(r.tools > 0)) ?? [];
  for (const r of side) say(`   side call @${r.tMs} ms: ${r.model} (tools-less) — "${r.preview ?? ''}"`);
  say(`   time to first reply: ${report.timing.timeToFirstReplyMs} ms after sdkSend (incl. ${report.timing.fakeModelLatencyMs} ms fake model latency; runner setup ${report.timing.setupMs} ms not counted)`);
  say(`   child processes at first reply: ${p.atFirstReply.total} (cli=${p.atFirstReply.byKind.cli} keeper=${p.atFirstReply.byKind.keeper} mcp=${p.atFirstReply.byKind.mcp} hook=${p.atFirstReply.byKind.hook} other=${p.atFirstReply.byKind.other}) · mem ${Math.round((p.atFirstReply.rssKB + (p.atFirstReply.swapKB ?? 0)) / 1024)} MB (RSS+swap) · after teardown: ${p.survivorsAfterTeardown}`);
  if (report.delete) say(`   delete via ${report.delete.via}: returned ${report.delete.returnedMs === null ? 'NEVER (hung)' : `in ${report.delete.returnedMs} ms`}${report.delete.wake ? ` · wake fired at ${report.delete.wake.firedAtMs} ms (${report.delete.wake.result})` : ''} · zero processes after ${report.delete.elapsedMs === null ? `NEVER (${report.delete.boundMs} ms bound)` : `${report.delete.elapsedMs} ms`} · survivors ${report.delete.survivors.length} of ${report.delete.treeBefore.length}`);
  const shown = new Set(); // the same named tree under several broken verdicts is printed once
  for (const v of broke) {
    const key = (v.tree ?? []).join('\n');
    if (!key || shown.has(key)) continue;
    shown.add(key);
    say(`   process tree named by ${v.id}:`);
    for (const l of v.tree) say(`     ${l}`);
  }
  say(`   claude ${report.cli.version} · containment ${report.containment}${report.containmentOptOut ? ' (WEAK, explicit opt-out)' : ''} · fixture ${report.fixture.skills} skills / ${report.fixture.memoryFiles} rules / ${report.fixture.mcpServers}×${report.fixture.toolsPerServer} MCP tools · routes: ${report.paths.join(', ')}`);
}
// A run that needed the weak-containment opt-out never prints the plain PASS terminator: the release gate wants full containment.
const status = sessionBudgetTerminator({ voided: voided > 0, bad: bad > 0, partial: WANT !== 'all', strongContainment: containment.name === 'netns+pidns' });
say(`SESSION-BUDGET: ${status}`);
process.exit(status === 'VOID' ? 3 : status === 'FAIL' ? 1 : 0);
