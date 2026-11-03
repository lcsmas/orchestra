#!/usr/bin/env node
// Calibration rig for the #210 process + memory budgets:  node scripts/session-budget/measure-procs.mjs --runs 8 [--load 20] [--arm normal]
// Runs the REAL suite arm N times (fresh process, netns+pidns, fake API) and prints, per run and as min/median/max/sd, the
// census the judge reads: process count by kind and tree memory (RSS+swap) at the first reply and settled. `--load K` starts K
// busy-loop children first (each pinned to nothing: they compete with the run for every core) and kills them by handle after.
// The numbers in src/shared/session-budget.ts `processes` are THESE, plus the margin its comment states — re-run before moving one.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureBuilt, runSessionArm, detectContainment } from './harness.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const RUNS = Number(opt('runs', '8'));
const LOAD = Number(opt('load', '0'));
const ARM = opt('arm', 'normal');
const MUTANT = opt('mutant', null);
const mb = (kb) => Math.round(kb / 1024);

const hogs = [];
for (let i = 0; i < LOAD; i++) hogs.push(spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore' }));
const stopHogs = () => { for (const h of hogs) h.kill('SIGKILL'); };
process.on('exit', stopHogs);

if (process.env.SESSION_BUDGET_SKIP_BUILD !== '1') ensureBuilt(REPO);
const containment = detectContainment();
const rows = [];
for (let i = 0; i < RUNS; i++) {
  const res = await runSessionArm({ repo: REPO, arm: ARM, mutant: MUTANT, containment });
  if (res.void || res.error || !res.report || res.report.error) { console.log(`run ${i + 1}: BROKE — ${res.error ?? res.report?.error}`); continue; }
  const p = res.report.processes;
  const per = (c, kind) => (c.procs ?? []).filter((x) => x.kind === kind).map((x) => mb(x.rssKB + x.swapKB));
  rows.push({
    first: { total: p.atFirstReply.total, byKind: p.atFirstReply.byKind, mb: mb(p.atFirstReply.rssKB + (p.atFirstReply.swapKB ?? 0)), zombies: p.atFirstReply.zombies },
    end: { total: p.atEnd.total, byKind: p.atEnd.byKind, mb: mb(p.atEnd.rssKB + (p.atEnd.swapKB ?? 0)), zombies: p.atEnd.zombies,
      keeperMB: per(p.atEnd, 'keeper'), cliMB: per(p.atEnd, 'cli'), mcpMB: per(p.atEnd, 'mcp'), otherCmd: (p.atEnd.procs ?? []).filter((x) => x.kind === 'other').map((x) => x.cmd.slice(0, 80)) },
    firstOther: (p.atFirstReply.procs ?? []).filter((x) => x.kind === 'other').map((x) => x.cmd.slice(0, 80)),
    ttfr: res.report.timing.timeToFirstReplyMs, span: res.report.timing.startupEgressSpanMs, survivors: p.survivorsAfterTeardown,
    verdict: res.judgement.void ? 'VOID' : res.judgement.ok ? 'ok' : `BROKE ${res.judgement.verdicts.filter((v) => v.kind === 'budget' && !v.ok).map((v) => v.id.replace('session.', '')).join(',')}`,
  });
  const r = rows[rows.length - 1];
  console.log(`run ${i + 1}/${RUNS}${LOAD ? ` load=${LOAD}` : ''}: first ${r.first.total} procs (${JSON.stringify(r.first.byKind)}) ${r.first.mb} MB | end ${r.end.total} procs ${r.end.mb} MB (keeper ${r.end.keeperMB} cli ${r.end.cliMB} mcp ${r.end.mcpMB}) zombies ${r.first.zombies}/${r.end.zombies} | ttfr ${r.ttfr} ms span ${r.span} survivors ${r.survivors} | ${r.verdict}${r.firstOther.length || r.end.otherCmd.length ? ` other=${JSON.stringify([...r.firstOther, ...r.end.otherCmd])}` : ''}`);
}
stopHogs();
const stat = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length);
  return `min ${s[0]} med ${s[Math.floor(s.length / 2)]} max ${s[s.length - 1]} sd ${sd.toFixed(1)}`;
};
if (rows.length) {
  console.log(`\nN=${rows.length} arm=${ARM}${MUTANT ? ` mutant=${MUTANT}` : ''} load=${LOAD} busy-loops`);
  console.log(`processes @first reply : ${stat(rows.map((r) => r.first.total))}`);
  console.log(`processes @settled     : ${stat(rows.map((r) => r.end.total))}`);
  console.log(`tree MB       @first reply: ${stat(rows.map((r) => r.first.mb))}`);
  console.log(`tree MB       @settled    : ${stat(rows.map((r) => r.end.mb))}`);
  console.log(`keeper MB @settled: ${stat(rows.flatMap((r) => r.end.keeperMB))} | cli MB: ${stat(rows.flatMap((r) => r.end.cliMB))} | mcp MB (each): ${stat(rows.flatMap((r) => r.end.mcpMB))}`);
  console.log(`time to first reply ms: ${stat(rows.map((r) => r.ttfr))}`);
}
