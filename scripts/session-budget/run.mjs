#!/usr/bin/env node
// Session-budget suite driver (#208):  node scripts/session-budget/run.mjs [--arm <name>|all] [--json]
//
// Arms (each = a fresh process: REAL agent-sdk.ts session path → real keeper → real `claude` CLI, in a
// generated heavy fixture, against the LOCAL FAKE Anthropic API — zero tokens, D6):
//   normal             shipped code; MUST PASS every budget in src/shared/session-budget.ts.
//   boot-context-read  the shipped code with the #176 boot-time getContextUsage() re-added at load time
//                      (mutants.mjs); MUST FAIL naming session.beforeFirstReply.countTokensRequests with a
//                      large burst — the proof the suite can see the defect it exists for.
// Exit: 0 all arms as expected · 1 an arm broke expectation · 3 an arm was VOID (the subject never mounted).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBuilt, runSessionArm, detectContainment } from './harness.mjs';
import { formatRequestSummary } from '../../src/shared/session-budget.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const JSON_OUT = args.includes('--json');
const WANT = opt('arm', 'all');

/** `minBurst` is a LITERAL (the fixture carries 50 rules): a must-FAIL that broke on 1 count_tokens would not prove "large". */
const ARMS = {
  normal: { mutant: null, expect: 'pass' },
  'boot-context-read': { mutant: 'boot-context-read', expect: 'fail', mustBreak: 'session.beforeFirstReply.countTokensRequests', minBurst: 50 },
};
if (WANT !== 'all' && !ARMS[WANT]) { console.error(`unknown arm: ${WANT} (have: ${Object.keys(ARMS).join(', ')})`); process.exit(2); }

const say = (s = '') => { if (!JSON_OUT) console.log(s); };
const build = ensureBuilt(REPO);
const containment = detectContainment();
say(`session-budget: keeper bundle rebuilt (${new Date(build.mtimeMs).toISOString()}) · containment=${containment.name}`);

let bad = 0, voided = 0;
for (const [name, spec] of Object.entries(ARMS)) {
  if (WANT !== 'all' && WANT !== name) continue;
  const res = await runSessionArm({ repo: REPO, arm: name, mutant: spec.mutant, containment });
  if (res.error || !res.report) {
    bad++; console.log(JSON_OUT ? JSON.stringify({ arm: name, ok: false, error: res.error }) : `== arm ${name}: RUN BROKE — ${res.error}\n   scratch kept at ${res.root}`);
    continue;
  }
  const { report, judgement } = res;
  const broke = judgement.verdicts.filter((v) => v.kind === 'budget' && !v.ok);
  let asExpected;
  let why = '';
  if (judgement.void) { asExpected = false; why = `VOID — ${judgement.verdicts.filter((v) => v.kind === 'instrument' && !v.ok).map((v) => v.message).join(' | ')}`; voided++; }
  else if (spec.expect === 'pass') { asExpected = judgement.ok; why = judgement.ok ? 'every budget held' : broke.map((v) => v.message).join(' | '); }
  else {
    const named = broke.find((v) => v.id === spec.mustBreak);
    asExpected = !!named && (named.actual ?? 0) >= spec.minBurst;
    why = named ? named.message : `expected ${spec.mustBreak} to break but it held`;
    if (named && !asExpected) why += ` — burst below ${spec.minBurst}, not the large #176 shape`;
  }
  if (!asExpected && !judgement.void) bad++;
  if (JSON_OUT) { console.log(JSON.stringify({ arm: name, expect: spec.expect, asExpected, why, report, judgement })); continue; }
  const p = report.processes;
  say(`== arm ${name} (expect ${spec.expect.toUpperCase()}): ${asExpected ? 'AS EXPECTED' : 'UNEXPECTED'} — ${why}`);
  for (const l of formatRequestSummary(report)) say(`   ${l}`);
  say(`   time to first reply: ${report.timing.timeToFirstReplyMs} ms (incl. ${report.timing.fakeModelLatencyMs} ms fake model latency)`);
  say(`   child processes at first reply: ${p.atFirstReply.total} (cli=${p.atFirstReply.byKind.cli} keeper=${p.atFirstReply.byKind.keeper} mcp=${p.atFirstReply.byKind.mcp} hook=${p.atFirstReply.byKind.hook} other=${p.atFirstReply.byKind.other}) · rss ${Math.round(p.atFirstReply.rssKB / 1024)} MB · after teardown: ${p.survivorsAfterTeardown}`);
  say(`   claude ${report.cli.version} · fixture ${report.fixture.skills} skills / ${report.fixture.memoryFiles} rules / ${report.fixture.mcpServers}×${report.fixture.toolsPerServer} MCP tools · egress: ${report.egress.length ? report.egress.join(',') : 'none'} · routes: ${report.paths.join(', ')}`);
}
const status = voided ? 'VOID' : bad ? 'FAIL' : 'PASS';
say(`SESSION-BUDGET: ${status}`);
process.exit(voided ? 3 : bad ? 1 : 0);
