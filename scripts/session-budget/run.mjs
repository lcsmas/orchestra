#!/usr/bin/env node
// Session-budget suite driver (#208):  node scripts/session-budget/run.mjs [--arm <name>|all] [--json]
//
// Arms (the table and the rules that judge them live in arms.mjs, unit-pinned). Session arms are each a fresh process: REAL agent-sdk.ts
// session path → real keeper → real `claude` CLI, in a generated heavy fixture, against the LOCAL FAKE Anthropic API — zero tokens, D6 —
// inside net+pid namespaces PROVEN routeless by an in-run canary, with PRODUCTION env (none of the CLI's traffic-disabling knobs):
//   normal / slow-startup    shipped code; MUST PASS every budget in src/shared/session-budget.ts (slow-startup: a slow MCP server, retried call).
//   boot-context-read        the #176 boot-time getContextUsage() re-added at load time; MUST FAIL naming countTokensRequests, burst ≥ 50.
//   traffic-knob-in-env      a buildSdkEnv edit hands the CLI DISABLE_TELEMETRY; MUST be VOID naming instrument.productionEnv.
//   app-egress-new-host      an ensureSession edit fetch()es ONE new host; MUST FAIL naming it in startupEgressAttempts (exactly 1).
//   containment-canary       the harness LIES about its containment; MUST be VOID (containmentProven) AND aborted before anything boots.
// Self-test arms (host-dependent checks of the instruments themselves, kept out of `pnpm run test`):
//   census-selftest          the pid-namespace census is exactly the runner's tree.
//   smoke-flag-path          the optional real-API smoke's flag path, real CLI vs the fake API.
// Exit: 0 all arms as expected · 1 an arm broke expectation or the run raised · 3 an arm was VOID (nothing measured:
// the subject never mounted, or egress could not be contained).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBuilt, runSessionArm, runSelfTest, detectContainment } from './harness.mjs';
import { ARMS, evaluateArm } from './arms.mjs';
import fs from 'node:fs';
import { formatRequestSummary, sessionBudgetTerminator } from '../../src/shared/session-budget.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const JSON_OUT = args.includes('--json');
const WANT = opt('arm', 'all');

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
  const strong = containment.name === 'netns+pidns';
  if ((spec.kind === 'selftest' || spec.lieAboutContainment) && !strong && process.env.SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT === '1') {
    // Explicit weak-containment opt-out: these instrument checks need net+pid namespaces, so they are SKIPPED — loudly, never counted as a pass.
    console.log(JSON_OUT ? JSON.stringify({ arm: name, skipped: true }) : `== arm ${name}: SKIPPED — needs net+pid namespaces (weak containment explicitly allowed; the instrument is unchecked on this host)`);
    continue;
  }
  const res = spec.kind === 'selftest'
    ? await runSelfTest({ repo: REPO, mode: spec.mode, containment })
    : await runSessionArm({ repo: REPO, arm: name, mutant: spec.mutant, profile: spec.profile, containment: spec.lieAboutContainment ? { name: 'netns+pidns', prefix: containment.prefix.filter((a) => a !== '--unshare-net') } : containment });
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
  const ev = evaluateArm(spec, res);
  const { asExpected, why } = ev;
  if (ev.voided) voided++;
  if (ev.bad) bad++;
  if (JSON_OUT) { console.log(JSON.stringify({ arm: name, expect: spec.expect, asExpected, why, report, judgement })); continue; }
  say(`== arm ${name} (expect ${spec.expect.toUpperCase()}): ${asExpected ? 'AS EXPECTED' : 'UNEXPECTED'} — ${why}`);
  if (res.aborted) { say(`   run ABORTED before anything booted: ${res.aborted} unproven (${report.containmentProof ? JSON.stringify(report.containmentProof).slice(0, 200) : 'no proof'})`); continue; }
  const p = report.processes;
  for (const l of formatRequestSummary(report)) say(`   ${l}`);
  const side = report.requestLog?.filter((r) => r.type === 'model' && !(r.tools > 0)) ?? [];
  for (const r of side) say(`   side call @${r.tMs} ms: ${r.model} (tools-less) — "${r.preview ?? ''}"`);
  say(`   time to first reply: ${report.timing.timeToFirstReplyMs} ms after sdkSend (incl. ${report.timing.fakeModelLatencyMs} ms fake model latency; runner setup ${report.timing.setupMs} ms not counted)`);
  say(`   child processes at first reply: ${p.atFirstReply.total} (cli=${p.atFirstReply.byKind.cli} keeper=${p.atFirstReply.byKind.keeper} mcp=${p.atFirstReply.byKind.mcp} hook=${p.atFirstReply.byKind.hook} other=${p.atFirstReply.byKind.other}) · rss ${Math.round(p.atFirstReply.rssKB / 1024)} MB · after teardown: ${p.survivorsAfterTeardown}`);
  say(`   claude ${report.cli.version} · containment ${report.containment}${report.containmentOptOut ? ' (WEAK, explicit opt-out)' : ''} · fixture ${report.fixture.skills} skills / ${report.fixture.memoryFiles} rules / ${report.fixture.mcpServers}×${report.fixture.toolsPerServer} MCP tools · routes: ${report.paths.join(', ')}`);
}
// A run that needed the weak-containment opt-out never prints the plain PASS terminator: the release gate wants full containment.
const status = sessionBudgetTerminator({ voided: voided > 0, bad: bad > 0, partial: WANT !== 'all', strongContainment: containment.name === 'netns+pidns' });
say(`SESSION-BUDGET: ${status}`);
process.exit(status === 'VOID' ? 3 : status === 'FAIL' ? 1 : 0);
